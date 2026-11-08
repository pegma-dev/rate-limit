import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

export const TAG = "v0.3.1";
const PRINCIPAL = "release-fixture@example.invalid";
const PREFIX = "pegma-release-signing-test-";

export async function fixture(
  t,
  { signed = true, sourceFiles = {}, tag = TAG } = {},
) {
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
  function run(
    command,
    arguments_,
    { allowFailure = false, cwd = repo, environment = env } = {},
  ) {
    const result = spawnSync(command, arguments_, {
      cwd,
      env: environment,
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
  for (const [name, contents] of Object.entries(sourceFiles)) {
    const path = join(repo, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  git(["add", "--all"]);
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
      tag,
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
