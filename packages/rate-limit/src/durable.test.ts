import { randomUUID } from "node:crypto";

import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import {
  ConcurrencyError,
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type EntityKey,
  type Store,
  type UpdateDecider,
  type UpdateOptions,
} from "@pegma/storage-core";
import { describe, expect, it, vi } from "vitest";

import { TABLE_PORT } from "../../../test/azurite.js";
import { createDurableLimiter } from "./durable.js";

const CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;" +
  "AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  `TableEndpoint=http://127.0.0.1:${TABLE_PORT}/devstoreaccount1;`;

const policy = {
  name: "login",
  limit: 3,
  windowMs: 60_000,
} as const;
const start = "2026-01-01T00:00:00.000Z";

function createAzuriteStore(): Store {
  const table = `ratelimit${randomUUID().replaceAll("-", "")}`;
  const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
    allowInsecureConnection: true,
  });
  return createAzureTablesStore({ client });
}

function stores(): Array<[string, () => Store]> {
  return [
    ["memory store", createMemoryStore],
    ["Azurite", createAzuriteStore],
  ];
}

describe.each(stores())("createDurableLimiter over %s", (_name, makeStore) => {
  it("allows through the limit and makes later refusals read-only", async () => {
    let writes = 0;
    const inner = makeStore();
    const tracking: Store = {
      collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
        const collection = inner.collection(definition);
        return {
          ...collection,
          async update(key, decide: UpdateDecider<T>, options) {
            return collection.update(
              key,
              async (current) => {
                const decision = await decide(current);
                if (decision.action === "write") {
                  writes += 1;
                }
                return decision;
              },
              options,
            );
          },
        };
      },
    };
    const limiter = createDurableLimiter(policy, tracking);

    await expect(limiter.allow("alice", start)).resolves.toEqual({
      allowed: true,
    });
    await expect(limiter.allow("alice", start)).resolves.toEqual({
      allowed: true,
    });
    await expect(limiter.allow("alice", start)).resolves.toEqual({
      allowed: true,
    });
    expect(writes).toBe(3);
    await expect(limiter.allow("alice", start)).resolves.toEqual({
      allowed: false,
      retryAfter: 60_000,
    });
    expect(writes).toBe(3);
  });

  it("keeps policies and opaque keys independent", async () => {
    const store = makeStore();
    const first = createDurableLimiter(
      { name: "sender/address", limit: 1, windowMs: 60_000 },
      store,
    );
    const second = createDurableLimiter(
      { name: "sender/domain", limit: 1, windowMs: 60_000 },
      store,
    );

    await expect(first.allow("a/b?#", start)).resolves.toEqual({
      allowed: true,
    });
    await expect(second.allow("a/b?#", start)).resolves.toEqual({
      allowed: true,
    });
  });

  it("hashes long opaque policy names and keys into backend-safe identifiers", async () => {
    const limiter = createDurableLimiter(
      {
        name: `long-policy-${"p".repeat(2_000)}`,
        limit: 1,
        windowMs: 60_000,
      },
      makeStore(),
    );

    await expect(
      limiter.allow(`long-key-${"k".repeat(2_000)}`, start),
    ).resolves.toEqual({
      allowed: true,
    });
  });

  it("sweeps stale windows with version-conditional deletes", async () => {
    const limiter = createDurableLimiter(policy, makeStore());
    await limiter.allow("old", start);
    await limiter.allow("live", "2026-01-01T00:02:00.000Z");

    await expect(limiter.sweep("2026-01-01T00:02:30.000Z")).resolves.toEqual({
      scanned: 2,
      deleted: 1,
    });
    await expect(
      limiter.allow("live", "2026-01-01T00:02:30.000Z"),
    ).resolves.toEqual({ allowed: true });
  });
});

describe("durable failure and contention behavior", () => {
  it("starts hashing lazily and handles digest rejection before it can become unhandled", async () => {
    let digestCalls = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("crypto", {
      subtle: {
        async digest() {
          digestCalls += 1;
          throw new Error("digest unavailable");
        },
      },
    });

    try {
      const limiter = createDurableLimiter(policy, createMemoryStore());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(digestCalls).toBe(0);
      expect(unhandled).toEqual([]);

      await expect(limiter.allow("alice", start)).resolves.toEqual({
        allowed: false,
        retryAfter: 60_000,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(digestCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stores only bounded domain-separated hashes, never raw policy names or keys", async () => {
    let stored: unknown;
    const store: Store = {
      collection<T>(): CollectionStore<T> {
        return {
          async update(_key: EntityKey, decide: UpdateDecider<T>) {
            const decision = await decide(null);
            if (decision.action !== "write") {
              throw new Error("expected a counter write");
            }
            stored = decision.value;
            return { written: true, value: decision.value, attempts: 1 };
          },
        } as unknown as CollectionStore<T>;
      },
    };
    const rawPolicy = `private-policy-${"p".repeat(2_000)}`;
    const rawKey = `person@example.test-${"k".repeat(2_000)}`;
    const limiter = createDurableLimiter(
      { name: rawPolicy, limit: 1, windowMs: 60_000 },
      store,
    );

    await expect(limiter.allow(rawKey, start)).resolves.toEqual({
      allowed: true,
    });
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(rawPolicy);
    expect(serialized).not.toContain(rawKey);
    expect(serialized.length).toBeLessThan(400);
    expect(stored).toMatchObject({
      policyHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      subjectHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      partition: expect.stringMatching(/^policy-[0-9a-f]{64}$/u),
      id: expect.stringMatching(/^\d{13}-[0-9a-f]{64}$/u),
      count: 1,
    });
    expect(stored).not.toHaveProperty("policyName");
    expect(stored).not.toHaveProperty("subjectKey");
  });

  it("scopes a subject hash to its policy", async () => {
    const stored: Array<Record<string, unknown>> = [];
    const store: Store = {
      collection<T>(): CollectionStore<T> {
        return {
          async update(_key: EntityKey, decide: UpdateDecider<T>) {
            const decision = await decide(null);
            if (decision.action !== "write") {
              throw new Error("expected a counter write");
            }
            stored.push(decision.value as Record<string, unknown>);
            return { written: true, value: decision.value, attempts: 1 };
          },
        } as unknown as CollectionStore<T>;
      },
    };

    await createDurableLimiter(
      { name: "policy-one", limit: 1, windowMs: 60_000 },
      store,
    ).allow("same-subject", start);
    await createDurableLimiter(
      { name: "policy-two", limit: 1, windowMs: 60_000 },
      store,
    ).allow("same-subject", start);

    expect(stored).toHaveLength(2);
    expect(stored[0]?.subjectHash).not.toBe(stored[1]?.subjectHash);
  });

  it("holds the configured boundary under real concurrent Azurite writes", async () => {
    const limit = 12;
    const limiter = createDurableLimiter(
      { name: "concurrent-login", limit, windowMs: 60_000 },
      createAzuriteStore(),
      { maxAttempts: 25 },
    );

    const decisions = await Promise.all(
      Array.from({ length: 40 }, () => limiter.allow("one-hot-key", start)),
    );

    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(limit);
    expect(decisions.filter(({ allowed }) => !allowed)).toHaveLength(
      40 - limit,
    );
  });

  it("fails closed after the requested bounded retry count", async () => {
    let observedMaxAttempts: number | undefined;
    let attempts = 0;
    const store: Store = {
      collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
        return {
          async update(
            key: EntityKey,
            _decide: UpdateDecider<T>,
            options?: UpdateOptions,
          ) {
            observedMaxAttempts = options?.maxAttempts;
            for (
              let attempt = 0;
              attempt < (options?.maxAttempts ?? 3);
              attempt += 1
            ) {
              attempts += 1;
              await _decide(null);
            }
            throw new ConcurrencyError(
              definition.name,
              key,
              options?.maxAttempts ?? 3,
            );
          },
        } as unknown as CollectionStore<T>;
      },
    };
    const limiter = createDurableLimiter(policy, store, { maxAttempts: 2 });

    await expect(limiter.allow("alice", start)).resolves.toEqual({
      allowed: false,
      retryAfter: 60_000,
    });
    expect(observedMaxAttempts).toBe(2);
    expect(attempts).toBe(2);
  });

  it("fails closed on storage outage", async () => {
    const store: Store = {
      collection<T>(): CollectionStore<T> {
        return {
          async update() {
            throw new Error("storage unavailable");
          },
        } as unknown as CollectionStore<T>;
      },
    };

    await expect(
      createDurableLimiter(policy, store).allow("alice", start),
    ).resolves.toEqual({ allowed: false, retryAfter: 60_000 });
  });

  it("fails closed before storage access when its clock throws", async () => {
    let updateCalled = false;
    const store: Store = {
      collection<T>(): CollectionStore<T> {
        return {
          async update() {
            updateCalled = true;
            throw new Error("should not be reached");
          },
        } as unknown as CollectionStore<T>;
      },
    };
    const limiter = createDurableLimiter(policy, store, {
      clock: {
        now: () => {
          throw new Error("clock unavailable");
        },
      },
    });

    await expect(limiter.allow("alice")).resolves.toEqual({
      allowed: false,
      retryAfter: 60_000,
    });
    expect(updateCalled).toBe(false);
  });

  it("fails closed before storage access for a parseable noncanonical timestamp", async () => {
    let updateCalled = false;
    const store: Store = {
      collection<T>(): CollectionStore<T> {
        return {
          async update() {
            updateCalled = true;
            throw new Error("should not be reached");
          },
        } as unknown as CollectionStore<T>;
      },
    };

    await expect(
      createDurableLimiter(policy, store).allow("alice", "01/02/2026"),
    ).resolves.toEqual({
      allowed: false,
      retryAfter: 60_000,
    });
    expect(updateCalled).toBe(false);
  });

  it("fails closed without rewriting a malformed current record", async () => {
    let decisionAction: string | undefined;
    const store: Store = {
      collection<T>(): CollectionStore<T> {
        return {
          async update(_key: EntityKey, decide: UpdateDecider<T>) {
            const malformed = {
              partition: "wrong",
              id: "wrong",
              policyHash: "bad-policy-hash",
              subjectHash: "bad-subject-hash",
              windowStartMs: "bad",
              count: -1,
            } as T;
            const decision = await decide(malformed);
            decisionAction = decision.action;
            return {
              written: false,
              value: malformed,
              attempts: 1,
            };
          },
        } as CollectionStore<T>;
      },
    };

    await expect(
      createDurableLimiter(policy, store).allow("alice", start),
    ).resolves.toEqual({ allowed: false, retryAfter: 60_000 });
    expect(decisionAction).toBe("keep");
  });

  it("does not sweep a stale record that changed after listing", async () => {
    const inner = createMemoryStore();
    const racingStore: Store = {
      collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
        const collection = inner.collection(definition);
        return {
          ...collection,
          async listVersioned(partition) {
            const listed = await collection.listVersioned(partition);
            const first = listed[0];
            if (first !== undefined) {
              await collection.update(
                definition.key(first.value),
                (current) => {
                  const record = current as Record<string, unknown> | null;
                  return {
                    action: "write",
                    value: {
                      ...record,
                      count: Number(record?.count) + 1,
                    } as T,
                  };
                },
              );
            }
            return listed;
          },
        };
      },
    };
    const limiter = createDurableLimiter(policy, racingStore);
    await limiter.allow("changed", start);

    await expect(limiter.sweep("2026-01-01T00:02:00.000Z")).resolves.toEqual({
      scanned: 1,
      deleted: 0,
    });
  });

  it("retains identity-malformed records rather than reconstructing an unsafe delete key", async () => {
    let conditionalDelete:
      | {
          readonly partition: string;
          readonly id: string;
          readonly version: string;
        }
      | undefined;
    const store: Store = {
      collection<T>(): CollectionStore<T> {
        return {
          async listVersioned() {
            return [
              {
                value: {
                  partition: "policy-malformed",
                  id: "bad-row",
                  policyHash: null,
                  subjectHash: null,
                  windowStartMs: "not-a-number",
                  count: -1,
                } as T,
                version: "version-1",
              },
            ];
          },
          async deleteIfUnchanged(key: EntityKey, version: string) {
            conditionalDelete = { ...key, version };
            return true;
          },
        } as unknown as CollectionStore<T>;
      },
    };

    await expect(
      createDurableLimiter(policy, store).sweep("2026-01-01T00:02:00.000Z"),
    ).resolves.toEqual({ scanned: 1, deleted: 0 });
    expect(conditionalDelete).toBeUndefined();
  });

  it("retains count-malformed records rather than pairing their version with a victim key", async () => {
    let conditionalDeleteCalled = false;
    const store: Store = {
      collection<T>(): CollectionStore<T> {
        let stored: T | undefined;
        return {
          async update(_key: EntityKey, decide: UpdateDecider<T>) {
            const decision = await decide(null);
            if (decision.action !== "write") {
              throw new Error("expected the initial counter write");
            }
            stored = decision.value;
            return { written: true, value: stored, attempts: 1 };
          },
          async listVersioned() {
            if (stored === undefined) {
              return [];
            }
            return [
              {
                value: {
                  ...(stored as Record<string, unknown>),
                  count: 0,
                } as T,
                version: "version-shared-by-another-key",
              },
            ];
          },
          async deleteIfUnchanged() {
            conditionalDeleteCalled = true;
            return true;
          },
        } as unknown as CollectionStore<T>;
      },
    };
    const limiter = createDurableLimiter(policy, store);
    await limiter.allow("victim", start);

    await expect(limiter.sweep("2026-01-01T00:02:00.000Z")).resolves.toEqual({
      scanned: 1,
      deleted: 0,
    });
    expect(conditionalDeleteCalled).toBe(false);
  });
});
