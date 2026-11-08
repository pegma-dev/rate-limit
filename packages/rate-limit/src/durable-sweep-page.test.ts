import { randomUUID } from "node:crypto";
import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import {
  createMemoryStore,
  defineCollection,
  type CollectionDefinition,
  type CollectionStore,
  type EntityKey,
  type ScanRecord,
  type Store,
  type StoredRecord,
  type StoredValue,
} from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import { TABLE_PORT } from "../../../test/azurite.js";
import { createDurableLimiter, sweepDurableWindowsPage } from "./durable.js";

const connection =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  `TableEndpoint=http://127.0.0.1:${TABLE_PORT}/devstoreaccount1;`;
const start = "2026-01-01T00:00:00.000Z";
const expired = "2026-01-01T00:02:00.000Z";
const clock = { now: () => expired };

function azurite(): Store {
  const client = TableClient.fromConnectionString(
    connection,
    `rlpage${randomUUID().replaceAll("-", "")}`,
    { allowInsecureConnection: true },
  );
  return createAzureTablesStore({ client });
}
const stores: Array<[string, () => Store]> = [
  ["memory", createMemoryStore],
  ["Azurite", azurite],
];

function raw(
  store: Store,
  physicalKey?: EntityKey,
): CollectionStore<StoredRecord> {
  return store.collection(
    defineCollection<StoredRecord>({
      name: "rate-limit-windows",
      key: (value) =>
        physicalKey ?? {
          partition: String(value.partition),
          id: String(value.id),
        },
      codec: {
        encode: (value) => ({ ...value }),
        decode: (value) => ({ ...value }),
      },
    }),
  );
}
async function rows(store: Store): Promise<ScanRecord<StoredRecord>[]> {
  const result: ScanRecord<StoredRecord>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const current = await raw(store).scan({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    result.push(...current.records);
    if (current.nextCursor === null) return result;
    cursor = current.nextCursor;
  }
  throw new Error("Fixture scan exceeded its finite bound.");
}
async function seed(
  store: Store,
  name: string,
  keys: readonly string[] = ["old"],
  at = start,
) {
  const limiter = createDurableLimiter(
    { name, limit: 3, windowMs: 60_000 },
    store,
  );
  for (const key of keys)
    expect(await limiter.allow(key, at)).toEqual({ allowed: true });
  return limiter;
}
function field(value: StoredRecord, name: string): number {
  const result = value[name];
  if (typeof result !== "number")
    throw new Error("Expected a numeric window field.");
  return result;
}
interface Hooks {
  readonly oversized?: boolean;
  readonly fail?: "scan" | "descriptor" | "delete";
  readonly corruptScanRow?: (row: ScanRecord<unknown>) => unknown;
  readonly descriptorValue?: () => unknown;
  readonly beforeDelete?: (key: EntityKey) => Promise<void>;
  readonly afterDelete?: () => Promise<void>;
}
function observed(inner: Store, hooks: Hooks = {}) {
  const scans: number[] = [];
  let gets = 0;
  let deletes = 0;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const collection = inner.collection(definition);
      return {
        ...collection,
        async scan(options) {
          scans.push(options.limit);
          if (hooks.fail === "scan") throw new Error("scan unavailable");
          const page = await collection.scan(
            hooks.oversized
              ? { ...options, limit: options.limit + 1 }
              : options,
          );
          const corrupt = hooks.corruptScanRow;
          if (corrupt === undefined) return page;
          return {
            ...page,
            // Violate only the returned adapter contract, after reading real
            // rows. The last row pins validation before any earlier candidate.
            records: page.records.map((row, index) =>
              index === page.records.length - 1
                ? (corrupt(row) as ScanRecord<T>)
                : row,
            ),
          };
        },
        async getVersioned(key) {
          gets += 1;
          if (hooks.fail === "descriptor")
            throw new Error("descriptor unavailable");
          const descriptor = await collection.getVersioned(key);
          if (descriptor === null || hooks.descriptorValue === undefined)
            return descriptor;
          // The physical descriptor and version are real; only its response
          // value is deliberately outside the adapter's declared contract.
          return { ...descriptor, value: hooks.descriptorValue() as T };
        },
        async deleteIfUnchanged(key, version) {
          deletes += 1;
          if (hooks.fail === "delete") throw new Error("delete unavailable");
          await hooks.beforeDelete?.(key);
          const deleted = await collection.deleteIfUnchanged(key, version);
          await hooks.afterDelete?.();
          return deleted;
        },
        async list() {
          throw new Error("Unbounded list is forbidden in paged cleanup.");
        },
        async listVersioned() {
          throw new Error(
            "Unbounded listVersioned is forbidden in paged cleanup.",
          );
        },
      };
    },
  };
  return { store, scans, gets: () => gets, deletes: () => deletes };
}

describe.each(stores)(
  "global bounded durable cleanup over %s",
  (_name, makeStore) => {
    it("counts every physical row and follows no-match pages across policies and legacy rows", async () => {
      const backing = makeStore();
      await seed(backing, "old-one");
      await seed(backing, "unrelated-old-policy");
      await seed(
        backing,
        "live-policy",
        ["future"],
        "2026-01-01T00:10:00.000Z",
      );
      await raw(backing).put({
        partition: "unrelated",
        id: "legacy",
        policyHash: "legacy",
        subjectHash: "legacy",
        windowStartMs: 0,
        count: 1,
      });
      await raw(backing).put({
        partition: "unrelated",
        id: "malformed",
        kind: "window",
        count: -1,
      });
      await raw(backing).put({
        partition: "unrelated",
        id: "unknown",
        kind: "future-record",
      });
      const before = await rows(backing);
      const track = observed(backing);
      let cursor: string | undefined;
      let scanned = 0;
      let deleted = 0;
      let noMatchContinuation = false;
      let completed = false;
      for (let page = 0; page < 100; page += 1) {
        const prior = {
          scans: track.scans.length,
          gets: track.gets(),
          deletes: track.deletes(),
        };
        const result = await sweepDurableWindowsPage(track.store, {
          limit: 1,
          clock,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(track.scans.slice(prior.scans)).toEqual([1]);
        expect(track.gets() - prior.gets).toBeLessThanOrEqual(1);
        expect(track.deletes() - prior.deletes).toBeLessThanOrEqual(1);
        expect(result.scanned).toBeLessThanOrEqual(1);
        scanned += result.scanned;
        deleted += result.deleted;
        if (result.deleted === 0 && result.nextCursor !== null)
          noMatchContinuation = true;
        if (result.nextCursor === null) {
          completed = true;
          break;
        }
        cursor = result.nextCursor;
      }
      expect(completed).toBe(true);
      expect(noMatchContinuation).toBe(true);
      expect(scanned).toBe(before.length);
      expect(deleted).toBe(2);
      expect((await rows(backing)).length).toBe(before.length - 2);
      expect(track.scans.every((limit) => limit === 1)).toBe(true);
      expect(track.gets()).toBeLessThanOrEqual(scanned);
      expect(track.deletes()).toBe(2);
      expect(
        (await rows(backing)).filter((row) => row.value.kind === "policy"),
      ).toHaveLength(3);
    });

    it("rejects physical over-return before descriptor reads or deletes", async () => {
      const backing = makeStore();
      await seed(backing, "physical-budget");
      const track = observed(backing, { oversized: true });
      await expect(
        sweepDurableWindowsPage(track.store, { limit: 1, clock }),
      ).rejects.toThrow("bounded scan page");
      expect(track.scans).toEqual([1]);
      expect(track.gets()).toBe(0);
      expect(track.deletes()).toBe(0);
      expect(await rows(backing)).toHaveLength(2);
    });

    const invalidRows: ReadonlyArray<
      readonly [string, (row: ScanRecord<unknown>) => unknown]
    > = [
      ["null row", () => null],
      ["null key", (row) => ({ ...row, key: null })],
      [
        "nonstring partition",
        (row) => ({ ...row, key: { ...row.key, partition: 0 } }),
      ],
      ["nonstring id", (row) => ({ ...row, key: { ...row.key, id: 0 } })],
      ["empty version", (row) => ({ ...row, version: "" })],
      ["null value", (row) => ({ ...row, value: null })],
      ["array value", (row) => ({ ...row, value: [] })],
      ["primitive value", (row) => ({ ...row, value: 0 })],
    ];
    it.each(invalidRows)(
      "rejects a final %s envelope before any descriptor read or delete",
      async (_label, corruptScanRow) => {
        const backing = makeStore();
        await seed(backing, "invalid-row-envelope");
        const before = await rows(backing);
        const track = observed(backing, { corruptScanRow });
        await expect(
          sweepDurableWindowsPage(track.store, { limit: 100, clock }),
        ).rejects.toThrow("scan row envelope");
        expect(track.scans).toEqual([100]);
        expect(track.gets()).toBe(0);
        expect(track.deletes()).toBe(0);
        expect(await rows(backing)).toEqual(before);
      },
    );

    it.each([null, [], 0].map((value) => ({ value })))(
      "rejects an invalid descriptor value %j without deleting its real expired candidate",
      async ({ value }) => {
        const backing = makeStore();
        await seed(backing, "invalid-descriptor-envelope");
        const before = await rows(backing);
        const track = observed(backing, { descriptorValue: () => value });
        await expect(
          sweepDurableWindowsPage(track.store, { limit: 100, clock }),
        ).rejects.toThrow("descriptor envelope");
        expect(track.scans).toEqual([100]);
        expect(track.gets()).toBe(1);
        expect(track.deletes()).toBe(0);
        expect(await rows(backing)).toEqual(before);
      },
    );

    it("retains malformed/new-format identities and never pairs a payload key with another row's version", async () => {
      const backing = makeStore();
      await seed(backing, "malformed-windows", [
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
      ]);
      const windows = (await rows(backing)).filter(
        (row) => row.value.kind === "window",
      );
      expect(windows).toHaveLength(8);
      for (const [index, row] of windows.entries()) {
        const value: Record<string, StoredValue> = { ...row.value };
        if (index === 0) value.count = 0;
        if (index === 1) value.count = field(value, "limit") + 1;
        if (index === 2) value.limit = field(value, "limit") + 1;
        if (index === 3) value.windowMs = field(value, "windowMs") * 2;
        if (index === 4) {
          // Fully valid payload at the wrong physical key must not even attempt
          // a conditional delete using the payload's reconstructed victim key.
          await raw(backing).delete(row.key);
          await raw(backing, {
            partition: row.key.partition,
            id: `${row.key.id}-miskey`,
          }).put(value);
          continue;
        }
        if (index === 5) {
          delete value.kind;
          delete value.limit;
          delete value.windowMs;
        }
        if (index === 6) value.kind = "unknown-future-kind";
        if (index === 7) {
          const offset = field(value, "windowStartMs") + 1;
          value.windowStartMs = offset;
          value.id = `${offset}-${String(value.subjectHash)}`;
          await raw(backing).delete(row.key);
          await raw(backing).put(value);
        } else await raw(backing, row.key).put(value);
      }
      const before = await rows(backing);
      const track = observed(backing);
      expect(
        await sweepDurableWindowsPage(track.store, { limit: 100, clock }),
      ).toEqual({ scanned: 9, deleted: 0, nextCursor: null });
      expect(await rows(backing)).toEqual(before);
      expect(track.deletes()).toBe(0);
      expect(track.gets()).toBeLessThanOrEqual(9);
    });

    it("requires the actual current policy descriptor for every expired window", async () => {
      const backing = makeStore();
      for (const name of ["missing", "malformed", "mismatched"])
        await seed(backing, name);
      const descriptors = (await rows(backing)).filter(
        (row) => row.value.kind === "policy",
      );
      for (const [index, descriptor] of descriptors.entries()) {
        if (index === 0) await raw(backing).delete(descriptor.key);
        else
          await raw(backing, descriptor.key).put({
            ...descriptor.value,
            ...(index === 1 ? { subjectHash: "unexpected" } : { limit: 99 }),
          });
      }
      const before = await rows(backing);
      const track = observed(backing);
      expect(
        await sweepDurableWindowsPage(track.store, { limit: 100, clock }),
      ).toEqual({ scanned: 5, deleted: 0, nextCursor: null });
      expect(await rows(backing)).toEqual(before);
      expect(track.gets()).toBe(3);
      expect(track.deletes()).toBe(0);
    });

    it("preserves default clock-skew grace and permits an explicit zero grace", async () => {
      const backing = makeStore();
      await seed(backing, "skew");
      expect(
        await sweepDurableWindowsPage(backing, {
          limit: 100,
          clock,
          maxClockSkewMs: Number.MAX_SAFE_INTEGER,
        }),
      ).toEqual({ scanned: 2, deleted: 0, nextCursor: null });
      expect(
        await sweepDurableWindowsPage(backing, {
          limit: 100,
          clock: { now: () => "2026-01-01T00:01:59.999Z" },
        }),
      ).toEqual({ scanned: 2, deleted: 0, nextCursor: null });
      expect(
        await sweepDurableWindowsPage(backing, { limit: 100, clock }),
      ).toEqual({ scanned: 2, deleted: 1, nextCursor: null });
      await seed(backing, "no-grace");
      expect(
        await sweepDurableWindowsPage(backing, {
          limit: 100,
          clock: { now: () => "2026-01-01T00:01:00.000Z" },
          maxClockSkewMs: 0,
        }),
      ).toEqual({ scanned: 3, deleted: 1, nextCursor: null });
    });

    it("does not delete a window after an actual concurrent allow increments its scanned version", async () => {
      const backing = makeStore();
      const limiter = await seed(backing, "raced", ["same"]);
      const track = observed(backing, {
        beforeDelete: async () => {
          expect(await limiter.allow("same", start)).toEqual({ allowed: true });
        },
      });
      expect(
        await sweepDurableWindowsPage(track.store, { limit: 100, clock }),
      ).toEqual({ scanned: 2, deleted: 0, nextCursor: null });
      expect(track.deletes()).toBe(1);
      expect(await limiter.allow("same", start)).toEqual({ allowed: true });
      expect((await limiter.allow("same", start)).allowed).toBe(false);
    });

    it("re-reads descriptor authority between candidates instead of caching a stale policy", async () => {
      const backing = makeStore();
      await seed(backing, "descriptor-race", ["first", "second"]);
      const descriptor = (await rows(backing)).find(
        (row) => row.value.kind === "policy",
      );
      if (descriptor === undefined)
        throw new Error("Expected a real policy descriptor.");
      let changed = false;
      const track = observed(backing, {
        afterDelete: async () => {
          if (!changed) {
            changed = true;
            await raw(backing, descriptor.key).put({
              ...descriptor.value,
              limit: 99,
            });
          }
        },
      });
      expect(
        await sweepDurableWindowsPage(track.store, { limit: 100, clock }),
      ).toEqual({ scanned: 3, deleted: 1, nextCursor: null });
      expect(track.gets()).toBe(2);
      expect(track.deletes()).toBe(1);
    });

    it.each(["scan", "descriptor", "delete"] as const)(
      "rejects %s failures without reporting a completed page",
      async (fail) => {
        const backing = makeStore();
        await seed(backing, "failed-page");
        const track = observed(backing, { fail });
        await expect(
          sweepDurableWindowsPage(track.store, { limit: 100, clock }),
        ).rejects.toThrow("unavailable");
        expect(await rows(backing)).toHaveLength(2);
      },
    );
  },
);

describe("bounded cleanup input failures", () => {
  const invalidCursors: readonly unknown[] = ["", null, 0, true, {}, []];
  it.each(invalidCursors.map((cursor) => ({ cursor })))(
    "rejects invalid cursor %j before any storage I/O",
    async ({ cursor }) => {
      const track = observed(createMemoryStore());
      await expect(
        sweepDurableWindowsPage(track.store, {
          limit: 1,
          clock,
          // JavaScript callers can bypass the declared string cursor type.
          cursor: cursor as string,
        }),
      ).rejects.toThrow("cursor");
      expect(track.scans).toEqual([]);
      expect(track.gets()).toBe(0);
      expect(track.deletes()).toBe(0);
    },
  );
  it.each([0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid physical limit %s before scanning",
    async (limit) => {
      const track = observed(createMemoryStore());
      await expect(
        sweepDurableWindowsPage(track.store, { limit, clock }),
      ).rejects.toThrow("limit");
      expect(track.scans).toEqual([]);
    },
  );
  it.each(["01/01/2026", "not-a-time"])(
    "rejects malformed/noncanonical time %s before scanning",
    async (at) => {
      const track = observed(createMemoryStore());
      await expect(
        sweepDurableWindowsPage(track.store, {
          limit: 1,
          clock: { now: () => at },
        }),
      ).rejects.toThrow("clock");
      expect(track.scans).toEqual([]);
    },
  );
  it("rejects a failed clock or invalid skew without claiming an empty completed page", async () => {
    const track = observed(createMemoryStore());
    await expect(
      sweepDurableWindowsPage(track.store, {
        limit: 1,
        clock: {
          now: () => {
            throw new Error("clock unavailable");
          },
        },
      }),
    ).rejects.toThrow("clock");
    await expect(
      sweepDurableWindowsPage(track.store, {
        limit: 1,
        clock,
        maxClockSkewMs: -1,
      }),
    ).rejects.toThrow("maxClockSkewMs");
    expect(track.scans).toEqual([]);
  });
});
