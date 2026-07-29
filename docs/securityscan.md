# Security Scan — rate-limit

Date: 2026-07-28
Scope: Repository-wide security review (source, tests, scripts, CI/CD workflows, configuration).
Method: Manual code review against the threat model in AGENTS.md (fail-closed, read-only refusal, tier separation, no DDoS/middleware scope creep).

Findings are appended as they are discovered during the scan.

## Findings

### 1. Memory tier: unbounded map growth within a window under unique-key spray

- **Severity:** Medium
- **File:** `packages/rate-limit/src/memory.ts` (lines 16, 32, 68–71)
- **Evidence:** The `hits` Map is only pruned when `hits.size > PRUNE_THRESHOLD` **and** `now >= nextPruneAt`. After the first prune, `nextPruneAt` is set to `now + policy.windowMs`, so no further prune can run for a full window. An attacker who influences the limiter key (e.g. spoofed source identifiers) can submit an arbitrary number of distinct keys within one window; each allowed check appends a new Map entry, and none are removed until the window elapses. Growth is bounded only by request volume, not by `PRUNE_THRESHOLD`.
- **Exploitability:** Requires the host to derive keys from attacker-controlled input (the documented use case — the memory tier is an abuse dampener keyed on subjects like IPs). A single client rotating keys can inflate per-instance memory linearly with request count inside one window. Impact is per-instance memory pressure / eventual OOM on long windows with high volume. No confidentiality or integrity impact.
- **Notes:** Per-instance scope limits blast radius; the durable tier is unaffected. A size-capped eviction (e.g. prune immediately when far past threshold regardless of `nextPruneAt`, or evict oldest keys) would bound memory. Reported for host awareness; not fixed per scan-only instructions.

### 2. Known vulnerabilities in devDependency tree (azurite, test-only)

- **Severity:** High (in advisory terms) / Low (effective, dev-only)
- **File:** `package.json` (line 31), `package-lock.json`
- **Evidence:** `npm audit` reports 12 vulnerabilities (5 high, 7 moderate, 0 critical), every one reachable only through the direct devDependency `azurite@3.36.0`:
  - **brace-expansion ≤5.0.7** — GHSA-mh99-v99m-4gvg, DoS via unbounded expansion (CVSS 7.5, high), via minimatch → glob → rimraf → azurite.
  - **uuid <11.1.1** — GHSA-w5hq-g745-h8pq, missing buffer bounds check in v3/v5/v6 (moderate), via @azure/ms-rest-js and sequelize → azurite.
  - **@opentelemetry/core <2.8.0** — GHSA-8988-4f7v-96qf, unbounded memory allocation in W3C Baggage propagation (moderate), via applicationinsights → azurite.
- **Exploitability:** None of these packages ship to consumers: the published tarball is allowlisted to `dist/**` plus README/LICENSE (`packages/rate-limit/package.json` lines 11–16), and the only runtime dependencies are the exact-pinned `@pegma/spine@0.1.1` and `@pegma/storage-core@0.3.0`, which have zero reported vulnerabilities. Exposure is limited to the local/CI test environment where Azurite binds 127.0.0.1 (`test/azurite.ts` lines 108–121). The brace-expansion DoS would require a hostile glob pattern reaching azurite's rimraf usage — not attacker-reachable in this repo's test harness.
- **Notes:** `npm audit fix` offers no non-breaking remediation; the flagged fix (azurite 3.33.0) is a downgrade. Track upstream azurite releases and bump the devDependency when a clean tree is available. No action required for published-package security.

### 3. No length cap on rate-limit keys

- **Severity:** Low
- **File:** `packages/rate-limit/src/policy.ts` (lines 80–87), `packages/rate-limit/src/memory.ts` (line 31)
- **Evidence:** `assertRateLimitKey` validates type, non-blankness, and Unicode well-formedness, but imposes no maximum length. The memory tier stores the raw key string as a Map key, so an attacker submitting multi-megabyte keys multiplies the per-entry memory cost of Finding 1.
- **Exploitability:** Same precondition as Finding 1 (attacker-influenced keys). Long keys must pass through the host's own request handling first, which typically imposes its own limits, so this is an amplifier rather than a standalone vector. The durable tier is unaffected: keys are SHA-256 hashed before storage (`durable.ts` lines 105–112), so stored identifiers are fixed-length regardless of key size.
- **Notes:** A documented maximum (e.g. a few hundred bytes) rejected at `assertRateLimitKey` would close this at negligible cost.

## Informational (not vulnerabilities)

- **Azurite emulator credential in tests.** `packages/rate-limit/src/durable.test.ts` lines 20–24 contain the well-known public Azure Storage emulator account key (`devstoreaccount1` / `Eby8vdM02x...`). This value is published in Microsoft's own documentation, grants access only to a local emulator instance bound to 127.0.0.1 (`test/azurite.ts`), and is not a secret. No action.
- **Fixed-window boundary burst.** The durable tier can admit up to ~2× the limit across a window boundary. This is inherent to fixed-window counting, is explicitly documented in the `createDurableLimiter` docblock (`durable.ts` lines 173–180), and matches the advertised design. No action.
- **Cached partition-hash rejection.** If the first `crypto.subtle.digest` call rejects, the rejected `partitionPromise` is cached and every subsequent `allow`/`sweep` fails closed permanently (`durable.ts` lines 190–198). This is the mandated fail-closed behavior, not a fail-open path. No action.

## Areas verified strong (no findings)

- **Fail-closed semantics.** Storage outage, contention-retry exhaustion, malformed clock output, and malformed stored records all deny with a retry-after (`durable.ts` lines 120–136, 259–266; `memory.ts` lines 52–55; `policy.ts` lines 89–106). No fail-open option exists, per AGENTS.md.
- **Read-only refusal path.** Over-limit decisions return `{ action: "keep" }` from the update decider — no write on the hot refusal path (`durable.ts` lines 233–245).
- **Counting inside deciders.** All durable increments go through `collection.update` deciders re-run against fresh state with bounded `maxAttempts`; sweeps use versioned `deleteIfUnchanged`. No read-then-write races.
- **Tier separation.** `memory.ts` imports nothing from the durable/storage surface; durable-tier types do not leak into it. Key validation is shared only through `policy.ts`.
- **Stored-data minimization.** Subject keys are SHA-256 hashed with a versioned, policy-scoped domain separator before storage (`durable.ts` lines 81–112); raw identifiers never reach the store. Malformed rows are retained rather than risk-matched to a reconstructed key during sweep (`durable.ts` lines 285–293).
- **Release supply chain.** OIDC trusted publishing with no token fallback, provenance, exact dependency pins enforced by `scripts/release-package.mjs`, signed annotated tag verification against an allowed-signers file, tarball hash re-verification with `timingSafeEqual`, dist-only publish allowlist, smoke test with `--ignore-scripts`, and all third-party GitHub Actions pinned by commit SHA (`.github/workflows/publish.yml`, `.github/workflows/ci.yml`).
- **Workflow injection hygiene.** Event data reaches shell only through environment variables (`RELEASE_TAG`, `RELEASE_COMMIT`), never through inline `${{ }}` interpolation in `run:` blocks; tag and commit formats are regex-validated before use (`release-package.mjs` lines 221–230). Top-level workflow permissions are `contents: read`; `id-token: write` is scoped to the protected `npm-publish` environment job only.
- **Secret hygiene.** Repository-wide scan for credentials, tokens, and private keys found only the public Azurite emulator key (see Informational). `.gitignore` excludes `.env*`, `.release*/`, `dist/`, and `*.tsbuildinfo`; `git ls-files` confirms no build output or environment files are tracked (30 tracked files).

## Summary

| # | Finding | Severity | Exploitability |
|---|---------|----------|----------------|
| 1 | Memory tier: unbounded map growth within a window under unique-key spray | Medium | Attacker-influenced keys; per-instance memory DoS |
| 2 | Known vulnerabilities in devDependency tree (azurite, test-only) | High (advisory) / Low (effective) | Not reachable in published package or test harness |
| 3 | No length cap on rate-limit keys | Low | Amplifier for #1 |

No critical or exploitable-in-production vulnerabilities were found. The two hardening opportunities (Findings 1 and 3) both concern bounding per-instance memory in the memory tier when hosts derive keys from attacker-controlled input.
