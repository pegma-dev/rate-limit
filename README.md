# Rate Limit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Request rate limiting for [Pegma](https://pegma.dev) components: an honest
in-memory tier and a durable storage-backed tier for expensive operations.

> [!IMPORTANT]
> Rate Limit is in early `0.x` development. Its public API is not stable.
> Phases 1 and 2 are implemented. `@pegma/rate-limit@0.1.0` is the first
> advertised release, published from the protected signed `v0.1.0` tag through
> trusted-publisher OIDC with provenance. pegma.dev composes the durable tier
> in its production Identity worker.

## Two tiers, no pretending

The most damaging thing a rate limiter can do is misrepresent its consistency.
This component makes the choice explicit at the composition root:

- **`createMemoryLimiter`** is a sliding window per process with zero I/O. It
  is approximate under scale-out: N instances can admit about N times the
  configured limit. It is for abuse dampening where the host accepts that
  property.
- **`createDurableLimiter`** is a fixed-window counter over
  [`@pegma/storage-core`](https://github.com/pegma-dev/storage-core). It pays
  shared-storage latency on each allowed check and is for low-rate, expensive
  or abuse-critical work where the boundary must hold across instances.

The durable tier uses storage-core update deciders. Once a freshly read count
reaches its limit, the decider keeps the record unchanged, so repeated
refusals are read-only. Contention exhaustion, storage outage, malformed
records, and malformed time all fail closed with a millisecond
`retryAfter`. Its sweep uses version-conditional deletes.

Policy names and limiter keys are host-owned opaque strings, but they must be
primitive and non-blank. Whitespace is preserved once that validation passes.
Ill-formed Unicode is rejected so UTF-8 hashing remains injective before the
cryptographic digest.
The durable tier stores only domain-separated SHA-256 hashes of those values,
not the raw inputs, keeping entity sizes bounded. These deterministic hashes
are pseudonymous, not anonymous: predictable inputs can still be guessed, and
the same key remains linkable within one policy.

Fixed windows have a documented edge: a burst crossing a boundary can briefly
admit nearly twice the configured limit. This package does not claim to be
DDoS or volumetric protection, and it does not provide HTTP middleware or
billing metering.

## Package

`@pegma/rate-limit` exposes the common vocabulary at its root and separate
subpaths:

```ts
import { createMemoryLimiter } from "@pegma/rate-limit/memory";
import { createDurableLimiter } from "@pegma/rate-limit/durable";
```

The memory subpath has no storage import. Both tiers accept a named policy and
an optional spine `Clock`.

See [the package README](packages/rate-limit/README.md) for examples and
[the project plan](docs/PROJECT_PLAN.md) for design decisions and remaining
delivery work.

## Development

```sh
npm ci
npm run format:check
npm run check
npm test
```

The test command starts real Azurite and verifies the durable boundary under
concurrent writes.

## License

MIT © RetireGolden, LLC
