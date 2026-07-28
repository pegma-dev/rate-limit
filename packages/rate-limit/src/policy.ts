import type { Clock, IsoTimestamp } from "@pegma/spine";

/** A named rate limit. Durations and retry-after values are milliseconds. */
export interface RateLimitPolicy {
  /** Stable configuration name and durable-storage partition. */
  readonly name: string;
  /** Number of allowed checks in one window. */
  readonly limit: number;
  /** Window duration in milliseconds. */
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Milliseconds until this key may be checked again. Present on refusal. */
  readonly retryAfter?: number;
}

export interface RateLimiter {
  /**
   * Decides whether `key` may proceed.
   *
   * `now` exists for deterministic replay and tests. Normal hosts inject a
   * Clock at construction and omit it.
   */
  allow(key: string, now?: IsoTimestamp): Promise<RateLimitDecision>;
}

export interface LimiterOptions {
  readonly clock?: Clock;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Validates and returns a named policy. */
export function defineRateLimitPolicy(
  policy: RateLimitPolicy,
): RateLimitPolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new TypeError("A rate-limit policy must be an object.");
  }
  const name = Object.getOwnPropertyDescriptor(policy, "name")?.value;
  const limit = Object.getOwnPropertyDescriptor(policy, "limit")?.value;
  const windowMs = Object.getOwnPropertyDescriptor(policy, "windowMs")?.value;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("A rate-limit policy name must be a non-blank string.");
  }
  if (!isWellFormedUnicode(name)) {
    throw new TypeError(
      "A rate-limit policy name must contain well-formed Unicode.",
    );
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError(
      "A rate-limit policy limit must be a positive integer.",
    );
  }
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new TypeError(
      "A rate-limit policy windowMs must be a positive integer.",
    );
  }
  return Object.freeze({ name, limit, windowMs });
}

export function assertRateLimitKey(key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new TypeError("A rate-limit key must be a non-blank string.");
  }
  if (!isWellFormedUnicode(key)) {
    throw new TypeError("A rate-limit key must contain well-formed Unicode.");
  }
}

export function timeInMilliseconds(
  clock: Clock,
  now: IsoTimestamp | undefined,
): number | null {
  try {
    const timestamp = now ?? clock.now();
    if (typeof timestamp !== "string") {
      return null;
    }
    const milliseconds = Date.parse(timestamp);
    return Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === timestamp
      ? milliseconds
      : null;
  } catch {
    return null;
  }
}

export function retryAfter(windowEndsAt: number, now: number): number {
  return Math.max(1, Math.ceil(windowEndsAt - now));
}

export function denyForWindow(windowMs: number): RateLimitDecision {
  return { allowed: false, retryAfter: windowMs };
}
