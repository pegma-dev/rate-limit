import { describe, expect, it } from "vitest";

import {
  createMemoryLimiter,
  defineRateLimitPolicy,
  type RateLimiter,
  type RateLimitPolicy,
} from "./memory.js";

const policy = defineRateLimitPolicy({
  name: "public-read",
  limit: 2,
  windowMs: 1_000,
});

/** Mirrors MAX_TRACKED_KEYS in memory.ts; both bounds are documented. */
const MAX_TRACKED_KEYS = 10_000;
/** Mirrors MAX_KEY_LENGTH in memory.ts. */
const MAX_KEY_LENGTH = 512;

/** Fills the limiter with `count` distinct keys, all of which must be admitted. */
async function spray(
  limiter: RateLimiter,
  at: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const decision = await limiter.allow(`sprayed-${index}`, at);
    if (!decision.allowed) {
      throw new Error(`distinct key ${index} was refused below the cap`);
    }
  }
}

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

  it("bounds tracked keys and fails closed for untracked keys at the cap", async () => {
    const limiter = createMemoryLimiter(policy);
    const start = "2026-01-01T00:00:00.000Z";
    await spray(limiter, start, MAX_TRACKED_KEYS);

    // The cap is reached and nothing has expired, so a unique-key spray is
    // refused instead of growing the map for the rest of the window.
    await expect(limiter.allow("overflow", start)).resolves.toEqual({
      allowed: false,
      retryAfter: 1_000,
    });

    // Keys already tracked keep their own counts and are not evicted, so the
    // spray cannot reset a subject's window either.
    await expect(limiter.allow("sprayed-0", start)).resolves.toEqual({
      allowed: true,
    });
    await expect(limiter.allow("sprayed-0", start)).resolves.toEqual({
      allowed: false,
      retryAfter: 1_000,
    });
  });

  it("reclaims expired keys so a spray cannot hold the cap permanently", async () => {
    const limiter = createMemoryLimiter(policy);
    await spray(limiter, "2026-01-01T00:00:00.000Z", MAX_TRACKED_KEYS);

    await expect(
      limiter.allow("later", "2026-01-01T00:00:00.500Z"),
    ).resolves.toEqual({ allowed: false, retryAfter: 1_000 });
    await expect(
      limiter.allow("later", "2026-01-01T00:00:01.001Z"),
    ).resolves.toEqual({ allowed: true });
  });

  it("reclaims on the first check after expiry however late the last scan was", async () => {
    const limiter = createMemoryLimiter(policy);
    await spray(limiter, "2026-01-01T00:00:00.000Z", MAX_TRACKED_KEYS);

    // A refused probe late in the window schedules the next reclaim scan. That
    // schedule must not land past the moment the sprayed entries expire, or
    // this key would be refused while the whole map is already dead weight.
    await expect(
      limiter.allow("probe", "2026-01-01T00:00:00.900Z"),
    ).resolves.toEqual({ allowed: false, retryAfter: 1_000 });
    await expect(
      limiter.allow("after-expiry", "2026-01-01T00:00:01.001Z"),
    ).resolves.toEqual({ allowed: true });
  });

  it("rejects a key longer than the tracked bound", async () => {
    await expect(
      createMemoryLimiter(policy).allow("k".repeat(MAX_KEY_LENGTH + 1)),
    ).rejects.toThrow(`at most ${MAX_KEY_LENGTH} UTF-16 code units`);
  });

  it("accepts a key exactly at the tracked bound", async () => {
    await expect(
      createMemoryLimiter(policy).allow(
        "k".repeat(MAX_KEY_LENGTH),
        "2026-01-01T00:00:00.000Z",
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it("measures the key bound in UTF-16 code units, not code points", async () => {
    // Each astral symbol is a surrogate pair, so half as many fit.
    const limiter = createMemoryLimiter(policy);
    await expect(
      limiter.allow("\u{1f680}".repeat(MAX_KEY_LENGTH / 2 + 1)),
    ).rejects.toThrow(`at most ${MAX_KEY_LENGTH} UTF-16 code units`);
    await expect(
      limiter.allow(
        "\u{1f680}".repeat(MAX_KEY_LENGTH / 2),
        "2026-01-01T00:00:00.000Z",
      ),
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

  it.each([0xd800, 0xdbff, 0xdc00, 0xdfff])(
    "rejects an unpaired surrogate policy code unit %#",
    (codeUnit) => {
      expect(() =>
        defineRateLimitPolicy({
          name: `policy-${String.fromCharCode(codeUnit)}`,
          limit: 1,
          windowMs: 1_000,
        }),
      ).toThrow("well-formed Unicode");
    },
  );

  it("accepts paired surrogate policy names and keys", async () => {
    const limiter = createMemoryLimiter({
      name: "policy-\u{1f600}",
      limit: 1,
      windowMs: 1_000,
    });

    await expect(
      limiter.allow("key-\u{1f680}", "2026-01-01T00:00:00.000Z"),
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

  it.each([0xd800, 0xdbff, 0xdc00, 0xdfff])(
    "rejects an unpaired surrogate limiter key code unit %#",
    async (codeUnit) => {
      await expect(
        createMemoryLimiter(policy).allow(
          `key-${String.fromCharCode(codeUnit)}`,
        ),
      ).rejects.toThrow("well-formed Unicode");
    },
  );
});
