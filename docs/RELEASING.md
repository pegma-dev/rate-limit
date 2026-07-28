# Release operations

No package is published merely by merging a pull request. Normal releases use
the hardened GitHub release workflow, npm trusted publishing, and provenance.
The completed one-time manual `0.0.0` ceremony below exists as an audit record:
npm could not configure a trusted publisher until `@pegma/rate-limit` existed.

## Release invariants

The release tool verifies the exact public workspace inventory, stable package
version, exact Pegma dependency pins, matching lockfile, package metadata,
README and LICENSE, prepack build, test exclusion, dist-only allowlist, and
exports. Packing builds once, checks the complete file inventory and hashes,
and imports every export from a clean consumer installation.

The prepared `package-manifest.json` records the source commit, optional
release tag, tarball filename, SHA-1, SHA-512 integrity, and packed files.
`release:registry:check` revalidates those local bytes before comparing their
exact integrity with npm. Only npm `E404` means `absent`; an existing different
artifact or another registry failure stops the ceremony.

## One-time `0.0.0` package-name bootstrap

**Complete; do not repeat.** The exact reviewed `0.0.0` artifact was published
under `bootstrap`, its signed annotated source tag points to the reviewed
`origin/main` commit, and npm trusted publishing is configured for
`pegma-dev/rate-limit`, `publish.yml`, and the `npm-publish` environment.

npm also assigned the default `latest` tag to `0.0.0`. The operator attempted
to remove it, but npm rejected the request with HTTP 400. The immutable
bootstrap remains exact and the `bootstrap` tag remains correct; publishing
`0.1.0` through the normal workflow will immediately move `latest` to the
first advertised version.

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
registry changes. The `0.1.0` publication corrects the default tag.

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

This separate reviewed pull request must:

1. change `packages/rate-limit/package.json` from `0.0.0` to `0.1.0`;
2. regenerate `package-lock.json` and verify its workspace entry is `0.1.0`;
3. update README and plan status with the advertised release notes; and
4. pass the full gate and release pack smoke on Node 22 and 24.

After that pull request merges, create the protected signed annotated
`v0.1.0` tag on the exact `origin/main` commit and create the GitHub release:

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
main ancestry, full gate, tarball inventory, imports, and hashes. Only the
environment-scoped publish job receives OIDC authority; it installs no
dependencies and publishes the downloaded prepared artifact with provenance.
Re-running is safe only when npm reports the same integrity.

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
npm run release:registry:check -- -- --manifest "${artifact_dir}/package-manifest.json"
npm dist-tag ls @pegma/rate-limit
```

The registry check must report `@pegma/rate-limit@0.1.0: exact`;
`latest` must point to `0.1.0`, while `bootstrap` remains at `0.0.0`.
