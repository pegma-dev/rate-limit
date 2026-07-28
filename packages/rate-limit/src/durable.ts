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
  readonly policyName: StoredValue;
  readonly subjectKey: StoredValue;
  readonly windowStartMs: StoredValue;
  readonly count: StoredValue;
}

interface ValidWindow {
  readonly partition: string;
  readonly id: string;
  readonly policyName: string;
  readonly subjectKey: string;
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
      policyName: record.policyName ?? null,
      subjectKey: record.subjectKey ?? null,
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

function encodeOpaque(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function partitionFor(policy: RateLimitPolicy): string {
  return `policy-${encodeOpaque(policy.name)}`;
}

function idFor(windowStartMs: number, key: string): string {
  return `${windowStartMs}-${encodeOpaque(key)}`;
}

function validWindow(value: StoredWindow): ValidWindow | null {
  return typeof value.partition === "string" &&
    value.partition.length > 0 &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.policyName === "string" &&
    typeof value.subjectKey === "string" &&
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
  policy: RateLimitPolicy,
  partition: string,
): WindowIdentity | null {
  if (
    typeof value.partition !== "string" ||
    value.partition !== partition ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.policyName !== "string" ||
    value.policyName !== policy.name ||
    typeof value.subjectKey !== "string" ||
    value.subjectKey.trim().length === 0 ||
    typeof value.windowStartMs !== "number" ||
    !Number.isSafeInteger(value.windowStartMs) ||
    value.id !== idFor(value.windowStartMs, value.subjectKey)
  ) {
    return null;
  }
  return {
    partition: value.partition,
    id: value.id,
    policyName: value.policyName,
    subjectKey: value.subjectKey,
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
  const partition = partitionFor(policy);

  return {
    async allow(key: string, at?: IsoTimestamp): Promise<RateLimitDecision> {
      assertRateLimitKey(key);
      const now = timeInMilliseconds(clock, at);
      if (now === null) {
        return denyForWindow(policy.windowMs);
      }
      const windowStartMs = Math.floor(now / policy.windowMs) * policy.windowMs;
      const windowEndsAt = windowStartMs + policy.windowMs;
      const id = idFor(windowStartMs, key);
      let deciderAllowed = false;

      try {
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
                  policyName: policy.name,
                  subjectKey: key,
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
              valid.policyName !== policy.name ||
              valid.subjectKey !== key ||
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

      let rows;
      try {
        rows = await collection.listVersioned(partition);
      } catch {
        return { scanned: 0, deleted: 0 };
      }

      let deleted = 0;
      for (const row of rows) {
        const identity = sweepIdentity(row.value, policy, partition);
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
