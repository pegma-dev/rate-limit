# `@pegma/rate-limit`

Two explicitly named application rate-limit tiers:

- `createMemoryLimiter` is a per-instance sliding window with zero I/O. It is
  approximate under scale-out.
- `createDurableLimiter` is a shared fixed-window counter over an injected
  `@pegma/storage-core` `Store`. It is for low-rate, expensive or
  abuse-critical operations.

> [!IMPORTANT]
> This source package is at the one-time `0.0.0` package-name bootstrap stage.
> It is not an advertised release. A separate `0.1.0` release follows
> bootstrap and consumer validation.

There is no default tier and no automatic upgrade. This package is application
abuse control, not DDoS protection, HTTP middleware, or billing metering.
Policy names and limiter keys must be primitive, non-blank strings. Whitespace
is preserved; it remains part of the host-chosen opaque identity.

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
backend-safe storage identifiers. Their original values remain part of the
stored counter record so malformed or colliding state still fails closed.

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
