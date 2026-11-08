# Release operations

No package is published merely by merging a pull request. Normal releases use
the hardened GitHub release workflow, npm trusted publishing, and provenance.
The completed one-time manual `0.0.0` ceremony below exists as an audit record:
npm could not configure a trusted publisher until `@pegma/rate-limit` existed.

As of 2026-11-08, npm `latest` is `0.3.2` and historical `bootstrap` is `0.0.0`.
`0.3.2` is published with exact original bytes and successful npm cryptographic
checks, but its strict postflight **failed** the authenticated builder-identity
policy. It is not qualified for the planned helper adoption. Current source is
the **unpublished `0.3.3` candidate**. The signed `0.3.0` and `0.3.1` GitHub
releases below did not publish npm versions.

## Release invariants

The release tool verifies the exact public workspace inventory, stable package
version, exact Pegma dependency pins, matching lockfile, package metadata,
README and LICENSE, prepack build, test exclusion, dist-only allowlist, and
exports. Preparation builds once and checks the complete file inventory and
hashes; the separate smoke job imports every export from a clean consumer
installation.

The prepared `package-manifest.json` records the source commit, optional
release tag, tarball filename, SHA-256, SHA-512 integrity, and packed files.
`release:registry:check` revalidates those local bytes before comparing their
exact integrity with npm. Only npm `E404` means `absent`; an existing different
artifact or another registry failure stops the ceremony.

Normal preparation authenticates the stable signed tag in a temporary bare
repository before checkout. The packing checkout must also configure the same
approved SSH allowed-signers trust before the release tool independently checks
the signed tag; trust scoped to the temporary bare repository is not inherited.
Current preparation writes, hashes and uploads the same nonhidden
`${RUNNER_TEMP}/rate-limit-prepared` directory, with `include-hidden-files: false`.
The resulting artifact contains exactly two
regular files: the manifest and its named tarball. Consumer installation runs
in a separate job without publication authority. The environment-protected
OIDC job checks the tag again, downloads the sealed artifact outside a source
checkout, verifies the preparation manifest digest and both tarball digests,
and invokes npm from a fresh directory with empty configuration files and an
allowlisted environment. It never executes repository code.
The `0.3.3` candidate preserves the nonsecret `RUNNER_ENVIRONMENT` value and
requires `github-hosted` before invoking npm in that isolated environment.

<a id="failed-030-preparation-and-031-candidate"></a>

## Failed `0.3.0` preparation

Protected signed annotated
[`v0.3.0`](https://github.com/pegma-dev/rate-limit/releases/tag/v0.3.0), tag object
`9df80b019b8ed6e5b7fc0f5a8c7359ae4cae6486`, points to reviewed source
[`93c7a4207d493e10568b797bf7d5a402f446cc70`](https://github.com/pegma-dev/rate-limit/commit/93c7a4207d493e10568b797bf7d5a402f446cc70).
Its GitHub release triggered
[run `42501172611`](https://github.com/pegma-dev/rate-limit/actions/runs/42501172611),
whose [preparation job `128794037936`](https://github.com/pegma-dev/rate-limit/actions/runs/42501172611/job/128794037936)
failed before packing. There is no prepared manifest/tarball artifact from that
run and no npm `0.3.0` publication.

The temporary bare repository had the approved SSH allowed-signers trust, but
the separate packing checkout did not. The release tool's independent tag
verification therefore failed there. This was a checkout trust-configuration
failure, not evidence that the protected signed tag was invalid.

Preserve the `v0.3.0` tag object, source commit, GitHub release and failed-run
record. Never move or replace that tag, reuse its version for changed source,
or treat the failed preparation as publication. The correction used reviewed
`0.3.1` source and a new protected signed `v0.3.1` identity after merge. It
added explicit trust to the packing checkout without changing limiter/helper
behavior. Its later failure was a separate upload boundary, recorded next.

<a id="failed-031-upload-and-032-candidate"></a>

## Failed `0.3.1` upload

The signed annotated
[`v0.3.1` release](https://github.com/pegma-dev/rate-limit/releases/tag/v0.3.1),
tag object `0b44be7a99771e92f5defc34ca408917c403f526`, points to reviewed source
[`b2f15e4a2a2937894ad90b623fee8914ba13ca31`](https://github.com/pegma-dev/rate-limit/commit/b2f15e4a2a2937894ad90b623fee8914ba13ca31).
[Run `42510458896`](https://github.com/pegma-dev/rate-limit/actions/runs/42510458896),
attempt 1, failed in
[prepare job `128822182349`](https://github.com/pegma-dev/rate-limit/actions/runs/42510458896/job/128822182349)
on 2026-11-08. Tag authentication, the checkout signing-trust helper, repository
gates, and preparation/sealing all passed. The packer produced its manifest and
tarball in the checkout's workspace-relative `.release/` directory.

Upload then failed at **2026-11-08T18:32:14Z**: its path was `.release/`, while
`include-hidden-files: false` excluded that hidden directory. Discovery found
zero files and upload failed closed. The run's artifacts API reports zero
retained artifacts; smoke and publish were skipped. The successful runner-local
pack is not a downloadable, independently verified release artifact. No npm
`0.3.1` publication occurred.

Preserve the signed `v0.3.1` tag, source and failed-run record alongside the
earlier `v0.3.0` history. Do not replace a tag, reuse either version for changed
source, or treat a GitHub release as npm availability.

`0.3.2` kept the limiter/helper API and signing correction unchanged. Its
producer used explicit `--output` at the nonhidden
`${RUNNER_TEMP}/rate-limit-prepared` directory, computed the manifest digest
there, and uploaded that same directory through `${{ runner.temp }}`. Hidden-file
exclusion remains enabled (`include-hidden-files: false`); recovery does not
broaden artifact collection.
Validate the actual YAML producer/digest/upload wiring and file discovery with
the pinned `@actions/glob@0.5.0` regression. The pinned upload action's
[package lock](https://github.com/actions/upload-artifact/blob/330a01c490aca151604b8cf639adc76d48f6c5d4/package-lock.json)
records that version with the same integrity as the
[registry artifact](https://registry.npmjs.org/@actions%2fglob/0.5.0).
Its [search implementation](https://github.com/actions/upload-artifact/blob/330a01c490aca151604b8cf639adc76d48f6c5d4/src/shared/search.ts)
defines the glob options and directory filtering used by the
[regression](../scripts/release-artifact-discovery.test.mjs). The test exercises
that public glob API and filtering only; it does not execute the vendored action
bundle or upload bytes. The resulting `0.3.2` publication had the separate
provenance-policy failure recorded next.

## Published `0.3.2` with failed strict postflight

The [`v0.3.2` release](https://github.com/pegma-dev/rate-limit/releases/tag/v0.3.2)
binds signed source
[`a50469dce0c123865ef3540819060509a936ec38`](https://github.com/pegma-dev/rate-limit/commit/a50469dce0c123865ef3540819060509a936ec38).
[Run `42515823225`](https://github.com/pegma-dev/rate-limit/actions/runs/42515823225)
attempt 1 executed
[preparation `128838497494`](https://github.com/pegma-dev/rate-limit/actions/runs/42515823225/job/128838497494)
and [isolated smoke `128838619041`](https://github.com/pegma-dev/rate-limit/actions/runs/42515823225/job/128838619041).
Original artifact `13631327333` contains the sealed manifest and tarball; its
tarball SHA-256 is
`1bc74d4a7f5ca239bbee80097a815bbe3ae04f45eb60cc40bd53499139422802`.
The [first publisher](https://github.com/pegma-dev/rate-limit/actions/runs/42515823225/job/128838677268)
published but failed waiting for registry visibility. The
[attempt-2 publisher `128841340300`](https://github.com/pegma-dev/rate-limit/actions/runs/42515823225/job/128841340300)
later completed idempotently using that **same original artifact**. Preparation
and smoke were not executed again; carried-forward attempt-2 job aliases are
not fresh pack or consumer proof.

Registry metadata and downloaded `0.3.2` tarball bytes match the original
artifact. Actual npm `11.18.0` ECDSA signature and Sigstore verification passed.
The authenticated SLSA provenance also matches the repository, source commit,
release tag and original attempt-1 invocation. Its builder URI, however, is
`https://github.com/actions/runner/undefined`, rather than the required
`https://github.com/actions/runner/github-hosted`. Strict postflight therefore
remains **FAILED**, despite publication and a successful workflow retry.
Cryptographic validity does not waive the authenticated-claims policy.
Checks downstream of that failure, including strict postflight's consumer
execution, did not complete; the earlier preparation smoke remains separate.

The immutable
[`0.3.2` publisher environment filter](https://github.com/pegma-dev/rate-limit/blob/a50469dce0c123865ef3540819060509a936ec38/.github/workflows/publish.yml#L396)
did not preserve `RUNNER_ENVIRONMENT` for npm. The reviewed
[`npm@11.18.0` provenance generator](https://github.com/npm/cli/blob/v11.18.0/workspaces/libnpmpublish/lib/provenance.js#L58)
uses that value to construct the builder URI. These source facts explain the
observed missing runner metadata; they do not turn the failed proof into a pass.
They do not establish that the actual runner was self-hosted or untrusted.

## `0.3.3` provenance-metadata candidate

Current source preserves the nonsecret `RUNNER_ENVIRONMENT` value in the
isolated npm environment and refuses to invoke that publisher's npm commands
unless it is `github-hosted`. The limiter and maintenance-helper API are
unchanged. Its own review, current-head Node 22/24 gates, new protected signed
release identity, retained exact artifact, isolated smoke, publication and
strict postflight remain pending.

Hosts must await verified `0.3.3` publication before pinning the new helper,
including through an alias. Existing Identity/Support `0.2.0` imports and
counters remain unchanged until an explicit host transition. Preserve all
`0.3.0`, `0.3.1` and `0.3.2` tags, releases, artifacts and failure receipts.
Do not weaken the builder policy, move a tag, unpublish/reuse a version, repeat
bootstrap or add a token fallback to recover.

## One-time `0.0.0` package-name bootstrap

**Complete; do not repeat.** The exact reviewed `0.0.0` artifact was published
under `bootstrap`, its signed annotated source tag points to the reviewed
`origin/main` commit, and npm trusted publishing is configured for
`pegma-dev/rate-limit`, `publish.yml`, and the `npm-publish` environment.

During bootstrap npm also assigned the default `latest` tag to `0.0.0`. The operator attempted
to remove it, but npm rejected the request with HTTP 400. The immutable
bootstrap remains exact and the `bootstrap` tag remains correct. The later
normal `0.1.0` publication moved `latest` to the first advertised version;
`latest` has since advanced to published `0.3.2`, whose strict-postflight
limitation is recorded above.

The steps below are retained only as the ceremony's audit and recovery record.

### 1. Prepare the reviewed bytes

From a clean checkout of the exact reviewed `origin/main` commit, use Node 24
and the reviewed npm version:

```sh
git fetch origin
git switch --detach origin/main
npm install --global npm@11.18.0
npm ci
npm run format:check
npm run check
npm test
npm run release:pack -- -- --require-clean --require-main-ancestor --output .release
npm run release:registry:check -- -- --manifest .release/package-manifest.json
```

The registry check must report:

```text
@pegma/rate-limit@0.0.0: absent
```

Preserve the complete `.release` directory until bootstrap finishes. The
reviewed artifact is exactly `.release/pegma-rate-limit-0.0.0.tgz`; do not
repack it between review, tagging, and publication.

### 2. Create the protected signed source tag

Ensure the repository's `v*` tag ruleset prevents updates and deletion and
restricts creation to the release maintainer. Configure the approved SSH
signing key, then create a signed annotated source tag:

```sh
git config gpg.format ssh
git config user.signingkey ~/.ssh/pegma-release-signing-key
git config gpg.ssh.allowedSignersFile ~/.config/pegma/release-allowed-signers
git tag --sign v0.0.0 --message "Rate Limit bootstrap v0.0.0" HEAD
git verify-tag v0.0.0
git rev-parse HEAD
git rev-parse "v0.0.0^{commit}"
git push origin refs/tags/v0.0.0
git fetch origin tag v0.0.0 --force
git verify-tag v0.0.0
```

Both commit IDs must equal the `gitCommit` recorded in
`.release/package-manifest.json`. Never move, replace, or delete the tag.

### 3. Publish only the reviewed tarball under `bootstrap`

Authenticate the human npm operator using npm's current interactive login
requirements. Publish the already-reviewed file:

```sh
npm publish .release/pegma-rate-limit-0.0.0.tgz --access public --tag bootstrap
npm run release:registry:check -- -- --manifest .release/package-manifest.json
```

The second command must report:

```text
@pegma/rate-limit@0.0.0: exact
```

If the command reports different integrity or a registry error, stop. If a
workstation failure requires reconstructing the artifact, use the same clean
tagged checkout and reviewed npm version, repack, and require `exact` before
continuing. Never unpublish and reuse a version.

The intended post-bootstrap check was:

```sh
npm dist-tag ls @pegma/rate-limit
```

`bootstrap` points to `0.0.0`. npm unexpectedly also made `latest` point to
`0.0.0` and rejected its removal with HTTP 400; do not retry destructive
registry changes. The later `0.1.0` publication corrected that default tag.

### 4. Configure trusted publishing

After the package name exists, configure this publisher on npmjs.com:

- organization or user: `pegma-dev`
- repository: `rate-limit`
- workflow: `publish.yml`
- environment: `npm-publish`
- allowed action: `npm publish` only

Create the matching GitHub `npm-publish` environment. Set the repository
Actions variable `RELEASE_ALLOWED_SIGNERS` to the reviewed SSH allowed-signers
entry for the maintainer's release key. This is public-key material, not a
secret. Do not add `NODE_AUTH_TOKEN`, an npm automation token, or another
credential fallback.

The workflow intentionally rejects `0.0.0`; its first permitted release is
`0.1.0`.

## First advertised `0.1.0` release

**Complete; historical ceremony.** The separate reviewed release pull request
was required to:

1. change `packages/rate-limit/package.json` from `0.0.0` to `0.1.0`;
2. regenerate `pnpm-lock.yaml` and verify its workspace importer pins `0.1.0`;
3. update README and plan status with the advertised release notes; and
4. pass the full gate and release pack smoke on Node 22 and 24.

After that pull request merged, the protected signed annotated `v0.1.0` tag
and GitHub release were created at the exact `origin/main` commit. These
commands are retained as the historical ceremony, not instructions to repeat it:

```sh
git fetch origin
git switch --detach origin/main
git tag --sign v0.1.0 --message "Rate Limit v0.1.0" HEAD
git verify-tag v0.1.0
git push origin refs/tags/v0.1.0
git fetch origin tag v0.1.0 --force
git verify-tag v0.1.0
gh release create v0.1.0 --verify-tag --title "v0.1.0"
```

The unprivileged preparation job checks the signed tag, release-event commit,
main ancestry, full gate, tarball inventory, and hashes. A second unprivileged
job imports the sealed tarball from a clean consumer installation. Only the
environment-scoped publish job receives OIDC authority; it checks the tag and
artifact again, installs no dependencies, and publishes the downloaded
prepared artifact with provenance. Re-running is safe only when npm reports
the same integrity.

After publication, select the one successful `publish.yml` release run for
the exact signed tag commit, confirm the run names that tag and commit, and
download its uniquely named prepared artifact before checking registry
integrity:

```sh
release_tag=v0.1.0
release_commit="$(git rev-parse "${release_tag}^{commit}")"
run_id="$(
  gh run list \
    --repo pegma-dev/rate-limit \
    --workflow publish.yml \
    --event release \
    --commit "${release_commit}" \
    --status success \
    --limit 2 \
    --json databaseId \
    --jq 'if length == 1 then .[0].databaseId else error("expected exactly one successful release run") end'
)"
test "$(gh run view "${run_id}" --repo pegma-dev/rate-limit --json headBranch --jq .headBranch)" = "${release_tag}"
test "$(gh run view "${run_id}" --repo pegma-dev/rate-limit --json headSha --jq .headSha)" = "${release_commit}"
artifact_dir="$(mktemp -d)"
gh run download "${run_id}" \
  --repo pegma-dev/rate-limit \
  --name "rate-limit-release-${run_id}" \
  --dir "${artifact_dir}"
test -f "${artifact_dir}/package-manifest.json"
pnpm run release:registry:check -- --manifest "${artifact_dir}/package-manifest.json"
npm dist-tag ls @pegma/rate-limit
```

For that ceremony the registry check had to report
`@pegma/rate-limit@0.1.0: exact`, with `latest` at `0.1.0` and `bootstrap` at
`0.0.0`. Current `latest` is published `0.3.2`, with the strict-postflight
limitation above; do not retag an older release or repeat the bootstrap to
prepare the unpublished `0.3.3` candidate.
