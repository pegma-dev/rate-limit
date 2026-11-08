import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { create } from "@actions/glob";
import { parse } from "yaml";

const WORKFLOW = new URL("../.github/workflows/publish.yml", import.meta.url);
const UPLOAD_ACTION =
  "actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4";
const PREFIX = "rate-limit-artifact-discovery-";

function contained(root, path) {
  const target = resolve(path);
  const suffix = relative(root, target);
  assert.ok(
    suffix !== "" &&
      suffix !== ".." &&
      !suffix.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
      !isAbsolute(suffix),
    "Fixture paths must remain inside their owned temporary root",
  );
  return target;
}

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, PREFIX));
  t.after(async () => {
    const actual = await realpath(root);
    assert.equal(
      actual,
      root,
      "Cleanup target must remain the original owned directory",
    );
    contained(parent, actual);
    assert.ok(basename(actual).startsWith(PREFIX));
    await rm(actual, { recursive: true, force: true });
  });
  const runnerTemp = contained(root, join(root, "runner-temp"));
  const workspace = contained(root, join(root, "workspace"));
  await mkdir(runnerTemp);
  await mkdir(workspace);
  return { root, runnerTemp, workspace };
}

function oneMatch(text, pattern, name) {
  const matches = [...text.matchAll(pattern)];
  assert.equal(
    matches.length,
    1,
    "Expected one supported " + name + " binding",
  );
  return matches[0][1];
}

function shellValue(value, environment) {
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
    (_, name) => {
      assert.ok(Object.hasOwn(environment, name), "Unknown producer variable");
      return environment[name];
    },
  );
  assert.ok(!expanded.includes("$"), "Unsupported producer shell expression");
  return expanded;
}

function actionValue(value, context) {
  assert.equal(typeof value, "string");
  const expanded = value.replace(
    /\$\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/gu,
    (_, name) => {
      assert.ok(
        Object.hasOwn(context, name),
        "Unknown artifact path expression",
      );
      return context[name];
    },
  );
  assert.ok(!expanded.includes("$"), "Unsupported artifact path expression");
  return expanded;
}

function steps(document) {
  const prepare = document.jobs.prepare;
  const pack = prepare.steps.find((step) => step.id === "pack");
  const upload = prepare.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.ok(
    pack && typeof pack.run === "string",
    "Expected actual pack producer",
  );
  assert.equal(
    upload?.uses,
    UPLOAD_ACTION,
    "Re-review discovery behavior when the action pin changes",
  );
  return { pack, upload };
}

function includeHidden(value) {
  // The pinned action's input defaults to false; YAML may encode it as text.
  if (value === undefined || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  assert.fail("Unexpected include-hidden-files input");
}

/** Public glob API and the reviewed action's options/directory filtering only. */
async function uploadFiles(pattern, includeHiddenFiles) {
  const globber = await create(pattern, {
    followSymbolicLinks: true,
    implicitDescendants: true,
    omitBrokenSymbolicLinks: true,
    excludeHiddenFiles: !includeHiddenFiles,
  });
  const files = [];
  for (const path of await globber.glob()) {
    const info = await stat(path);
    if (!info.isDirectory()) {
      assert.ok(
        info.isFile(),
        "Selection fixture must contain regular files only",
      );
      files.push(resolve(path));
    }
  }
  return files.sort();
}

/** Replay path bindings only: never run workflow shell, npm, packing or upload. */
async function discovery(t, document) {
  const f = await fixture(t);
  const { pack, upload } = steps(document);
  const environment = {
    RUNNER_TEMP: f.runnerTemp,
    GITHUB_WORKSPACE: f.workspace,
  };
  const assigned = oneMatch(
    pack.run,
    /^\s*release_dir="([^"\r\n]+)"\s*$/gmu,
    "release_dir",
  );
  environment.release_dir = shellValue(assigned, environment);
  const producerCommands = pack.run
    .replace(/\\\r?\n[\t ]*/gu, " ")
    .split(/\r?\n/u)
    .filter((line) => /^\s*pnpm run release:pack\s+--(?:\s|$)/u.test(line));
  assert.equal(
    producerCommands.length,
    1,
    "Expected the real release producer command",
  );
  const outputArgument = oneMatch(
    producerCommands[0],
    /--output\s+"([^"\r\n]+)"/gu,
    "pack output argument",
  );
  const output = contained(
    f.root,
    resolve(f.workspace, shellValue(outputArgument, environment)),
  );
  assert.equal(
    output,
    resolve(f.workspace, environment.release_dir),
    "Pack output must match its assigned release directory",
  );
  await mkdir(output, { recursive: true });
  // These are deliberately not npm proof/artifact bytes, only discovery inputs.
  const manifestPath = join(output, "package-manifest.json");
  const tarballPath = join(output, "synthetic-selection-only.tgz");
  const manifest = JSON.stringify({
    fixture: "artifact discovery only",
    tarball: basename(tarballPath),
  });
  await writeFile(manifestPath, manifest);
  await writeFile(
    tarballPath,
    "synthetic selection bytes, not an npm package\n",
  );
  await writeFile(
    join(output, ".incidental-hidden-file"),
    "must never be selected\n",
  );
  const sealArgument = oneMatch(
    pack.run,
    /^\s*manifest_digest="\$\(sha256sum\s+"([^"\r\n]+)"[^\r\n]*\)"\s*$/gmu,
    "manifest digest path",
  );
  const sealedPath = contained(
    f.root,
    resolve(f.workspace, shellValue(sealArgument, environment)),
  );
  assert.equal(
    sealedPath,
    manifestPath,
    "Seal path must identify the producer's actual manifest",
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(sealedPath))
      .digest("hex"),
    createHash("sha256").update(manifest).digest("hex"),
  );
  const rendered = actionValue(upload.with.path, {
    "runner.temp": f.runnerTemp,
    "github.workspace": f.workspace,
  });
  assert.ok(
    !["\n", "\r", "*", "?", "[", "]", "!"].some((character) =>
      rendered.includes(character),
    ),
    "Replay supports one literal owned upload directory only",
  );
  const pattern = contained(f.root, resolve(f.workspace, rendered));
  const files = await uploadFiles(
    pattern,
    includeHidden(upload.with["include-hidden-files"]),
  );
  return {
    files,
    expected: [manifestPath, tarballPath].map((path) => resolve(path)).sort(),
  };
}

function requireComplete(result) {
  assert.deepEqual(
    result.files,
    result.expected,
    "Upload must discover exactly the producer's two regular files",
  );
}

async function workflow() {
  return parse(await readFile(WORKFLOW, "utf8"));
}

test("actual workflow discovers both sealed files using the reviewed glob library and hidden-file policy", async (t) => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.devDependencies["@actions/glob"], "0.5.0");
  assert.equal(manifest.devDependencies.yaml, "2.9.1");
  requireComplete(await discovery(t, await workflow()));
});

test("the old hidden .release producer/upload path reproduces zero selected files", async (t) => {
  const document = await workflow();
  const { pack, upload } = steps(document);
  pack.run = pack.run.replace(
    /^\s*release_dir="[^"\r\n]+"\s*$/mu,
    'release_dir="${GITHUB_WORKSPACE}/.release"',
  );
  upload.with.path = ".release/";
  const result = await discovery(t, document);
  assert.deepEqual(result.files, []);
  assert.throws(() => requireComplete(result), /two regular files/u);
});

test("a different upload target cannot pass discovery despite successful production and sealing", async (t) => {
  const document = await workflow();
  steps(document).upload.with.path = "${{ runner.temp }}/unrelated-target/";
  const result = await discovery(t, document);
  assert.deepEqual(result.files, []);
  assert.throws(() => requireComplete(result), /two regular files/u);
});

test("producer directory drift cannot leave upload pointing at an empty old location", async (t) => {
  const document = await workflow();
  const { pack } = steps(document);
  pack.run = pack.run.replace(
    /^\s*release_dir="[^"\r\n]+"\s*$/mu,
    'release_dir="${RUNNER_TEMP}/different-producer"',
  );
  const result = await discovery(t, document);
  assert.deepEqual(result.files, []);
  assert.throws(() => requireComplete(result), /two regular files/u);
});

test("a digest path detached from the actual pack output fails the seal binding", async (t) => {
  const document = await workflow();
  const { pack } = steps(document);
  pack.run = pack.run.replace(
    /sha256sum\s+"[^"\r\n]+"/u,
    'sha256sum "${RUNNER_TEMP}/unrelated-manifest/package-manifest.json"',
  );
  await assert.rejects(discovery(t, document), /producer's actual manifest/u);
});

test("enabling hidden files is observed by real discovery and admits the incidental file", async (t) => {
  const document = await workflow();
  steps(document).upload.with["include-hidden-files"] = true;
  const result = await discovery(t, document);
  assert.equal(result.files.length, 3);
  assert.ok(
    result.files.some((path) => basename(path) === ".incidental-hidden-file"),
  );
  assert.throws(() => requireComplete(result), /two regular files/u);
});
