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
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import {
  isolatedNpmEnvironment,
  publishPrepared,
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
  vi.unstubAllEnvs();
  vi.mocked(spawnSync).mockReset();
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
        RUNNER_ENVIRONMENT: "github-hosted",
        runner_environment: "self-hosted",
        Runner_Environment: "self-hosted",
        RUNNER_ENVIRONMENT_POISON: "github-hosted",
        HTTPS_PROXY: "https://proxy.test",
        NODE_AUTH_TOKEN: "registry-token",
        NODE_EXTRA_CA_CERTS: "/tmp/extra.pem",
        NODE_OPTIONS: "--require hook.js",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        NPM_CONFIG_USERCONFIG: "/tmp/untrusted.npmrc",
        NPM_CONFIG_PROVENANCE: "false",
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
      RUNNER_ENVIRONMENT: "github-hosted",
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
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "NPM_CONFIG_PROVENANCE",
      "NPM_TOKEN",
      "npm_config_registry",
      "runner_environment",
      "Runner_Environment",
      "RUNNER_ENVIRONMENT_POISON",
    ]) {
      expect(environment).not.toHaveProperty(key);
    }
  });
});

describe("alternate publisher provenance environment", () => {
  const refusal = "GitHub-hosted runner metadata is required for provenance";

  function publishingContext(value: string | undefined) {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_EVENT_NAME", "release");
    vi.stubEnv("RUNNER_ENVIRONMENT", value);
  }

  it.each([
    undefined,
    "",
    "undefined",
    "self-hosted",
    "GITHUB-HOSTED",
    " github-hosted",
    "github-hosted ",
  ])(
    "refuses actual alternate publish entry before any child command for %s",
    async (value) => {
      publishingContext(value);
      await expect(publishPrepared()).rejects.toThrow(refusal);
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

  it("does not promote a case alias into the canonical provenance input", async () => {
    publishingContext(undefined);
    vi.stubEnv("runner_environment", "github-hosted");
    await expect(publishPrepared()).rejects.toThrow(refusal);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("leaves the exported filter usable for ordinary local reads without a hosted-runner constraint", () => {
    const paths = {
      cache: "/tmp/cache",
      userConfig: "/tmp/user.npmrc",
      globalConfig: "/tmp/global.npmrc",
    };
    expect(() => isolatedNpmEnvironment({ PATH: "/bin" }, paths)).not.toThrow();
    expect(isolatedNpmEnvironment({ PATH: "/bin" }, paths)).not.toHaveProperty(
      "RUNNER_ENVIRONMENT",
    );
    expect(
      isolatedNpmEnvironment({ RUNNER_ENVIRONMENT: "self-hosted" }, paths),
    ).toHaveProperty("RUNNER_ENVIRONMENT", "self-hosted");
  });

  it("rechecks the actual filtered publish child after a valid version probe and ordinary registry query", async () => {
    publishingContext("github-hosted");
    vi.stubEnv("NODE_AUTH_TOKEN", "synthetic-poison-token");
    vi.stubEnv("NPM_TOKEN", "synthetic-poison-token");
    vi.stubEnv("NODE_OPTIONS", "--require synthetic-poison-hook.js");
    const directory = await temporaryDirectory("rate-limit-alternate-control-");
    const source = JSON.parse(
      await readFile(resolve("packages/rate-limit/package.json"), "utf8"),
    ) as {
      name: string;
      version: string;
      exports: Record<string, Record<string, string>>;
    };
    // Opaque control-flow fixture, not a valid packed release or provenance
    // claim. The existing verifier reads its real bytes/digests/inventory; ONLY
    // child commands are mocked and no Git/npm/network command executes.
    const bytes = Buffer.from("Synthetic alternate-publisher refusal fixture.");
    const integrity =
      "sha512-" + createHash("sha512").update(bytes).digest("base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const commit = "c".repeat(40);
    const tag = "v" + source.version;
    const tarball = "pegma-rate-limit-" + source.version + ".tgz";
    const files = [
      ...new Set([
        "package.json",
        "README.md",
        "LICENSE",
        ...Object.values(source.exports).flatMap((entry) =>
          Object.values(entry).map((path) => path.replace(/^\.\//u, "")),
        ),
      ]),
    ].map((path) => ({ path, size: 1 }));
    const manifest = join(directory, "package-manifest.json");
    await writeFile(join(directory, tarball), bytes);
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 2,
        gitCommit: commit,
        releaseTag: tag,
        package: {
          name: source.name,
          version: source.version,
          tarball,
          integrity,
          sha256,
          files,
        },
      }),
    );

    const result = (
      stdout: string,
      status = 0,
      stderr = "",
    ): ReturnType<typeof spawnSync> => ({
      pid: 1,
      output: [null, stdout, stderr],
      stdout,
      stderr,
      status,
      signal: null,
    });
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      const actual = args ?? [];
      if (command === "git") {
        expect(actual).toEqual(["rev-parse", "HEAD"]);
        return result(commit + "\n");
      }
      if (actual.includes("--version")) {
        expect(options?.env?.RUNNER_ENVIRONMENT).toBe("github-hosted");
        for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NODE_OPTIONS"])
          expect(options?.env).not.toHaveProperty(key);
        return result("11.18.0\n");
      }
      if (actual.includes("view")) {
        vi.stubEnv("RUNNER_ENVIRONMENT", "self-hosted");
        return result("", 1, "E404");
      }
      throw new Error(
        "An unexpected child command crossed the publishing guard.",
      );
    });
    await expect(
      publishPrepared({
        manifest,
        releaseTag: tag,
        expectedReleaseCommit: commit,
      }),
    ).rejects.toThrow(refusal);
    expect(spawnSync).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(spawnSync)
        .mock.calls.some(([, args]) => args?.includes("publish")),
    ).toBe(false);
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
    expect(workflow).toContain("manifest_digest:");
    expect(workflow).toContain("steps.pack.outputs['manifest-digest']");
    expect(workflow).toContain("needs.prepare.outputs.manifest_digest");
    expect(workflow).not.toContain("outputs.manifest-digest");
    expect(workflow).toContain("needs: [prepare, smoke]");
    expect(workflow).toContain("--ignore-scripts");
    expect(workflow).toContain("NPM_CONFIG_USERCONFIG");
    expect(workflow).toContain("NPM_CONFIG_GLOBALCONFIG");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain(
      "npm install --global npm@11.18.0 --ignore-scripts --registry https://registry.npmjs.org/",
    );
    for (const key of [
      "COMSPEC",
      "HOMEDRIVE",
      "HOMEPATH",
      "PATHEXT",
      "SYSTEMDRIVE",
      "USERPROFILE",
      "WINDIR",
    ]) {
      expect(workflow).toContain(`"${key}"`);
    }
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

  it("keeps step-only contexts out of job environments", async () => {
    const workflow = await readFile(
      resolve(".github/workflows/publish.yml"),
      "utf8",
    );
    const jobEnvironments = [
      ...workflow.matchAll(/^ {4}env:\n((?: {6}.+\n)*)/gmu),
    ]
      .map((match) => match[1] ?? "")
      .join("\n");

    expect(jobEnvironments).not.toMatch(/\$\{\{\s*(?:runner|steps)\./u);
  });

  it("runs the release metadata check in CI", async () => {
    const workflow = await readFile(
      resolve(".github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("pnpm run release:check");
    expect(workflow.match(/corepack enable/gu)).toHaveLength(2);
    expect(workflow).toContain(
      "setup-node resolves the pnpm cache before later steps can run",
    );
  });

  it("uses deterministic LF line endings", async () => {
    await expect(readFile(resolve(".gitattributes"), "utf8")).resolves.toBe(
      "* text=auto eol=lf\n",
    );
  });
});
