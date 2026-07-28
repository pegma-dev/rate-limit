# Rate Limit Project Plan

## Status

**Stage:** implemented through Phase 2, package-name bootstrap pending
(`0.0.0`, public API unstable, unpublished)

**First named consumers:** Pegma Identity requires durable throttling on its
abuse-critical authentication operations, and the Pegma support desk requires
"rate and size limits" plus sender and domain throttling. Identity's
prerequisite build triggered Phases 1–2. Neither consumer is wired yet.

**Reference implementation:** the in-memory sliding-window limiter in
RetireGolden's account API (`api/src/lib/http.js`), documented in that
application's threat model as a per-instance abuse dampener — a framing this
component keeps.

**License:** MIT

**Storage:** the in-memory tier depends only on `@pegma/spine` (`Clock`). The
durable tier declares one collection over an injected `@pegma/storage-core`
`Store`. Dependencies pinned exactly.

## Vision

Every public endpoint eventually needs a limiter, and every hand-rolled one
misrepresents itself. The in-memory kind quietly becomes per-instance the day
the host scales out, while its adopter still believes the limit is global.
The distributed kind hides a read-modify-write on the hottest keys in the
system and bills the latency to every request. Both are legitimate tools;
the failure mode is not the mechanism but the false advertising.

One rate-limit component with **two explicitly named tiers** — approximate
and strict — where choosing is mandatory, the trade is stated at the call
site, and neither tier pretends to be the other.

## Problem statement

A rate limiter answers "may this key proceed right now?" — but the question
hides a consistency choice:

1. **Approximate is usually enough.** Abuse dampening, per-IP throttles on
   cheap endpoints, "slow down" ergonomics: a per-instance in-memory window
   answers in nanoseconds, and being N× generous under N instances is an
   accepted, stated property. This covers most endpoints.
2. **Some operations need the limit to be true.** Login attempts, checkout
   creation, outbound sender throttling: low-rate, expensive or
   abuse-critical, and per-key correctness across instances actually
   matters. That requires shared state — and shared state on a request path
   has a price that must be paid knowingly.
3. **The hot-key trap.** The tempting design — a durable counter incremented
   by compare-and-swap — puts a conditional write with retry-on-conflict on
   exactly the keys under attack, which is when contention is worst. A
   limiter that degrades hardest while being hammered is guarding the door
   by lying down in it.

## Core model

### Two tiers, one vocabulary

Both tiers implement one port: `allow(key, now?) → { allowed, retryAfter? }`
against a named **policy** (limit, window). What differs — and is never
hidden — is the consistency claim:

- **`createMemoryLimiter(policy)`** — sliding window over a spine `Clock`,
  per-process state. The contract states in its name and docs: per-instance,
  approximate under scale-out, zero I/O. The reference implementation,
  extracted nearly verbatim.
- **`createDurableLimiter(policy, store)`** — a fixed-window counter record
  per (policy, key, window-start), maintained with storage-core `update`
  deciders, plus a versioned sweep for stale windows. Strict-ish (see design
  decisions), one storage round trip per check — a cost meant for endpoints
  whose work dwarfs it.

### Keys and policies

Keys are host-chosen opaque strings (an IP, a principal, a sender domain).
Policies are named so a host's limiter wiring reads as configuration
(`login: 10/5min strict`, `api: 60/5min approximate`) and so the durable
tier's records partition by policy name.

## Design decisions

### Choosing a tier is mandatory and visible

There is no default limiter and no auto-upgrading. The component's API makes
the host write `memory` or `durable` at the composition root, because the
difference is a correctness property the adopter must own. The most damaging
thing this component could do is let someone believe a per-instance window
is a global quota — the README leads with that.

### The durable tier is fixed-window, and says so

Sliding windows over shared storage need per-hit records or log-structured
counters — write amplification out of proportion to the job. A fixed window
(one counter record per key per window) is one decider-mediated increment,
and its known edge (a burst straddling a window boundary can pass ~2× the
limit briefly) is documented rather than engineered away. Hosts needing
smoother enforcement lower the limit; the component does not pretend
otherwise.

### Contention is bounded, not denied

On a conflict storm the durable tier's decider re-runs against fresh state —
correct but costly, precisely under attack. Two mitigations, both honest:
the decider short-circuits once the freshly read count is already over the
limit (a refusal needs no write — over-limit checks become read-only, so the
system under heaviest attack does the least work), and retry attempts are
bounded, failing **closed** (deny with retry-after) past the bound. A
limiter's availability failure mode must be "too strict," never "wide open."

### Failing closed is the storage-outage posture too

If the store is unreachable, the durable tier denies. A host that would
rather fail open on an outage wraps the call and owns that decision in its
own code, where its reviewers can see it — the component will not make
fail-open reachable by configuration.

### Time is injected

Both tiers take a spine `Clock`; window arithmetic is pure and testable. The
durable tier never trusts a stored timestamp it did not compute. Malformed
records fail closed and are retained by sweeps. Storage-core listings do not
return actual row keys, so pairing any malformed row's version with a key
reconstructed from its payload could delete another row. Sweeps remove only
structurally valid, expired records.

### This is an application limiter, not DDoS protection

Volumetric attacks are settled at the CDN/edge before requests cost compute.
This component assumes the request has already paid to arrive and decides
whether the _application_ will do work for it. Stated as a non-goal because
adopters conflate the two, and the conflation is dangerous in the flattering
direction.

## Scope

### In scope

- The shared port, named policies, and both tiers.
- Retry-after arithmetic callers can surface (HTTP 429, mail deferral).
- Versioned sweep of stale durable windows.
- Tests over memory and against real Azurite (per ecosystem rule),
  including the contention cases: concurrent increments at the limit
  boundary, over-limit read-only refusal, bounded-retry fail-closed.

### Non-goals

- **A global strict limiter for hot, cheap endpoints.** That workload
  belongs to the approximate tier or the edge; the durable tier's docs say
  which endpoints it is for (low-rate, expensive, abuse-critical).
- **DDoS / volumetric protection** (above).
- **Distributed sliding windows, token buckets with shared refill, GCRA.**
  Real algorithms, wrong cost profile for storage-core's primitives; a
  Redis-shaped adapter could carry them someday if a consumer materializes —
  not speculatively.
- **HTTP middleware, framework bindings.** Hosts own their surfaces.
- **Quota/billing metering.** "May this proceed" is not "how much was used";
  metering has audit and durability needs a limiter should not carry.

## Package architecture

One package: `packages/rate-limit` publishing `@pegma/rate-limit`.
Dependencies: `@pegma/spine`; `@pegma/storage-core` (the durable tier's
collection over an injected Store). The memory tier must remain importable
without a Store — a host wanting only abuse-dampening should not construct
storage. TypeScript, vitest, the ecosystem's standard layout.

## Delivery phases

### Phase 1 — port and memory tier

The shared port, named policies, and `createMemoryLimiter` extracted from
the reference implementation. Small on purpose; exists so consumers code
against the port from day one.

**Complete.** The memory-only export is storage-free, the tier is named at the
composition root, and sliding-window and retry-after behavior are covered.

### Phase 2 — durable tier

`createDurableLimiter` with the decider-mediated counter, read-only
over-limit refusal, bounded fail-closed retries, and the sweep. Contention
tests against real Azurite are the exit bar.

**Complete.** The fixed-window implementation fails closed for storage,
contention, malformed-record, and malformed-time failures. The suite exercises
memory storage and real Azurite, including concurrent boundary enforcement,
read-only over-limit refusal, bounded retries, and versioned stale-window
sweeps.

### Phase 3 — first consumer

The support desk wires both tiers: approximate on its public read surface,
durable on ticket creation and sender/domain throttling (its inbound-abuse
requirements). RetireGolden's account API may swap its `http.js` limiter for
the memory tier in the same season — a nicety, not a driver. Exit: the
tier-choice ergonomics judged by a real composition root.

### Phase 4 — publish

First public `0.x` with the ecosystem's publishing wave.

## Open questions

**Sender/domain throttling shape.** Support desk throttles _senders_ — keys
with natural hierarchy (address within domain). Is that two policies over
two keys (lean: yes, simple) or one hierarchical policy (probably
over-design)? Decide against the real Phase 3 requirement.

**Batched approximate sync.** A middle tier — in-memory counting with
periodic durable reconciliation — buys near-global accuracy at near-zero
request cost, at real complexity. Lean **no** until a consumer demonstrates
the two shipped tiers genuinely bracket a gap.

**Refusal observability.** Refusals are operationally interesting (attack
onset). A spine `Logger` line per refusal could itself become hot-path load
under attack. Lean: counters surfaced periodically, not per-event logging.
**Resolved in Phase 2:** the limiter does not log. The decision is returned to
the host, which can aggregate observations at the composition boundary without
making per-refusal logging part of this hot-path contract.

## Near-term backlog

1. Wire the durable tier into Pegma Identity's abuse-critical operations and
   judge the composition-root API against that real consumer.
2. Wire both tiers into the support desk: memory for public reads, durable for
   ticket creation and sender/domain throttling.
3. Complete the audited manual `0.0.0` package-name bootstrap under the
   non-default `bootstrap` npm tag, then configure trusted publishing.
4. After consumer validation, use a separate version PR and the signed-tag
   OIDC workflow for the first advertised `0.1.0` release.
