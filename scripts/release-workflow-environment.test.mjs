import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { parse } from "yaml";

const WORKFLOW = new URL("../.github/workflows/publish.yml", import.meta.url);
const STEP = "Verify and publish the prepared tarball";
const START = "const keep = new Set([\n";
const END = "const runNpm = (arguments_, allowFailure = false) => {";
const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
const RUNNER_REFUSAL =
  "GitHub-hosted runner metadata is required for provenance";

function one(text, pattern, description) {
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, "Expected one " + description);
  return matches[0];
}

/** Parse the actual pinned YAML; never run its shell, artifact, npm or publish stages. */
async function boundary() {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.devDependencies.yaml, "2.9.1");
  const document = parse(await readFile(WORKFLOW, "utf8"));
  const steps = document.jobs.publish.steps.filter(
    (step) => step.name === STEP,
  );
  assert.equal(steps.length, 1, "Expected the actual publishing step");
  assert.equal(steps[0].shell, "bash");
  assert.equal(typeof steps[0].run, "string");
  const body = one(
    steps[0].run.replace(/\r\n/gu, "\n"),
    /^set -euo pipefail\nnode <<'NODE'\n([\s\S]+)\nNODE\n?$/gu,
    "supported inline Node body",
  )[1];
  const registry = JSON.parse(
    one(
      body,
      /^const REGISTRY = ("[^"\n]+");$/gmu,
      "actual registry constant",
    )[1],
  );
  assert.equal(registry, OFFICIAL_REGISTRY);
  assert.equal(
    body.split(START).length,
    2,
    "Expected one environment start marker",
  );
  assert.equal(body.split(END).length, 2, "Expected one pre-npm end marker");
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  assert.ok(end > start, "Environment admission must precede the npm boundary");
  const source = body.slice(start, end);
  assert.doesNotMatch(
    source,
    /\b(?:spawnSync|runNpm|require|import|fetch|readFileSync|writeFileSync)\b/u,
    "Only environment construction/admission may enter the isolated replay",
  );
  return { source, registry };
}

/**
 * Execute only the captured environment slice with an inert process and paths.
 * No real environment, filesystem, command runner, network or credentials enter
 * the VM. These tests establish a producer boundary, not OIDC/Sigstore proof.
 */
function replay(captured, environment) {
  const configDirectory = join("synthetic-release-only", "private-config");
  const userConfig = join(configDirectory, "user.npmrc");
  const globalConfig = join(configDirectory, "global.npmrc");
  const input = Object.freeze({ ...environment });
  const script = new Script(captured.source + "\nnpmEnvironment;", {
    filename: "captured-publish-environment-only.js",
  });
  const result = script.runInNewContext(
    {
      process: Object.freeze({ env: input }),
      configDirectory,
      userConfig,
      globalConfig,
      REGISTRY: captured.registry,
      join,
      fail(message) {
        throw new Error(message);
      },
    },
    {
      timeout: 1000,
      contextCodeGeneration: { strings: false, wasm: false },
    },
  );
  return {
    // Detach the cross-realm object; values are these fixture strings only.
    environment: Object.fromEntries(Object.entries(result)),
    input,
    userConfig,
    globalConfig,
    cache: join(configDirectory, "cache"),
  };
}

function metadata() {
  return {
    CI: "1",
    PATH: "synthetic-native-command-path",
    HOME: "synthetic-home",
    RUNNER_TEMP: "synthetic-runner-temp",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "release",
    GITHUB_REPOSITORY: "pegma-dev/rate-limit",
    GITHUB_REPOSITORY_ID: "1000001",
    GITHUB_REPOSITORY_OWNER: "pegma-dev",
    GITHUB_REPOSITORY_OWNER_ID: "1000002",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REF: "refs/tags/v0.3.3",
    GITHUB_REF_TYPE: "tag",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW_REF:
      "pegma-dev/rate-limit/.github/workflows/publish.yml@refs/tags/v0.3.3",
    GITHUB_WORKFLOW_SHA: "b".repeat(40),
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_NUMBER: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW: "Publish",
    GITHUB_JOB: "publish",
    GITHUB_ACTOR: "synthetic-release-author",
    GITHUB_ACTOR_ID: "1000003",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://token.actions.githubusercontent.com/synthetic-test-only",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-request-not-a-credential",
  };
}

test("actual YAML environment retains github-hosted and needed GitHub/OIDC metadata", async () => {
  const source = metadata();
  const result = replay(await boundary(), source);
  for (const [name, value] of Object.entries(source)) {
    assert.equal(
      result.environment[name],
      value,
      "Required metadata lost: " + name,
    );
  }
  assert.deepEqual(result.input, source, "Admission must not mutate its input");
});

test("actual YAML rebuilds isolated npm configuration and drops ambient credential/config poison", async () => {
  const poison = {
    NPM_TOKEN: "synthetic-npm-token",
    NODE_AUTH_TOKEN: "synthetic-node-auth-token",
    GH_TOKEN: "synthetic-gh-token",
    AWS_ACCESS_KEY_ID: "synthetic-aws-key",
    AWS_SECRET_ACCESS_KEY: "synthetic-aws-secret",
    AZURE_CLIENT_SECRET: "synthetic-azure-secret",
    NPM_CONFIG_USERCONFIG: "untrusted-user-config",
    NPM_CONFIG_GLOBALCONFIG: "untrusted-global-config",
    NPM_CONFIG_CACHE: "untrusted-cache",
    NPM_CONFIG_REGISTRY: "https://untrusted.example.invalid/",
    NPM_CONFIG_PROVENANCE: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "false",
    npm_config_registry: "https://lowercase.example.invalid/",
    npm_config_userconfig: "untrusted-lowercase-config",
    npm_config_provenance: "false",
    NODE_OPTIONS: "--require synthetic-untrusted-hook.js",
    node_options: "--require synthetic-lowercase-hook.js",
    NODE_PATH: "synthetic-untrusted-module-path",
    RELEASE_ALLOWED_SIGNERS: "synthetic-signers-not-needed-by-npm",
  };
  const result = replay(await boundary(), { ...metadata(), ...poison });
  const replacement = {
    NPM_CONFIG_USERCONFIG: result.userConfig,
    NPM_CONFIG_GLOBALCONFIG: result.globalConfig,
    NPM_CONFIG_CACHE: result.cache,
    NPM_CONFIG_REGISTRY: OFFICIAL_REGISTRY,
  };
  for (const name of Object.keys(poison)) {
    if (Object.hasOwn(replacement, name)) {
      assert.equal(result.environment[name], replacement[name]);
      assert.notEqual(result.environment[name], poison[name]);
    } else {
      assert.equal(
        Object.hasOwn(result.environment, name),
        false,
        "Ambient poison survived: " + name,
      );
    }
  }
  assert.equal(result.environment.RUNNER_ENVIRONMENT, "github-hosted");
});

for (const [name, value] of [
  ["missing", undefined],
  ["empty", ""],
  ["self-hosted", "self-hosted"],
  ["unknown", "unknown-runner-kind"],
  ["different case", "GITHUB-HOSTED"],
  ["whitespace padded", "github-hosted "],
]) {
  test(
    "actual pre-npm boundary refuses " + name + " runner metadata",
    async () => {
      const captured = await boundary();
      const environment = metadata();
      if (value === undefined) delete environment.RUNNER_ENVIRONMENT;
      else environment.RUNNER_ENVIRONMENT = value;
      assert.throws(() => replay(captured, environment), {
        message: RUNNER_REFUSAL,
      });
    },
  );
}

test("lowercase-only runner metadata cannot replace the canonical npm provenance input", async () => {
  const captured = await boundary();
  const environment = metadata();
  delete environment.RUNNER_ENVIRONMENT;
  environment.runner_environment = "github-hosted";
  assert.throws(() => replay(captured, environment), {
    message: RUNNER_REFUSAL,
  });
});

test("removing the actual keep entry reproduces the original lost-runner metadata refusal", async () => {
  const captured = await boundary();
  const entry = /^\s*"RUNNER_ENVIRONMENT",\n/gmu;
  one(captured.source, entry, "runner keep entry");
  const withoutRunner = {
    ...captured,
    source: captured.source.replace(entry, ""),
  };
  assert.throws(() => replay(withoutRunner, metadata()), {
    message: RUNNER_REFUSAL,
  });
});
