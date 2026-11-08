# `@pegma/rate-limit`

Two explicitly named application rate-limit tiers:

- `createMemoryLimiter` is a per-instance sliding window with zero I/O. It is
  approximate under scale-out.
- `createDurableLimiter` is a shared fixed-window counter over an injected
  `@pegma/storage-core` `Store`. It is for low-rate, expensive or
  abuse-critical operations.

> [!IMPORTANT]
> Current source is the **unpublished `0.3.3` candidate**. Registry `latest`
> is `0.3.2`: original-byte and npm cryptographic checks passed, but strict
> postflight failed the authenticated builder-identity policy. It is not
> qualified for the planned helper adoption. `0.1.0` was the first advertised
> release, published through trusted-publisher OIDC with provenance. The exact reviewed `0.0.0`
> package-name bootstrap remains isolated under the `bootstrap` dist-tag and
> is never advertised as the current supported release.

The API and storage behavior below describe `0.3.3` candidate source; the
limiter/helper API is unchanged from `0.3.2`. Use an exact published version
only after its release verification and an explicit host storage/configuration
transition.

The signed `v0.3.0` tag and GitHub release exist, but preparation failed before
packing: no release artifact or npm `0.3.0` bytes were published. Signed
`v0.3.1` fixed checkout trust and passed its gates and pack, but upload excluded
hidden `.release/`, retained zero artifacts, and skipped smoke/publication.
There is no npm `0.3.1` release. `0.3.2` corrected artifact discovery and published
the original prepared bytes, but its authenticated provenance names
`https://github.com/actions/runner/undefined`; strict postflight failed despite
successful npm cryptographic checks and an idempotent publisher retry. The
`0.3.3` candidate preserves nonsecret runner metadata and requires
`github-hosted` before isolated npm calls. The immutable history is recorded in
[release operations](https://github.com/pegma-dev/rate-limit/blob/main/docs/RELEASING.md).
No host should pin a new helper alias until actual `0.3.3` publication and
exact-artifact verification. Existing Identity/Support `0.2.0` composition and
legacy counter storage remain separate from that adoption.

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
axes. It tracks at most 10,000 keys at once. Both tiers accept keys of at most
512 UTF-16 code units; the bound is checked before trimming, Unicode scanning,
or durable hashing. An astral symbol such as an emoji counts two. A longer key
is rejected as invalid. When the key cap is reached and no tracked key has
expired yet, a check for a key that is not already tracked fails closed with
`retryAfter` instead of growing the map. Keys already tracked keep their own
counts and are never evicted, so a spray of unique keys can neither exhaust
host memory nor reset another subject's window.

Expired keys are reclaimed as soon as they expire: the reclaim scan is aimed at
the moment the earliest tracked entry becomes reclaimable, so capacity returns
within 50 ms of a spray ageing out however long the window is. That 50 ms is a
floor on how often the scan may run, which is what keeps its cost amortized
constant while the cap is held.

The tracked-key count bound is specific to this tier. The shared key-length
bound also limits work before the durable tier creates a fixed-length hash.

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
  { maxClockSkewMs: 60_000 },
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

Each policy partition also has an immutable descriptor binding its hashed name
to `limit` and `windowMs`, and every counter repeats those two values. A limiter
revalidates the descriptor before counter writes and sweeps. Missing or
conflicting settings fail closed without rewriting the descriptor or counter.
Change either setting under a versioned policy name during a rolling deployment,
or coordinate a store reset before reusing the name.

The durable tier uses fixed windows. A burst across a boundary can briefly
admit nearly twice the limit. It also puts shared-storage latency on every
allowed check; do not use it for hot, cheap endpoints.

The existing `limiter.sweep()` lists one policy partition and deletes structurally valid expired rows
only if their versions are unchanged. By default a row remains for 60 seconds
after its window ends; `maxClockSkewMs` can set a different bounded,
non-negative grace for hosts with a known clock envelope. Malformed rows are retained:
that partition-listing API does not expose actual row keys, so pairing a malformed
row's version with a key reconstructed from its payload could target another
row. Checks against that malformed row still fail closed.

## Bounded global cleanup

The global helper exposes this interface at the root and durable subpath, defined
in
[the actual source](https://github.com/pegma-dev/rate-limit/blob/main/packages/rate-limit/src/durable.ts):

```ts
export declare function sweepDurableWindowsPage(
  store: Store,
  options: DurableWindowsSweepOptions,
): Promise<DurableWindowsSweepPage>;
```

`options.limit` is required: a safe integer from 1 through Storage Core's
`MAX_SCAN_PAGE_SIZE` (1,000). Other options are an opaque nonempty `cursor`,
an optional Spine `clock`, and non-negative safe-integer `maxClockSkewMs`.
The result is `{ scanned: number, deleted: number, nextCursor: string | null }`.
This is a source API signature, not an execution example or publication receipt.

One call scans one global physical page of `rate-limit-windows`, without a
policy filter, partition enumeration, `list`, or `listVersioned`. `scanned`
counts every adapter-returned row before filtering, even descriptors, unknown
legacy layouts, malformed stored payloads, and policies the current host no
longer constructs. A nonconforming adapter page/row envelope rejects instead
of being treated as a malformed stored payload to skip. Physical page
validation runs before descriptor reads or deletes. There are at most `limit`
fresh descriptor reads and `limit` `deleteIfUnchanged` calls.

Those calls run sequentially. These are row/call bounds, with no wall-clock or
deadline guarantee. Hosts should choose a small page limit using the real
provider's storage latency, execution-time and subrequest budgets.

Deletion requires a structurally valid new-format `window` with valid hashes,
canonical window ID, aligned start, count within its stored limit, and a safe
expiry. Its decoded partition/ID must match the actual scan key. The current
descriptor is read by that authoritative key for each candidate and must match
the exact policy kind/key/hash, descriptor null fields, `limit`, and `windowMs`.
Only the captured unchanged window version is deleted. This is conditional
maintenance, not an atomic snapshot across descriptors and windows.

Expiry is `windowStartMs + windowMs + maxClockSkewMs <= now`. The clock must
return a canonical timestamp; the sum must be a safe integer. The default
grace is 60,000 ms; explicit zero is supported. The global helper applies its
own grace to every policy it encounters, so the host chooses one that covers
its peer-clock envelope. Descriptors, legacy `0.2.0` rows, malformed windows,
unknown kinds, missing/mismatched descriptors, and changed window versions are
retained.

Persist `nextCursor` unchanged only after success, including pages with no
deletions. Null ends that cycle; it does not prove no concurrent/new rows exist.
Repeat complete cycles for ongoing hygiene. Invalid adapter envelopes and
storage or time failures reject without a completed page or new cursor;
retain the previous cursor on failure. A mid-page failure does not roll back
conditional deletions that already succeeded. Retrying from the prior cursor
can repeat reads and deletion attempts.
The helper itself does not change the already-merged memory behavior,
`allow()` admission, or the existing per-policy sweep.

## Migrating storage and policy configuration

Registry `0.2.0` is older than the descriptor and `kind`/`limit`/`windowMs`
hardening already merged on main. Sharing its version label or policy name
does not make legacy counter rows compatible with this candidate. Neither
the limiter nor global cleanup silently migrates the old layout; unknown
legacy rows remain, and malformed encountered counter state fails closed.

Select versioned policy names or a separate Store namespace for the new
configuration, or coordinate an explicit reset of the affected policy storage.
New names/namespaces and resets start independent count budgets; plan the
cutover and old-data retention rather than assuming counts carry over or add
together across deployments. The package supplies no automatic migration/reset.

Once a descriptor exists, its policy name is bound immutably to `limit` and
`windowMs`. Changing either requires another versioned name or a coordinated
reset; conflicting instances fail closed. Do not edit descriptors in place,
delete arbitrary malformed rows, or mistake the global sweep for a migration
of previously published `0.2.0` data.

A host adopting the new helper through an npm alias must wait for actual
`0.3.3` publication and strict registry verification before pinning that alias.
Existing `0.2.0` consumers and counters need their own deliberate migration;
the new release does not convert them automatically.

## License

MIT
