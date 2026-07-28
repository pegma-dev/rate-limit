# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Rate Limit is the request-limiting component of **Pegma**, a family of
MIT-licensed packages a host application composes. Shared contracts live in
`@pegma/spine`; persistence in `@pegma/storage-core`. They publish under the
`@pegma` scope, one repository per component. The exact reviewed `0.0.0`
package-name bootstrap remains isolated under the `bootstrap` dist-tag.
`@pegma/rate-limit@0.1.0` is the first advertised release, published through
the protected signed-tag OIDC workflow with provenance. The shared port and
both named tiers are implemented, and pegma.dev is the durable tier's first
production consumer.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

## Hard rules

**Never blur the tiers.** The memory tier is per-instance and approximate;
the durable tier is fixed-window over shared storage. No default limiter, no
auto-upgrade, no wording that lets an adopter believe a per-instance window
is a global quota. Tier choice is written by the host at the composition
root, always.

**Everything fails closed.** Contention-retry exhaustion, storage outage,
malformed records — every failure denies with a retry-after. Do not add a
fail-open option; a host wanting fail-open wraps the call in its own code
where its reviewers can see it.

**Over-limit refusals are read-only.** Once the freshly read count is at or
past the limit, refuse without writing. The component must do its least work
under its heaviest attack — a change that adds a write to the refusal path
inverts that.

**Counting runs inside deciders.** Durable increments go through `update`
deciders re-run against fresh state; sweeps use versioned conditional
deletes. A read-then-write around the store races exactly when it matters.

**The memory tier stays storage-free.** It must remain importable and
constructible without a Store. Do not let durable-tier types leak into its
surface.

**This is not DDoS protection, middleware, or metering.** Volumetric defense
belongs to the edge; HTTP bindings belong to hosts; usage metering has audit
needs a limiter must not carry. Refuse all three regardless of how small the
request looks.

**Test against the real backend, including contention.** The durable suite
runs against real Azurite, and the contention cases — concurrent increments
at the boundary, read-only refusal, bounded-retry fail-closed — are the
specification.

## Reference implementation

The memory tier is extracted from the sliding-window limiter in
`api/src/lib/http.js` of the RetireGolden account API, whose threat model
frames it honestly as a per-instance abuse dampener. That framing is
precedent.
