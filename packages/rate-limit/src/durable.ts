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
const POLICY_DESCRIPTOR_ID = "policy";
const DEFAULT_MAX_CLOCK_SKEW_MS = 60_000;

interface StoredRateLimitRecord {
  readonly partition: StoredValue;
  readonly id: StoredValue;
  readonly kind: StoredValue;
  readonly policyHash: StoredValue;
  readonly subjectHash: StoredValue;
  readonly windowStartMs: StoredValue;
  readonly count: StoredValue;
  readonly limit: StoredValue;
  readonly windowMs: StoredValue;
}

interface ValidWindow {
  readonly partition: string;
  readonly id: string;
  readonly kind: "window";
  readonly policyHash: string;
  readonly subjectHash: string;
  readonly windowStartMs: number;
  readonly count: number;
  readonly limit: number;
  readonly windowMs: number;
}

type WindowIdentity = Omit<ValidWindow, "count">;

const records = defineCollection<StoredRateLimitRecord>({
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
      kind: record.kind ?? null,
      policyHash: record.policyHash ?? null,
      subjectHash: record.subjectHash ?? null,
      windowStartMs: record.windowStartMs ?? null,
      count: record.count ?? null,
      limit: record.limit ?? null,
      windowMs: record.windowMs ?? null,
    }),
  },
});

export interface DurableLimiterOptions extends LimiterOptions {
  /** Total optimistic-concurrency attempts. Defaults to 3. */
  readonly maxAttempts?: number;
  /**
   * Retention grace added after each fixed window. Defaults to 60 seconds so
   * a moderately fast peer clock cannot sweep a slower peer's active window.
   */
  readonly maxClockSkewMs?: number;
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

function validWindow(value: StoredRateLimitRecord): ValidWindow | null {
  return value.kind === "window" &&
    typeof value.partition === "string" &&
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
    value.count > 0 &&
    typeof value.limit === "number" &&
    Number.isSafeInteger(value.limit) &&
    value.limit > 0 &&
    typeof value.windowMs === "number" &&
    Number.isSafeInteger(value.windowMs) &&
    value.windowMs > 0
    ? (value as ValidWindow)
    : null;
}

function windowMatches(
  value: StoredRateLimitRecord,
  expected: PartitionIdentity,
  policy: RateLimitPolicy,
  subjectHash: string,
  windowStartMs: number,
): ValidWindow | null {
  const valid = validWindow(value);
  const id = idFor(windowStartMs, subjectHash);
  return valid !== null &&
    valid.partition === expected.partition &&
    valid.id === id &&
    valid.policyHash === expected.policyHash &&
    valid.subjectHash === subjectHash &&
    valid.windowStartMs === windowStartMs &&
    valid.limit === policy.limit &&
    valid.windowMs === policy.windowMs
    ? valid
    : null;
}

function descriptorMatches(
  value: StoredRateLimitRecord,
  expected: PartitionIdentity,
  policy: RateLimitPolicy,
): boolean {
  return (
    value.kind === "policy" &&
    value.partition === expected.partition &&
    value.id === POLICY_DESCRIPTOR_ID &&
    value.policyHash === expected.policyHash &&
    value.subjectHash === null &&
    value.windowStartMs === null &&
    value.count === null &&
    value.limit === policy.limit &&
    value.windowMs === policy.windowMs
  );
}

function descriptorValue(
  expected: PartitionIdentity,
  policy: RateLimitPolicy,
): StoredRateLimitRecord {
  return {
    partition: expected.partition,
    id: POLICY_DESCRIPTOR_ID,
    kind: "policy",
    policyHash: expected.policyHash,
    subjectHash: null,
    windowStartMs: null,
    count: null,
    limit: policy.limit,
    windowMs: policy.windowMs,
  };
}

function sweepIdentity(
  value: StoredRateLimitRecord,
  expected: PartitionIdentity,
  policy: RateLimitPolicy,
): WindowIdentity | null {
  const valid = validWindow(value);
  if (
    valid === null ||
    valid.partition !== expected.partition ||
    valid.policyHash !== expected.policyHash ||
    valid.id !== idFor(valid.windowStartMs, valid.subjectHash) ||
    valid.limit !== policy.limit ||
    valid.windowMs !== policy.windowMs
  ) {
    return null;
  }
  const { count: _count, ...identity } = valid;
  return identity;
}

function assertMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxAttempts must be a positive integer.");
  }
  return value;
}

function assertMaxClockSkewMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("maxClockSkewMs must be a non-negative integer.");
  }
  return value;
}

/**
 * Creates a shared, fixed-window limiter over an injected Store.
 *
 * This tier revalidates its immutable policy descriptor and pays for one
 * counter write per allowed check. A fixed window can admit nearly twice the
 * limit across a boundary; it is intended for low-rate, expensive or
 * abuse-critical operations, not hot cheap endpoints. Storage failures and
 * exhausted contention retries deny rather than throw.
 */
export function createDurableLimiter(
  inputPolicy: RateLimitPolicy,
  store: Store,
  options: DurableLimiterOptions = {},
): DurableRateLimiter {
  const policy = defineRateLimitPolicy(inputPolicy);
  const clock = options.clock ?? systemClock;
  const maxAttempts = assertMaxAttempts(options.maxAttempts ?? 3);
  const maxClockSkewMs = assertMaxClockSkewMs(
    options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS,
  );
  const collection = store.collection(records);
  let partitionPromise: Promise<PartitionIdentity> | undefined;
  let descriptorEstablished = false;

  function getPartition(): Promise<PartitionIdentity> {
    // Start hashing only inside allow/sweep, where fail-closed handling
    // immediately awaits the promise. Eager hashing can leave a rejected
    // digest promise unhandled before the limiter is first used.
    partitionPromise ??= partitionFor(policy);
    return partitionPromise;
  }

  async function ensureDescriptor(
    expected: PartitionIdentity,
    create: boolean,
  ): Promise<boolean> {
    let matches = false;
    let observed = false;
    await collection.update(
      { partition: expected.partition, id: POLICY_DESCRIPTOR_ID },
      (current) => {
        if (current === null) {
          matches = create;
          observed = create;
          return create
            ? { action: "write", value: descriptorValue(expected, policy) }
            : { action: "keep" };
        }
        observed = true;
        matches = descriptorMatches(current, expected, policy);
        return { action: "keep" };
      },
      { maxAttempts },
    );
    if (observed) {
      descriptorEstablished = true;
    }
    return matches;
  }

  async function preflightRefuses(
    expected: PartitionIdentity,
    subjectHash: string,
    windowStartMs: number,
  ): Promise<boolean> {
    let refuses = false;
    const id = idFor(windowStartMs, subjectHash);
    await collection.update(
      { partition: expected.partition, id },
      (current) => {
        if (current !== null) {
          const valid = windowMatches(
            current,
            expected,
            policy,
            subjectHash,
            windowStartMs,
          );
          refuses = valid === null || valid.count >= policy.limit;
        }
        return { action: "keep" };
      },
      { maxAttempts },
    );
    return refuses;
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
        const expected = await getPartition();
        const subjectHash = await subjectHashFor(expected.policyHash, key);
        const id = idFor(windowStartMs, subjectHash);
        let createDescriptor = false;

        if (!descriptorEstablished) {
          // A fresh limiter checks the counter first. If it is already at its
          // boundary, refusal returns after a keep decision and does not write
          // a missing descriptor or any other record.
          if (await preflightRefuses(expected, subjectHash, windowStartMs)) {
            return {
              allowed: false,
              retryAfter: retryAfter(windowEndsAt, now),
            };
          }
          const rows = await collection.listVersioned(expected.partition);
          const hasDescriptor = rows.some(
            ({ value }) => value.id === POLICY_DESCRIPTOR_ID,
          );
          if (!hasDescriptor && rows.length > 0) {
            return {
              allowed: false,
              retryAfter: retryAfter(windowEndsAt, now),
            };
          }
          createDescriptor = !hasDescriptor;
        }
        // Revalidate the descriptor before every counter write. Once this
        // instance has observed a descriptor, a later absence fails closed
        // instead of silently recreating state after a coordinated reset.
        if (!(await ensureDescriptor(expected, createDescriptor))) {
          return {
            allowed: false,
            retryAfter: retryAfter(windowEndsAt, now),
          };
        }

        const result = await collection.update(
          { partition: expected.partition, id },
          (current) => {
            if (current === null) {
              deciderAllowed = true;
              return {
                action: "write",
                value: {
                  partition: expected.partition,
                  id,
                  kind: "window",
                  policyHash: expected.policyHash,
                  subjectHash,
                  windowStartMs,
                  count: 1,
                  limit: policy.limit,
                  windowMs: policy.windowMs,
                },
              };
            }

            const valid = windowMatches(
              current,
              expected,
              policy,
              subjectHash,
              windowStartMs,
            );
            if (valid === null || valid.count >= policy.limit) {
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
        if (!(await ensureDescriptor(expected, false))) {
          return { scanned: 0, deleted: 0 };
        }
        rows = await collection.listVersioned(expected.partition);
      } catch {
        return { scanned: 0, deleted: 0 };
      }

      const candidates = rows.filter(
        ({ value }) => value.id !== POLICY_DESCRIPTOR_ID,
      );
      let deleted = 0;
      for (const row of candidates) {
        const identity = sweepIdentity(row.value, expected, policy);
        if (identity === null) {
          // CollectionStore.listVersioned does not expose the actual row key.
          // Reconstructing one from malformed identity fields could pair this
          // row's version with a different row, so retaining it is the only
          // safe choice.
          continue;
        }
        const expiresAt =
          identity.windowStartMs + policy.windowMs + maxClockSkewMs;
        if (!Number.isSafeInteger(expiresAt) || expiresAt > now) {
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
      return { scanned: candidates.length, deleted };
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
