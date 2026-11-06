import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isolatedNpmEnvironment,
  verifyReleaseInventory,
  // @ts-expect-error TypeScript does not emit declarations for repository scripts.
} from "../scripts/release-package.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("release artifact boundaries", () => {
  it("accepts exactly two regular release files", async () => {
    const directory = await temporaryDirectory("rate-limit-release-");
    await writeFile(join(directory, "package-manifest.json"), "{}\n");
    await writeFile(join(directory, "pegma-rate-limit-0.2.0.tgz"), "bytes");

    await expect(verifyReleaseInventory(directory)).resolves.toEqual({
      manifest: join(directory, "package-manifest.json"),
      tarball: join(directory, "pegma-rate-limit-0.2.0.tgz"),
    });
  });

  it.each([".npmrc", ".hidden", "extra.txt"])(
    "rejects an extra sibling file named %s",
    async (name) => {
      const directory = await temporaryDirectory("rate-limit-release-");
      await writeFile(join(directory, "package-manifest.json"), "{}\n");
      await writeFile(join(directory, "pegma-rate-limit-0.2.0.tgz"), "bytes");
      await writeFile(join(directory, name), "extra");

      await expect(verifyReleaseInventory(directory)).rejects.toThrow(
        "only regular files",
      );
    },
  );

  it("rejects a subdirectory", async () => {
    const directory = await temporaryDirectory("rate-limit-release-");
    await writeFile(join(directory, "package-manifest.json"), "{}\n");
    await writeFile(join(directory, "pegma-rate-limit-0.2.0.tgz"), "bytes");
    await mkdir(join(directory, "nested"));

    await expect(verifyReleaseInventory(directory)).rejects.toThrow(
      "only regular files",
    );
  });

  it("rejects a tarball-path symlink", async () => {
    const directory = await temporaryDirectory("rate-limit-release-");
    const target = await temporaryDirectory("rate-limit-release-target-");
    await writeFile(join(directory, "package-manifest.json"), "{}\n");
    await symlink(
      target,
      join(directory, "pegma-rate-limit-0.2.0.tgz"),
      "junction",
    );

    await expect(verifyReleaseInventory(directory)).rejects.toThrow(
      "only regular files",
    );
  });

  it("constructs an allowlisted npm environment", () => {
    const environment = isolatedNpmEnvironment(
      {
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/oidc",
        CI: "1",
        GITHUB_ACTIONS: "true",
        HOME: "/home/runner",
        PATH: "/bin",
        HTTPS_PROXY: "https://proxy.test",
        NODE_AUTH_TOKEN: "registry-token",
        NODE_EXTRA_CA_CERTS: "/tmp/extra.pem",
        NODE_OPTIONS: "--require hook.js",
        NPM_CONFIG_USERCONFIG: "/tmp/untrusted.npmrc",
        NPM_TOKEN: "registry-token",
        npm_config_registry: "https://example.test/",
      },
      {
        cache: "/tmp/npm-cache",
        globalConfig: "/tmp/global.npmrc",
        userConfig: "/tmp/user.npmrc",
      },
    );

    expect(environment).toMatchObject({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/oidc",
      CI: "1",
      GITHUB_ACTIONS: "true",
      HOME: "/home/runner",
      PATH: "/bin",
      NPM_CONFIG_CACHE: "/tmp/npm-cache",
      NPM_CONFIG_GLOBALCONFIG: "/tmp/global.npmrc",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      NPM_CONFIG_USERCONFIG: "/tmp/user.npmrc",
    });
    for (const key of [
      "HTTPS_PROXY",
      "NODE_AUTH_TOKEN",
      "NODE_EXTRA_CA_CERTS",
      "NODE_OPTIONS",
      "NPM_TOKEN",
      "npm_config_registry",
    ]) {
      expect(environment).not.toHaveProperty(key);
    }
  });
});

describe("publish workflow boundaries", () => {
  it("authenticates in bare repositories before checkout and never checks out in publish", async () => {
    const workflow = await readFile(
      resolve(".github/workflows/publish.yml"),
      "utf8",
    );
    const prepare = workflow.slice(
      workflow.indexOf("  prepare:"),
      workflow.indexOf("  smoke:"),
    );
    const publish = workflow.slice(workflow.indexOf("  publish:"));

    expect(prepare.indexOf("git init --bare")).toBeLessThan(
      prepare.indexOf("uses: actions/checkout"),
    );
    expect(workflow.match(/git init --bare/gu)).toHaveLength(2);
    expect(workflow.match(/ verify-tag /gu)).toHaveLength(2);
    expect(workflow.match(/merge-base --is-ancestor/gu)).toHaveLength(2);
    expect(prepare).toContain("ref: ${{ github.sha }}");
    expect(prepare).toContain("persist-credentials: false");
    expect(publish).not.toContain("actions/checkout");
    expect(publish).not.toContain("scripts/release-package.mjs");
  });

  it("seals a non-hidden artifact before unprivileged smoke and OIDC publish", async () => {
    const workflow = await readFile(
      resolve(".github/workflows/publish.yml"),
      "utf8",
    );

    expect(workflow).toContain("include-hidden-files: false");
    expect(workflow).toContain("manifest-digest:");
    expect(workflow).toContain("needs: [prepare, smoke]");
    expect(workflow).toContain("--ignore-scripts");
    expect(workflow).toContain("NPM_CONFIG_USERCONFIG");
    expect(workflow).toContain("NPM_CONFIG_GLOBALCONFIG");
    expect(workflow).toContain("id-token: write");
  });

  it("keeps GitHub expressions out of run scripts", async () => {
    const workflow = await readFile(
      resolve(".github/workflows/publish.yml"),
      "utf8",
    );
    const lines = workflow.split("\n");
    const runSections: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^ {8}run:/u.test(lines[index] ?? "")) {
        continue;
      }
      const body: string[] = [lines[index] as string];
      for (index += 1; index < lines.length; index += 1) {
        const line = lines[index] as string;
        if (line !== "" && !/^ {10,}/u.test(line)) {
          index -= 1;
          break;
        }
        body.push(line);
      }
      runSections.push(body.join("\n"));
    }

    expect(runSections.join("\n")).not.toContain("${{");
  });

  it("runs the release metadata check in CI", async () => {
    const workflow = await readFile(
      resolve(".github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("pnpm run release:check");
  });
});
