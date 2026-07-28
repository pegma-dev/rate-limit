import { systemClock } from "@pegma/spine";
import type { IsoTimestamp } from "@pegma/spine";

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

const PRUNE_THRESHOLD = 10_000;

/**
 * Creates a zero-I/O sliding-window limiter.
 *
 * This tier is per-instance. With N application instances it can admit about
 * N times the configured limit; use it only where that approximation is an
 * explicit host decision.
 */
export function createMemoryLimiter(
  inputPolicy: RateLimitPolicy,
  options: LimiterOptions = {},
): RateLimiter {
  const policy = defineRateLimitPolicy(inputPolicy);
  const clock = options.clock ?? systemClock;
  const hits = new Map<string, number[]>();
  let nextPruneAt = Number.NEGATIVE_INFINITY;

  function liveEntries(entries: readonly number[], cutoff: number): number[] {
    return entries.filter((at) => at > cutoff);
  }

  function prune(cutoff: number): void {
    for (const [key, entries] of hits) {
      const kept = liveEntries(entries, cutoff);
      if (kept.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, kept);
      }
    }
  }

  return {
    async allow(key: string, at?: IsoTimestamp): Promise<RateLimitDecision> {
      assertRateLimitKey(key);
      const now = timeInMilliseconds(clock, at);
      if (now === null) {
        return denyForWindow(policy.windowMs);
      }

      const cutoff = now - policy.windowMs;
      const entries = liveEntries(hits.get(key) ?? [], cutoff);
      if (entries.length >= policy.limit) {
        return {
          allowed: false,
          retryAfter: retryAfter((entries[0] as number) + policy.windowMs, now),
        };
      }

      entries.push(now);
      hits.set(key, entries);
      if (hits.size > PRUNE_THRESHOLD && now >= nextPruneAt) {
        prune(cutoff);
        nextPruneAt = now + policy.windowMs;
      }
      return { allowed: true };
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
