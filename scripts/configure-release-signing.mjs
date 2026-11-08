import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_SIGNERS_BYTES = 64 * 1024;
const STABLE_TAG = /^v(0\.[1-9][0-9]*|[1-9][0-9]*\.[0-9]+)\.[0-9]+$/u;

async function validatePublicSigners(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("The approved public signers file must be absolute.");
  }
  let file;
  try {
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size === 0 ||
      before.size > MAX_SIGNERS_BYTES
    ) {
      throw new Error("invalid public signers file");
    }
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_SIGNERS_BYTES
    ) {
      throw new Error("public signers file changed");
    }
    const buffer = Buffer.alloc(MAX_SIGNERS_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (
      bytesRead > MAX_SIGNERS_BYTES ||
      bytesRead !== after.size ||
      buffer.subarray(0, bytesRead).toString("utf8").trim() === ""
    ) {
      throw new Error("invalid public signers contents");
    }
  } catch {
    throw new Error(
      "Approved public signers must be a nonempty regular file of at most 64 KiB, without a symlink.",
    );
  } finally {
    await file?.close();
  }
}

/** Configure only the current packaging checkout, then verify its actual tag. */
export async function configureReleaseSigning(
  approvedSignersFile,
  stableTag,
  { cwd = process.cwd(), env = process.env } = {},
) {
  if (typeof stableTag !== "string" || !STABLE_TAG.test(stableTag)) {
    throw new Error("A stable release tag is required.");
  }
  await validatePublicSigners(approvedSignersFile);
  function git(arguments_, failure) {
    const result = spawnSync("git", arguments_, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024,
    });
    // Do not expose raw signature output or inherited Git diagnostics.
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(failure);
    }
  }
  git(
    ["config", "--local", "gpg.format", "ssh"],
    "Could not configure release signing format.",
  );
  git(
    ["config", "--local", "gpg.ssh.allowedSignersFile", approvedSignersFile],
    "Could not configure approved public release signers.",
  );
  git(
    ["verify-tag", `refs/tags/${stableTag}`],
    "The release tag signature is not valid for an approved signer.",
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 4) {
      throw new Error(
        "usage: configure-release-signing.mjs <absolute-approved-public-file> <stable-tag>",
      );
    }
    await configureReleaseSigning(process.argv[2], process.argv[3]);
    process.stdout.write(
      "Release signing trust configured and tag verified.\n",
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
