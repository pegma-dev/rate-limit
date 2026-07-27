# Rate Limit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Request rate limiting for [Pegma](https://pegma.dev) components: an honest
in-memory tier and a durable storage-backed tier for expensive operations.

> [!IMPORTANT]
> Rate Limit is in early `0.x` development. Its public API is not stable, its
> packages are not published, and it is not ready for production use. It is
> deliberately dormant until its first consumer (the Pegma support desk)
> needs it — see the plan.

## Two tiers, no pretending

The most damaging thing a rate limiter can do is misrepresent its
consistency. This component makes the choice explicit at the composition
root, and neither tier pretends to be the other:

- **Memory** — a sliding window per process, zero I/O. Per-instance and
  therefore *approximate under scale-out* (N instances ≈ N× the limit),
  which is fine for what it is: abuse dampening on cheap endpoints. It says
  so in its name and its docs.
- **Durable** — a fixed-window counter over
  [`@pegma/storage-core`](https://github.com/pegma-dev/storage-core), one
  storage round trip per check. For low-rate, expensive, abuse-critical
  operations — login attempts, checkout creation, sender throttling — where
  the limit must actually hold across instances and the guarded work dwarfs
  the check.

The durable tier is engineered for the ugly moment it exists for: once a key
is over its limit, refusals are **read-only** (the system under heaviest
attack does the least work), retries are bounded, and every failure mode —
contention exhaustion, storage outage — **fails closed**. There is no
configuration that makes it fail open; a host wanting that owns the decision
in its own code.

Not here, on purpose: DDoS/volumetric protection (that belongs to the edge,
before requests cost compute), distributed sliding windows and shared token
buckets (wrong cost profile for the primitives), HTTP middleware, and
quota/billing metering.

## Where it fits

The memory tier depends only on
[`@pegma/spine`](https://github.com/pegma-dev/spine) (`Clock`) and is
importable without any storage. The durable tier declares one collection
over an injected storage-core `Store`. The in-memory design is extracted
from the production limiter in the RetireGolden account API, the ecosystem's
reference application. See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for
the model, decisions, and phases.

## License

MIT © RetireGolden, LLC
