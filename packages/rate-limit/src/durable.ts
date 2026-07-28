import { systemClock } from "@pegma/spine";
import type { IsoTimestamp } from "@pegma/spine";
import {
  defineCollection,
  type Store,
  type StoredValue,
} from "@pegma/storage-core";

import {
  assertRateLimitKey,
  defineRateLimitPolicy,
  denyForWindow,
  retryAfter,
  timeInMilliseconds,
  type LimiterOptions,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitPolicy,
} from "./policy.js";

const COLLECTION_NAME = "rate-limit-windows";

interface StoredWindow {
  readonly partition: StoredValue;
  readonly id: StoredValue;
  readonly policyHash: StoredValue;
  readonly subjectHash: StoredValue;
  readonly windowStartMs: StoredValue;
  readonly count: StoredValue;
}

interface ValidWindow {
  readonly partition: string;
  readonly id: string;
  readonly policyHash: string;
  readonly subjectHash: string;
  readonly windowStartMs: number;
  readonly count: number;
}

type WindowIdentity = Omit<ValidWindow, "count">;

const windows = defineCollection<StoredWindow>({
  name: COLLECTION_NAME,
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (record) => ({
      partition: record.partition ?? null,
      id: record.id ?? null,
      policyHash: record.policyHash ?? null,
      subjectHash: record.subjectHash ?? null,
      windowStartMs: record.windowStartMs ?? null,
      count: record.count ?? null,
    }),
  },
});

export interface DurableLimiterOptions extends LimiterOptions {
  /** Total optimistic-concurrency attempts. Defaults to 3. */
  readonly maxAttempts?: number;
}

export interface SweepResult {
  readonly scanned: number;
  readonly deleted: number;
}

export interface DurableRateLimiter extends RateLimiter {
  /**
   * Deletes structurally valid expired records only if their versions are
   * unchanged. Malformed rows are retained because listings do not expose
   * their authoritative storage keys.
   */
  sweep(now?: IsoTimestamp): Promise<SweepResult>;
}

async function hashOpaque(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface PartitionIdentity {
  readonly partition: string;
  readonly policyHash: string;
}

async function partitionFor(
  policy: RateLimitPolicy,
): Promise<PartitionIdentity> {
  const policyHash = await hashOpaque(
    `pegma.rate-limit.policy.v1\u0000${policy.name}`,
  );
  return { partition: `policy-${policyHash}`, policyHash };
}

async function subjectHashFor(
  policyHash: string,
  key: string,
): Promise<string> {
  return hashOpaque(
    `pegma.rate-limit.subject.v1\u0000${policyHash}\u0000${key}`,
  );
}

function idFor(windowStartMs: number, subjectHash: string): string {
  return `${windowStartMs}-${subjectHash}`;
}

const SHA_256_HEX = /^[0-9a-f]{64}$/u;

function validWindow(value: StoredWindow): ValidWindow | null {
  return typeof value.partition === "string" &&
    /^policy-[0-9a-f]{64}$/u.test(value.partition) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.policyHash === "string" &&
    SHA_256_HEX.test(value.policyHash) &&
    typeof value.subjectHash === "string" &&
    SHA_256_HEX.test(value.subjectHash) &&
    typeof value.windowStartMs === "number" &&
    Number.isSafeInteger(value.windowStartMs) &&
    typeof value.count === "number" &&
    Number.isSafeInteger(value.count) &&
    value.count > 0
    ? (value as ValidWindow)
    : null;
}

function sweepIdentity(
  value: StoredWindow,
  expected: PartitionIdentity,
): WindowIdentity | null {
  if (
    typeof value.partition !== "string" ||
    value.partition !== expected.partition ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.policyHash !== "string" ||
    value.policyHash !== expected.policyHash ||
    typeof value.subjectHash !== "string" ||
    !SHA_256_HEX.test(value.subjectHash) ||
    typeof value.windowStartMs !== "number" ||
    !Number.isSafeInteger(value.windowStartMs) ||
    value.id !== idFor(value.windowStartMs, value.subjectHash)
  ) {
    return null;
  }
  return {
    partition: value.partition,
    id: value.id,
    policyHash: value.policyHash,
    subjectHash: value.subjectHash,
    windowStartMs: value.windowStartMs,
  };
}

function assertMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxAttempts must be a positive integer.");
  }
  return value;
}

/**
 * Creates a shared, fixed-window limiter over an injected Store.
 *
 * This tier pays for one storage update per allowed check. A fixed window can
 * admit nearly twice the limit across a boundary; it is intended for
 * low-rate, expensive or abuse-critical operations, not hot cheap endpoints.
 * Storage failures and exhausted contention retries deny rather than throw.
 */
export function createDurableLimiter(
  inputPolicy: RateLimitPolicy,
  store: Store,
  options: DurableLimiterOptions = {},
): DurableRateLimiter {
  const policy = defineRateLimitPolicy(inputPolicy);
  const clock = options.clock ?? systemClock;
  const maxAttempts = assertMaxAttempts(options.maxAttempts ?? 3);
  const collection = store.collection(windows);
  let partitionPromise: Promise<PartitionIdentity> | undefined;

  function getPartition(): Promise<PartitionIdentity> {
    // Start hashing only inside allow/sweep, where fail-closed handling
    // immediately awaits the promise. Eager hashing can leave a rejected
    // digest promise unhandled before the limiter is first used.
    partitionPromise ??= partitionFor(policy);
    return partitionPromise;
  }

  return {
    async allow(key: string, at?: IsoTimestamp): Promise<RateLimitDecision> {
      assertRateLimitKey(key);
      const now = timeInMilliseconds(clock, at);
      if (now === null) {
        return denyForWindow(policy.windowMs);
      }
      const windowStartMs = Math.floor(now / policy.windowMs) * policy.windowMs;
      const windowEndsAt = windowStartMs + policy.windowMs;
      let deciderAllowed = false;

      try {
        const { partition, policyHash } = await getPartition();
        const subjectHash = await subjectHashFor(policyHash, key);
        const id = idFor(windowStartMs, subjectHash);
        const result = await collection.update(
          { partition, id },
          (current) => {
            if (current === null) {
              deciderAllowed = true;
              return {
                action: "write",
                value: {
                  partition,
                  id,
                  policyHash,
                  subjectHash,
                  windowStartMs,
                  count: 1,
                },
              };
            }

            const valid = validWindow(current);
            if (
              valid === null ||
              valid.partition !== partition ||
              valid.id !== id ||
              valid.policyHash !== policyHash ||
              valid.subjectHash !== subjectHash ||
              valid.windowStartMs !== windowStartMs ||
              valid.count >= policy.limit
            ) {
              deciderAllowed = false;
              return { action: "keep" };
            }

            deciderAllowed = true;
            return {
              action: "write",
              value: { ...valid, count: valid.count + 1 },
            };
          },
          { maxAttempts },
        );

        if (result.written && deciderAllowed) {
          return { allowed: true };
        }
      } catch {
        // Storage outage and contention exhaustion deliberately fail closed.
      }

      return {
        allowed: false,
        retryAfter: retryAfter(windowEndsAt, now),
      };
    },

    async sweep(at?: IsoTimestamp): Promise<SweepResult> {
      const now = timeInMilliseconds(clock, at);
      if (now === null) {
        return { scanned: 0, deleted: 0 };
      }

      let expected: PartitionIdentity;
      let rows;
      try {
        expected = await getPartition();
        rows = await collection.listVersioned(expected.partition);
      } catch {
        return { scanned: 0, deleted: 0 };
      }

      let deleted = 0;
      for (const row of rows) {
        const identity = sweepIdentity(row.value, expected);
        if (identity === null) {
          // CollectionStore.listVersioned does not expose the actual row key.
          // Reconstructing one from malformed identity fields could pair this
          // row's version with a different row, so retaining it is the only
          // safe choice.
          continue;
        }
        const countIsMalformed =
          typeof row.value.count !== "number" ||
          !Number.isSafeInteger(row.value.count) ||
          row.value.count <= 0;
        if (
          countIsMalformed ||
          identity.windowStartMs + policy.windowMs > now
        ) {
          continue;
        }
        try {
          const removed = await collection.deleteIfUnchanged(
            {
              partition: identity.partition,
              id: identity.id,
            },
            row.version,
          );
          if (removed) {
            deleted += 1;
          }
        } catch {
          // A sweep is hygiene; a failed delete leaves the record for later.
        }
      }
      return { scanned: rows.length, deleted };
    },
  };
}

export type {
  LimiterOptions,
  RateLimitDecision,
  RateLimiter,
  RateLimitPolicy,
} from "./policy.js";
export { defineRateLimitPolicy } from "./policy.js";
