import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { parse } from "yaml";

const WORKFLOW = new URL("../.github/workflows/publish.yml", import.meta.url);
const STEP = "Verify and publish the prepared tarball";
const START = "const keep = new Set([\n";
const RUNNER = "const runNpm = (arguments_, allowFailure = false) => {";
const END = 'const npmVersion = runNpm(["--version"], true).stdout.trim();';
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
  assert.equal(
    body.split(RUNNER).length,
    2,
    "Expected one npm runner definition",
  );
  assert.equal(
    body.split(END).length,
    2,
    "Expected one automatic npm-call marker",
  );
  const start = body.indexOf(START);
  const runner = body.indexOf(RUNNER);
  const end = body.indexOf(END);
  assert.ok(
    start < runner && runner < end,
    "Environment admission and runner must precede the automatic npm call",
  );
  const source = body.slice(start, end);
  assert.doesNotMatch(
    body.slice(start, runner),
    /\b(?:spawnSync|runNpm|require|import|fetch|readFileSync|writeFileSync)\b/u,
    "Environment construction must contain no command or filesystem calls",
  );
  assert.match(
    body.slice(runner, end),
    /^const runNpm = \(arguments_, allowFailure = false\) => \{[\s\S]+\n\s*\};\s*$/u,
    "Capture must finish at the actual npm runner's closing boundary",
  );
  return { source, registry };
}

/**
 * Execute only the captured environment/runner slice with inert process/paths.
 * The actual runner receives --version through a capturing stub, never a child
 * process. No real environment, filesystem, network or credentials enter the VM.
 * These tests establish a producer boundary, not OIDC/Sigstore proof.
 */
function replay(captured, environment, calls = []) {
  const configDirectory = join("synthetic-release-only", "private-config");
  const publishDirectory = join("synthetic-release-only", "empty-publish-cwd");
  const userConfig = join(configDirectory, "user.npmrc");
  const globalConfig = join(configDirectory, "global.npmrc");
  const input = Object.freeze({ ...environment });
  const script = new Script(
    captured.source +
      '\n({ environment: npmEnvironment, probe: runNpm(["--version"], true) });',
    {
      filename: "captured-publish-environment-only.js",
    },
  );
  const result = script.runInNewContext(
    {
      process: Object.freeze({ env: input }),
      configDirectory,
      publishDirectory,
      userConfig,
      globalConfig,
      REGISTRY: captured.registry,
      join,
      spawnSync(command, arguments_, options) {
        assert.equal(command, "npm", "Only the inert npm stub is supported");
        assert.deepEqual(
          Array.from(arguments_),
          ["--version"],
          "No publish/install/registry command may enter this replay",
        );
        calls.push({
          command,
          arguments: Array.from(arguments_),
          options: { ...options },
          environmentSnapshot:
            options.env === undefined
              ? undefined
              : Object.fromEntries(Object.entries(options.env)),
        });
        return { status: 0, stdout: "11.18.0\n", stderr: "" };
      },
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
    environment: Object.fromEntries(Object.entries(result.environment)),
    constructedEnvironment: result.environment,
    calls,
    probe: result.probe,
    input,
    publishDirectory,
    userConfig,
    globalConfig,
    cache: join(configDirectory, "cache"),
  };
}

function requireNpmEnvironment(result) {
  assert.equal(
    result.calls.length,
    1,
    "Expected exactly one inert version probe",
  );
  const call = result.calls[0];
  assert.equal(
    call.options.env,
    result.constructedEnvironment,
    "Actual npm runner must receive exactly the constructed filtered environment",
  );
  assert.deepEqual(call.environmentSnapshot, result.environment);
  assert.deepEqual(call.arguments, ["--version"]);
  assert.equal(call.command, "npm");
  assert.equal(call.options.cwd, result.publishDirectory);
  assert.equal(call.options.encoding, "utf8");
  assert.equal(call.options.stdio, "pipe");
  assert.equal(result.probe.status, 0);
  assert.equal(result.probe.stdout, "11.18.0\n");
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
  requireNpmEnvironment(result);
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
    HTTP_PROXY: "https://synthetic-proxy.example.invalid/",
    HTTPS_PROXY: "https://synthetic-tls-proxy.example.invalid/",
    ALL_PROXY: "socks://synthetic-all-proxy.example.invalid/",
    NO_PROXY: "synthetic-bypass.example.invalid",
    http_proxy: "https://synthetic-lowercase-proxy.example.invalid/",
    https_proxy: "https://synthetic-lowercase-tls-proxy.example.invalid/",
    all_proxy: "socks://synthetic-lowercase-all-proxy.example.invalid/",
    no_proxy: "synthetic-lowercase-bypass.example.invalid",
    NODE_EXTRA_CA_CERTS: "synthetic-untrusted-root-ca.pem",
    node_extra_ca_certs: "synthetic-lowercase-root-ca.pem",
    RELEASE_ALLOWED_SIGNERS: "synthetic-signers-not-needed-by-npm",
  };
  const result = replay(await boundary(), { ...metadata(), ...poison });
  requireNpmEnvironment(result);
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
      const calls = [];
      assert.throws(() => replay(captured, environment, calls), {
        message: RUNNER_REFUSAL,
      });
      assert.deepEqual(
        calls,
        [],
        "Invalid runner must fail before the version probe",
      );
    },
  );
}

test("lowercase-only runner metadata cannot replace the canonical npm provenance input", async () => {
  const captured = await boundary();
  const environment = metadata();
  delete environment.RUNNER_ENVIRONMENT;
  environment.runner_environment = "github-hosted";
  const calls = [];
  assert.throws(() => replay(captured, environment, calls), {
    message: RUNNER_REFUSAL,
  });
  assert.deepEqual(calls, []);
});

test("removing the actual keep entry reproduces the original lost-runner metadata refusal", async () => {
  const captured = await boundary();
  const entry = /^\s*"RUNNER_ENVIRONMENT",\n/gmu;
  one(captured.source, entry, "runner keep entry");
  const withoutRunner = {
    ...captured,
    source: captured.source.replace(entry, ""),
  };
  const calls = [];
  assert.throws(() => replay(withoutRunner, metadata(), calls), {
    message: RUNNER_REFUSAL,
  });
  assert.deepEqual(calls, []);
});

for (const [name, replacement] of [
  ["omitted child environment", ""],
  ["ambient process environment", "env: process.env,\n"],
]) {
  test(
    "disconnecting the actual runner via " + name + " fails the child contract",
    async () => {
      const captured = await boundary();
      const binding = /^\s*env: npmEnvironment,\n/gmu;
      one(captured.source, binding, "actual npm child environment binding");
      const disconnected = {
        ...captured,
        source: captured.source.replace(binding, replacement),
      };
      const result = replay(disconnected, {
        ...metadata(),
        NODE_AUTH_TOKEN: "synthetic-ambient-poison",
        HTTPS_PROXY: "https://synthetic-ambient-proxy.example.invalid/",
      });
      assert.throws(
        () => requireNpmEnvironment(result),
        /Actual npm runner must receive exactly the constructed filtered environment/u,
      );
    },
  );
}
