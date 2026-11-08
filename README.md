# Rate Limit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Request rate limiting for [Pegma](https://pegma.dev) components: an honest
in-memory tier and a durable storage-backed tier for expensive operations.

> [!IMPORTANT]
> Rate Limit is in early `0.x` development. Its public API is not stable.
> Current source is the **`0.3.0` candidate, not published**. Registry `0.2.0`
> predates the merged [PR #8 hardening](https://github.com/pegma-dev/rate-limit/pull/8)
> and the new bounded maintenance helper. The first advertised `0.1.0`
> release was published from protected signed `v0.1.0` through
> trusted-publisher OIDC with provenance; the historical `0.0.0` name bootstrap
> remains separate under `bootstrap`. pegma.dev composes the durable tier in
> its production Identity worker; this candidate is not a new host deployment.

The source behavior below describes the `0.3.0` candidate. Adoption waits for
its reviewed publication and the host's explicit configuration/storage transition.

## Two tiers, no pretending

The most damaging thing a rate limiter can do is misrepresent its consistency.
This component makes the choice explicit at the composition root:

- **`createMemoryLimiter`** is a sliding window per process with zero I/O. It
  is approximate under scale-out: N instances can admit about N times the
  configured limit. It is for abuse dampening where the host accepts that
  property. Because its counters live in host memory, it tracks a bounded
  number of bounded-length keys and fails closed for untracked keys once that
  cap is reached.
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
primitive and non-blank. Keys are limited to 512 UTF-16 code units before
either tier scans or hashes them. Whitespace is preserved once validation
passes. Ill-formed Unicode is rejected so UTF-8 hashing remains injective
before the cryptographic digest.
The durable tier stores only domain-separated SHA-256 hashes of those values,
not the raw inputs, keeping entity sizes bounded. These deterministic hashes
are pseudonymous, not anonymous: predictable inputs can still be guessed, and
the same key remains linkable within one policy.

Durable storage binds each policy name to its initial `limit` and `windowMs`.
Conflicting instances fail closed; rolling configuration changes use a
versioned policy name or a coordinated store reset. Sweeps retain ended windows
for a configurable clock-skew grace, 60 seconds by default.

## Bounded global durable maintenance (source candidate)

`sweepDurableWindowsPage` is exported from the package root and
`@pegma/rate-limit/durable`. It takes a Store and a required physical page
`limit`, optional opaque `cursor`, `clock`, and `maxClockSkewMs`, returning
`{ scanned, deleted, nextCursor }`. The
[source definition](packages/rate-limit/src/durable.ts) owns the exact types.
This is maintenance across all policies in that Store's rate-limit collection;
it requires no policy enumeration or live limiter instances.

Each call makes one scan of at most `limit` physical rows, including policy
descriptors, unrelated policies, malformed records, and unknown legacy rows.
It validates the page bound before filtering or keyed work, then makes at most
`limit` fresh descriptor reads and `limit` conditional deletes. Only a valid
new-format expired window whose identity matches its actual scan key, current
policy descriptor, and unchanged opaque version can be deleted. Descriptors,
legacy `0.2.0` rows, malformed rows, and policy mismatches remain stored.
Malformed stored payloads are distinct from invalid adapter page/row envelopes:
invalid envelopes and storage failures reject the call without skipping ahead.

Descriptor reads and deletes run sequentially. The row/call bounds provide no
wall-clock or deadline guarantee. Choose a small page limit that fits the real
provider's storage latency, execution-time and subrequest budgets.

The host persists the returned cursor unchanged after a successful page,
including a page that deletes nothing. On rejection it retains the previous
cursor and retries later; no completed page is reported. A mid-page failure
does not roll back earlier conditional deletions, and retrying from the prior
cursor can repeat work. Pages are not
snapshots, so repeat complete cycles. The helper applies its configured
clock-skew grace across the page, 60 seconds by default; choose a common grace
consistent with the host's peer-clock envelope. The helper itself leaves the
already-merged memory behavior, `allow()`, and per-policy `limiter.sweep()`
unchanged.

## Published `0.2.0` storage and configuration

Published `0.2.0` predates immutable policy descriptors and the new
`kind`/`limit`/`windowMs` counter layout. The candidate does not automatically
convert or clean up those legacy rows. Plan a versioned policy name or a
separate Store namespace, or coordinate a deliberate reset of the affected
policy storage. Do not silently reuse an old layout or overwrite a descriptor
to change limits. A new namespace/reset starts a separate count budget; the
host must plan the transition rather than assume old and new counts combine.
See the [package migration notes](packages/rate-limit/README.md#migrating-storage-and-policy-configuration).

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
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
```

The test command starts real Azurite and verifies the durable boundary under
concurrent writes.

## License

MIT © RetireGolden, LLC
