import { describe, expect, it } from "vitest";

import {
  createMemoryLimiter,
  defineRateLimitPolicy,
  type RateLimitPolicy,
} from "./memory.js";

const policy = defineRateLimitPolicy({
  name: "public-read",
  limit: 2,
  windowMs: 1_000,
});

describe("createMemoryLimiter", () => {
  it("uses a sliding window and reports retry-after in milliseconds", async () => {
    const limiter = createMemoryLimiter(policy);

    await expect(
      limiter.allow("client", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.allow("client", "2026-01-01T00:00:00.400Z"),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.allow("client", "2026-01-01T00:00:00.600Z"),
    ).resolves.toEqual({ allowed: false, retryAfter: 400 });
    await expect(
      limiter.allow("client", "2026-01-01T00:00:01.000Z"),
    ).resolves.toEqual({ allowed: true });
  });

  it("counts opaque keys independently", async () => {
    const limiter = createMemoryLimiter({
      name: "by-principal",
      limit: 1,
      windowMs: 60_000,
    });

    await expect(
      limiter.allow("principal/one?#", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.allow("principal/two?#", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ allowed: true });
  });

  it("fails closed when its clock is malformed", async () => {
    const limiter = createMemoryLimiter(policy, {
      clock: { now: () => "not-a-timestamp" },
    });

    await expect(limiter.allow("client")).resolves.toEqual({
      allowed: false,
      retryAfter: 1_000,
    });
  });

  it.each(["0", "01/02/2026", "2026-02-30T00:00:00.000Z"])(
    "fails closed for a parseable noncanonical timestamp %#",
    async (timestamp) => {
      await expect(
        createMemoryLimiter(policy).allow("client", timestamp),
      ).resolves.toEqual({
        allowed: false,
        retryAfter: 1_000,
      });
    },
  );

  it("fails closed when its clock throws", async () => {
    const limiter = createMemoryLimiter(policy, {
      clock: {
        now: () => {
          throw new Error("clock unavailable");
        },
      },
    });

    await expect(limiter.allow("client")).resolves.toEqual({
      allowed: false,
      retryAfter: 1_000,
    });
  });

  it.each([
    [{ name: "", limit: 1, windowMs: 1 }, "name"],
    [{ name: "   ", limit: 1, windowMs: 1 }, "name"],
    [{ name: "bad-limit", limit: 0, windowMs: 1 }, "limit"],
    [{ name: "bad-window", limit: 1, windowMs: 0 }, "windowMs"],
  ])("rejects invalid policy %#", (candidate, message) => {
    expect(() => defineRateLimitPolicy(candidate)).toThrow(message);
  });

  it.each([
    null,
    [],
    {},
    Object.create({ name: "inherited", limit: 1, windowMs: 1 }),
  ])("rejects a malformed policy container %#", (candidate) => {
    expect(() =>
      defineRateLimitPolicy(candidate as unknown as RateLimitPolicy),
    ).toThrow(TypeError);
  });

  it("rejects accessor policy fields without executing them", () => {
    let reads = 0;
    const candidate = {
      get name() {
        reads += 1;
        return "accessor";
      },
      limit: 1,
      windowMs: 1,
    };

    expect(() =>
      defineRateLimitPolicy(candidate as unknown as RateLimitPolicy),
    ).toThrow("name");
    expect(reads).toBe(0);
  });

  it("preserves meaningful policy and key whitespace", async () => {
    const named = defineRateLimitPolicy({
      name: " padded policy ",
      limit: 1,
      windowMs: 1_000,
    });
    expect(named.name).toBe(" padded policy ");
    await expect(
      createMemoryLimiter(named).allow(
        " padded key ",
        "2026-01-01T00:00:00.000Z",
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it.each(["", "   ", null, new String("boxed")])(
    "rejects an invalid limiter key %#",
    async (key) => {
      await expect(
        createMemoryLimiter(policy).allow(key as unknown as string),
      ).rejects.toThrow("key");
    },
  );
});
