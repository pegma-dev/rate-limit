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
 * How often a full expiry scan may run while the cap is reached. Reclaiming is
 * O(tracked keys), so it is rate limited to keep the work per check amortized
 * constant even when every arriving key is new.
 */
const PRUNE_ATTEMPTS_PER_WINDOW = 8;

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
 * unaffected.
 */
export function createMemoryLimiter(
  inputPolicy: RateLimitPolicy,
  options: LimiterOptions = {},
): RateLimiter {
  const policy = defineRateLimitPolicy(inputPolicy);
  const clock = options.clock ?? systemClock;
  const hits = new Map<string, number[]>();
  const pruneIntervalMs = Math.max(
    1,
    Math.floor(policy.windowMs / PRUNE_ATTEMPTS_PER_WINDOW),
  );
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
          prune(cutoff);
          nextPruneAt = now + pruneIntervalMs;
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
