# `@pegma/rate-limit`

Two explicitly named application rate-limit tiers:

- `createMemoryLimiter` is a per-instance sliding window with zero I/O. It is
  approximate under scale-out.
- `createDurableLimiter` is a shared fixed-window counter over an injected
  `@pegma/storage-core` `Store`. It is for low-rate, expensive or
  abuse-critical operations.

> [!IMPORTANT]
> `0.1.0` is the first advertised release, published through
> trusted-publisher OIDC with provenance. The exact reviewed `0.0.0`
> package-name bootstrap remains isolated under the `bootstrap` dist-tag and
> is never advertised as the current supported release.

There is no default tier and no automatic upgrade. This package is application
abuse control, not DDoS protection, HTTP middleware, or billing metering.
Policy names and limiter keys must be primitive, non-blank strings. Whitespace
is preserved; it remains part of the host-chosen opaque identity. Inputs must
also contain well-formed Unicode so UTF-8 hashing cannot alias distinct
unpaired UTF-16 surrogate code units.

## Memory tier

The memory-only subpath does not import storage:

```ts
import {
  createMemoryLimiter,
  defineRateLimitPolicy,
} from "@pegma/rate-limit/memory";

const policy = defineRateLimitPolicy({
  name: "public-read",
  limit: 60,
  windowMs: 5 * 60_000,
});
const limiter = createMemoryLimiter(policy);
const decision = await limiter.allow(clientAddress);
```

With N host instances this can admit approximately N times `limit`. Choosing
it means accepting that property.

This tier holds its counters in memory, so its footprint is bounded on both
axes. It tracks at most 10,000 keys at once and accepts keys of at most 512
characters; a longer key is rejected as invalid. When the key cap is reached
and no tracked key has expired yet, a check for a key that is not already
tracked fails closed with `retryAfter` instead of growing the map. Keys
already tracked keep their own counts and are never evicted, so a spray of
unique keys can neither exhaust host memory nor reset another subject's
window. Both bounds are specific to this tier: the durable tier hashes keys to
fixed-length identifiers and stores them, so it accepts keys of any length.

## Durable tier

```ts
import {
  createDurableLimiter,
  defineRateLimitPolicy,
} from "@pegma/rate-limit/durable";

const limiter = createDurableLimiter(
  defineRateLimitPolicy({
    name: "login",
    limit: 10,
    windowMs: 5 * 60_000,
  }),
  store,
);

const decision = await limiter.allow(principalOrAddress);
await limiter.sweep();
```

Allowed checks perform a decider-mediated storage update. Once the current
count reaches the limit, checks refuse without writing. Contention exhaustion,
storage outage, malformed state, and malformed clock values fail closed with
`retryAfter`, measured in milliseconds.

Policy names and limiter keys are domain-separated and SHA-256 hashed for
backend-safe storage identifiers. Durable counter records store only those
bounded hashes, never the raw policy name or key. Subject hashes are scoped to
their policy, but they are deterministic pseudonymous identifiers, not
anonymization: predictable inputs can still be guessed and activity remains
linkable within a policy.

The durable tier uses fixed windows. A burst across a boundary can briefly
admit nearly twice the limit. It also puts shared-storage latency on every
allowed check; do not use it for hot, cheap endpoints.

Sweeps list one policy partition and delete structurally valid expired rows
only if their versions are unchanged. Malformed rows are retained:
storage-core listings do not expose actual row keys, so pairing a malformed
row's version with a key reconstructed from its payload could target another
row. Checks against that malformed row still fail closed.

## License

MIT
