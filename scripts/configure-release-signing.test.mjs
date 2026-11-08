import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { configureReleaseSigning } from "./configure-release-signing.mjs";

const TAG = "v0.3.1";
const PRINCIPAL = "release-fixture@example.invalid";
const PREFIX = "pegma-release-signing-test-";

async function fixture(t, { signed = true } = {}) {
  const parent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(parent, PREFIX)));
  t.after(async () => {
    const target = await realpath(root);
    const child = relative(parent, target);
    if (
      target !== root ||
      isAbsolute(child) ||
      dirname(child) !== "." ||
      !basename(child).startsWith(PREFIX)
    ) {
      throw new Error("Refusing cleanup outside the owned temporary fixture.");
    }
    await rm(target, { recursive: true, force: true });
  });
  const repo = join(root, "repository");
  const template = join(root, "empty-template");
  const globalConfig = join(root, "empty-global-config");
  await mkdir(repo);
  await mkdir(template);
  await writeFile(globalConfig, "");
  const env = {};
  // No user Git injection, signing configuration, credentials or SSH agent.
  for (const name of [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SYSTEMDRIVE",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "PROGRAMDATA",
    "ALLUSERSPROFILE",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.GIT_CONFIG_GLOBAL = globalConfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  function run(command, arguments_, { allowFailure = false, cwd = repo } = {}) {
    const result = spawnSync(command, arguments_, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error !== undefined || (!allowFailure && result.status !== 0)) {
      throw new Error(
        `Fixture ${command} failed (${result.error?.code ?? result.status}).`,
      );
    }
    return result;
  }
  const git = (arguments_, options) => run("git", arguments_, options);
  git(["init", "--template", template, "."]);
  git(["config", "--local", "user.name", "Synthetic Release Fixture"]);
  git(["config", "--local", "user.email", PRINCIPAL]);
  git([
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "--message",
    "synthetic source",
  ]);
  async function publicSigners(name) {
    const privateKey = join(root, name);
    run("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "synthetic release fixture",
      "-f",
      privateKey,
    ]);
    // Only this fixture's public key is read by Node; Git signs with its own
    // freshly generated private key, never a user key or SSH agent identity.
    const publicKey = (await readFile(`${privateKey}.pub`, "utf8")).trim();
    const allowed = join(root, `${name}.allowed-signers`);
    await writeFile(allowed, `${PRINCIPAL} ${publicKey}\n`);
    return { privateKey, allowed };
  }
  const signer = signed ? await publicSigners("fixture-key") : null;
  if (signer !== null) {
    git([
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${signer.privateKey}`,
      "tag",
      "--sign",
      "--message",
      "synthetic release",
      TAG,
    ]);
  }
  function assertNoTrust() {
    for (const name of ["gpg.format", "gpg.ssh.allowedSignersFile"]) {
      const result = git(["config", "--local", "--get", name], {
        allowFailure: true,
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
    }
  }
  return { root, repo, env, git, run, signer, publicSigners, assertNoTrust };
}

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
