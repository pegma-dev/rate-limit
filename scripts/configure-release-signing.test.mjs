import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureReleaseSigning } from "./configure-release-signing.mjs";
import { fixture, TAG } from "./release-signing-fixture.mjs";

test("actual signed tag fails without checkout trust and verifies after configuration", async (t) => {
  const f = await fixture(t);
  f.assertNoTrust();
  const before = f.git(["verify-tag", `refs/tags/${TAG}`], {
    allowFailure: true,
  });
  assert.notEqual(before.status, 0);
  const head = f.git(["rev-parse", "HEAD"]).stdout;
  const tag = f.git(["rev-parse", `refs/tags/${TAG}`]).stdout;
  await configureReleaseSigning(f.signer.allowed, TAG, {
    cwd: f.repo,
    env: f.env,
  });
  assert.equal(f.git(["verify-tag", `refs/tags/${TAG}`]).status, 0);
  assert.equal(
    f.git(["config", "--local", "--get", "gpg.format"]).stdout.trim(),
    "ssh",
  );
  assert.equal(
    f
      .git(["config", "--local", "--get", "gpg.ssh.allowedSignersFile"])
      .stdout.trim(),
    f.signer.allowed,
  );
  assert.equal(f.git(["rev-parse", "HEAD"]).stdout, head);
  assert.equal(f.git(["rev-parse", `refs/tags/${TAG}`]).stdout, tag);
  assert.equal(f.git(["status", "--porcelain"]).stdout, "");
});

test("a real tag signed by another key remains rejected", async (t) => {
  const f = await fixture(t);
  const other = await f.publicSigners("other-fixture-key");
  await assert.rejects(
    configureReleaseSigning(other.allowed, TAG, { cwd: f.repo, env: f.env }),
    /signature is not valid for an approved signer/u,
  );
  assert.notEqual(
    f.git(["verify-tag", `refs/tags/${TAG}`], { allowFailure: true }).status,
    0,
  );
});

test("the actual CLI verifies a real signed tag in its current checkout", async (t) => {
  const f = await fixture(t);
  const helper = fileURLToPath(
    new URL("./configure-release-signing.mjs", import.meta.url),
  );
  const result = f.run(process.execPath, [helper, f.signer.allowed, TAG]);
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "Release signing trust configured and tag verified.\n",
  );
  assert.equal(result.stderr, "");
  assert.equal(f.git(["verify-tag", `refs/tags/${TAG}`]).status, 0);
});

for (const kind of [
  "missing",
  "empty",
  "whitespace",
  "oversized",
  "directory",
  "symlink",
  "relative",
]) {
  test(`invalid ${kind} public trust is rejected before either configuration write`, async (t) => {
    const f = await fixture(t, { signed: false });
    let path = join(f.root, "invalid-signers");
    if (kind === "empty") await writeFile(path, "");
    if (kind === "whitespace") await writeFile(path, " \n\r\n");
    if (kind === "oversized")
      await writeFile(path, Buffer.alloc(64 * 1024 + 1, 65));
    if (kind === "directory") await mkdir(path);
    if (kind === "symlink") {
      const target = join(f.root, "own-link-target");
      await mkdir(target);
      // Windows junctions require no privileged file-symlink capability.
      await symlink(
        target,
        path,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    if (kind === "relative") path = "relative-public-signers";
    await assert.rejects(
      configureReleaseSigning(path, TAG, { cwd: f.repo, env: f.env }),
      /public signers/u,
    );
    f.assertNoTrust();
  });
}

test("a nonrelease ref cannot change checkout configuration", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    configureReleaseSigning(f.signer.allowed, "main", {
      cwd: f.repo,
      env: f.env,
    }),
    /stable release tag/u,
  );
  f.assertNoTrust();
});

test("a missing real release tag fails verification without raw Git output", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    configureReleaseSigning(f.signer.allowed, "v0.3.2", {
      cwd: f.repo,
      env: f.env,
    }),
    {
      message: "The release tag signature is not valid for an approved signer.",
    },
  );
});

test("a real Git configuration failure rejects", async (t) => {
  const f = await fixture(t);
  const notRepository = join(f.root, "not-a-repository");
  await mkdir(notRepository);
  await assert.rejects(
    configureReleaseSigning(f.signer.allowed, TAG, {
      cwd: notRepository,
      env: f.env,
    }),
    {
      message: "Could not configure release signing format.",
    },
  );
});
