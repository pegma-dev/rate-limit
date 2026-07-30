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

/**
 * Hard cap on simultaneously tracked keys. Per-key state is already bounded by
 * `policy.limit` timestamps, so this bounds the tier's total footprint.
 */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Shortest gap between expiry scans while the cap is reached. A scan is
 * O(tracked keys), so this floor keeps the work per check amortized constant
 * however a spray is spread across the window. Otherwise a scan is aimed at the
 * moment reclaim actually becomes possible, so this floor — not the window — is
 * the longest a reclaimable key can stay unreclaimed.
 */
const MIN_PRUNE_INTERVAL_MS = 50;

/**
 * Maximum key length this tier will track, measured in UTF-16 code units
 * because that is what the retained string costs: an astral symbol such as an
 * emoji counts two. Only the memory tier retains the raw key — the durable tier
 * hashes it to a fixed-length identifier — so only this tier needs the bound.
 * Keys are opaque subject identifiers such as an address, a principal, or a
 * short composite of those, so the bound sits far above legitimate use.
 */
const MAX_KEY_LENGTH = 512;

function assertMemoryLimiterKey(key: string): void {
  // Checked before the shared validator's well-formedness scan, which walks
  // the whole string, so an oversized key is rejected without being traversed.
  if (typeof key === "string" && key.length > MAX_KEY_LENGTH) {
    throw new TypeError(
      `A memory-tier rate-limit key must be at most ${MAX_KEY_LENGTH} UTF-16 code units.`,
    );
  }
  assertRateLimitKey(key);
}

/**
 * Creates a zero-I/O sliding-window limiter.
 *
 * This tier is per-instance. With N application instances it can admit about
 * N times the configured limit; use it only where that approximation is an
 * explicit host decision.
 *
 * It tracks at most {@link MAX_TRACKED_KEYS} keys. Once that cap is reached
 * and expired keys cannot be reclaimed, checks for keys that are not already
 * tracked deny with a retry-after rather than growing without bound, so a
 * unique-key spray cannot exhaust the host's memory. Already-tracked keys are
 * unaffected. Reclaim is attempted as soon as the earliest tracked entry
 * expires, subject only to the {@link MIN_PRUNE_INTERVAL_MS} floor, so capacity
 * returns within that floor of a spray ageing out.
 */
export function createMemoryLimiter(
  inputPolicy: RateLimitPolicy,
  options: LimiterOptions = {},
): RateLimiter {
  const policy = defineRateLimitPolicy(inputPolicy);
  const clock = options.clock ?? systemClock;
  const hits = new Map<string, number[]>();
  const pruneFloorMs = Math.max(
    1,
    Math.min(MIN_PRUNE_INTERVAL_MS, policy.windowMs),
  );
  let nextPruneAt = Number.NEGATIVE_INFINITY;

  function liveEntries(entries: readonly number[], cutoff: number): number[] {
    return entries.filter((at) => at > cutoff);
  }

  /**
   * Drops entries at or before `cutoff` and deletes keys left with none.
   * Returns the earliest timestamp still retained, or positive infinity when
   * nothing is, so the caller can aim the next scan at the moment the next key
   * becomes reclaimable.
   */
  function prune(cutoff: number): number {
    let earliestRetained = Number.POSITIVE_INFINITY;
    for (const [key, entries] of hits) {
      const kept = liveEntries(entries, cutoff);
      if (kept.length === 0) {
        hits.delete(key);
        continue;
      }
      hits.set(key, kept);
      for (const at of kept) {
        if (at < earliestRetained) {
          earliestRetained = at;
        }
      }
    }
    return earliestRetained;
  }

  return {
    async allow(key: string, at?: IsoTimestamp): Promise<RateLimitDecision> {
      assertMemoryLimiterKey(key);
      const now = timeInMilliseconds(clock, at);
      if (now === null) {
        return denyForWindow(policy.windowMs);
      }

      const cutoff = now - policy.windowMs;
      const tracked = hits.get(key);
      const entries = liveEntries(tracked ?? [], cutoff);
      if (entries.length >= policy.limit) {
        return {
          allowed: false,
          retryAfter: retryAfter((entries[0] as number) + policy.windowMs, now),
        };
      }

      // Only an untracked key can grow the map, so the cap is enforced here
      // and never on the over-limit refusal path above, which stays read-only.
      if (tracked === undefined && hits.size >= MAX_TRACKED_KEYS) {
        if (now >= nextPruneAt) {
          const earliestRetained = prune(cutoff);
          // The earliest retained entry becomes reclaimable exactly one window
          // after it was recorded, so aim the next scan there rather than at a
          // fixed backoff, which could land past expiry and refuse capacity
          // that was already reclaimable. The floor bounds scan frequency.
          nextPruneAt = Math.max(
            now + pruneFloorMs,
            Number.isFinite(earliestRetained)
              ? earliestRetained + policy.windowMs
              : now,
          );
        }
        if (hits.size >= MAX_TRACKED_KEYS) {
          return denyForWindow(policy.windowMs);
        }
      }

      entries.push(now);
      hits.set(key, entries);
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
