import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { parse } from "yaml";
import { fixture } from "./release-signing-fixture.mjs";

const WORKFLOW = new URL("../.github/workflows/publish.yml", import.meta.url);
const HELPER = "scripts/configure-release-signing.mjs";
const SIGNING_STEP = "Apply approved signing trust to the packaging checkout";
const AUTHENTICATE_STEP = "Authenticate the release tag";
// Deliberately differs from the package version: consume the real env binding.
const FIXTURE_TAG = "v7.8.9";

function actionValue(value, context) {
  const expression = /^\$\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/u.exec(String(value));
  if (expression === null) return String(value);
  assert.ok(
    Object.hasOwn(context, expression[1]),
    "Unsupported workflow expression",
  );
  return context[expression[1]];
}

function expand(value, environment) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name) => {
    assert.ok(
      Object.hasOwn(environment, name),
      "Unknown replay environment variable",
    );
    return environment[name];
  });
}

async function workflow() {
  return parse(await readFile(WORKFLOW, "utf8"));
}

/** Selected signing stages only: no runner/setup/install/gate/upload execution. */
async function replay(t, document) {
  const helperSource = await readFile(
    new URL("./configure-release-signing.mjs", import.meta.url),
    "utf8",
  );
  const f = await fixture(t, {
    sourceFiles: { [HELPER]: helperSource },
    tag: FIXTURE_TAG,
  });
  const workspace = join(f.root, "checkout-workspace");
  const runnerTemp = join(f.root, "runner-temp");
  await mkdir(workspace);
  await mkdir(runnerTemp);
  const commit = f.git(["rev-parse", "HEAD"]).stdout.trim();
  const tagObject = f
    .git(["rev-parse", `refs/tags/${FIXTURE_TAG}`])
    .stdout.trim();
  const context = {
    "github.sha": commit,
    "github.event.release.tag_name": FIXTURE_TAG,
    "github.event.release.prerelease": "false",
    "vars.RELEASE_ALLOWED_SIGNERS": (
      await readFile(f.signer.allowed, "utf8")
    ).trim(),
  };
  const prepare = document.jobs.prepare;
  const jobEnvironment = {
    ...f.env,
    RUNNER_TEMP: runnerTemp,
    ...Object.fromEntries(
      Object.entries(prepare.env).map(([name, value]) => [
        name,
        actionValue(value, context),
      ]),
    ),
  };
  let producerPath;
  let verified = false;
  for (const step of prepare.steps) {
    const environment = {
      ...jobEnvironment,
      ...Object.fromEntries(
        Object.entries(step.env ?? {}).map(([name, value]) => [
          name,
          actionValue(value, context),
        ]),
      ),
    };
    if (step.name === AUTHENTICATE_STEP) {
      // Replay only this public-file producer, not its GitHub fetch/shell body.
      const assignment = /^\s*allowed_signers="([^"\r\n]+)"\s*$/mu.exec(
        step.run,
      );
      const producer =
        /^\s*printf '%s\\n' "([^"\r\n]+)" > "([^"\r\n]+)"\s*$/mu.exec(step.run);
      assert.ok(
        assignment && producer,
        "Approved public-file producer must be present",
      );
      producerPath = expand(assignment[1], environment);
      // A source contract and a filesystem boundary: never write outside temp.
      assert.equal(
        normalize(producerPath),
        join(runnerTemp, "release-allowed-signers"),
      );
      const producerEnvironment = {
        ...environment,
        allowed_signers: producerPath,
      };
      assert.equal(
        normalize(expand(producer[2], producerEnvironment)),
        normalize(producerPath),
      );
      const publicSigners = expand(producer[1], producerEnvironment);
      await writeFile(producerPath, `${publicSigners}\n`);
      f.git(
        [
          "-c",
          "gpg.format=ssh",
          "-c",
          `gpg.ssh.allowedSignersFile=${producerPath}`,
          "verify-tag",
          `refs/tags/${environment.RELEASE_TAG}`,
        ],
        { environment },
      );
    } else if (step.uses?.startsWith("actions/checkout@")) {
      // A fresh real checkout cannot inherit the authenticator's local config.
      f.run(
        "git",
        [
          "-c",
          `init.templateDir=${join(f.root, "empty-template")}`,
          "clone",
          "--no-local",
          "--no-hardlinks",
          "--no-checkout",
          f.repo,
          workspace,
        ],
        { cwd: f.root, environment },
      );
      const ref = actionValue(step.with.ref, context);
      f.run("git", ["checkout", "--detach", ref], {
        cwd: workspace,
        environment,
      });
    } else if (step.name === SIGNING_STEP) {
      // This restricted argv grammar consumes the actual YAML invocation; it
      // never executes arbitrary shell or substitutes a test-only helper call.
      const invocation =
        /^node\s+(\S+)\s+"([^"\r\n]+)"\s+"([^"\r\n]+)"\s*$/u.exec(
          step.run.trim(),
        );
      assert.ok(invocation, "Signing step must invoke the reviewed Node CLI");
      f.run(
        process.execPath,
        [
          invocation[1],
          expand(invocation[2], environment),
          expand(invocation[3], environment),
        ],
        { cwd: workspace, environment },
      );
    } else if (step.id === "pack") {
      const pack = step.run.replace(/\\\r?\n\s*/gu, " ");
      assert.match(pack, /pnpm run release:pack -- /u);
      assert.match(pack, /(?:^|\s)--require-release-tag(?:\s|$)/u);
      const expected = /--expected-release-commit\s+"([^"]+)"/u.exec(pack);
      assert.ok(expected, "Pack must bind its expected release commit");
      const git = (args) =>
        f.run("git", args, { cwd: workspace, environment }).stdout.trim();
      // The same real Git verification used by the packer's signature gate.
      git(["verify-tag", "--raw", `refs/tags/${environment.RELEASE_TAG}`]);
      assert.equal(git(["config", "--local", "--get", "gpg.format"]), "ssh");
      assert.equal(
        normalize(
          git(["config", "--local", "--get", "gpg.ssh.allowedSignersFile"]),
        ),
        normalize(producerPath),
      );
      assert.equal(
        git(["rev-parse", "HEAD"]),
        expand(expected[1], environment),
      );
      assert.equal(
        git(["rev-parse", `refs/tags/${environment.RELEASE_TAG}^{commit}`]),
        commit,
      );
      assert.equal(
        git(["rev-parse", `refs/tags/${environment.RELEASE_TAG}`]),
        tagObject,
      );
      verified = true;
      break;
    }
  }
  assert.ok(verified, "Replay must reach the actual pack verification stage");
}

test("actual prepare YAML carries approved trust into a fresh packaging checkout", async (t) => {
  await replay(t, await workflow());
});

test("removing the YAML signing step fails the actual Git pack signature guard", async (t) => {
  const document = await workflow();
  document.jobs.prepare.steps = document.jobs.prepare.steps.filter(
    (step) => step.name !== SIGNING_STEP,
  );
  await assert.rejects(replay(t, document), /Fixture git failed/u);
});

test("moving the signing step before checkout fails its actual Node invocation", async (t) => {
  const document = await workflow();
  const steps = document.jobs.prepare.steps;
  const index = steps.findIndex((step) => step.name === SIGNING_STEP);
  assert.notEqual(index, -1);
  const [signing] = steps.splice(index, 1);
  steps.splice(
    steps.findIndex((step) => step.uses?.startsWith("actions/checkout@")),
    0,
    signing,
  );
  await assert.rejects(replay(t, document), /Fixture .* failed/u);
});

test("using a path other than the authenticator's public file fails the real helper", async (t) => {
  const document = await workflow();
  const signing = document.jobs.prepare.steps.find(
    (step) => step.name === SIGNING_STEP,
  );
  signing.run = signing.run.replace(
    "/release-allowed-signers",
    "/missing-approved-file",
  );
  await assert.rejects(replay(t, document), /Fixture .* failed/u);
});
