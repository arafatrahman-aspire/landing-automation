import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv();

// steps.mjs pulls in config.mjs (and state/db.mjs) transitively, which
// requires the env vars above to be set before this first import.
const { findExistingImportExamples } = await import("../src/orchestrator/steps.mjs");

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "import-scan-"));
  await mkdir(path.join(dir, "src/components/layout"), { recursive: true });
  await mkdir(path.join(dir, "node_modules/react-icons"), { recursive: true });
  await writeFile(
    path.join(dir, "src/components/layout/Footer.js"),
    `import React from "react";\nimport { FaFacebook, FaTwitter } from "react-icons/fa";\n\nexport default function Footer() { return null; }\n`
  );
  // A file inside node_modules that also matches the pattern — must be
  // ignored, or a real repo's own installed copy of the package would
  // constantly "confirm" whatever fake sub-path the agent already guessed.
  await writeFile(
    path.join(dir, "node_modules/react-icons/fa6.js"),
    `module.exports = require("./lib/fa6");\n`
  );
  return dir;
}

test("returns nothing when there's no verify report yet (first attempt, nothing to react to)", async () => {
  const dir = await makeRepo();
  const result = await findExistingImportExamples({ workdir: dir, verifyReport: null });
  assert.equal(result, "");
  await rm(dir, { recursive: true, force: true });
});

test("returns nothing when the report has no 'Can't resolve' error", async () => {
  const dir = await makeRepo();
  const result = await findExistingImportExamples({ workdir: dir, verifyReport: "npm run build failed: some unrelated syntax error" });
  assert.equal(result, "");
  await rm(dir, { recursive: true, force: true });
});

test("finds a real existing import of the same base package and surfaces it, ignoring node_modules", async () => {
  const dir = await makeRepo();
  const verifyReport = `Module not found: Error: Can't resolve 'react-icons/fa6' in '${dir}/src/components/home'`;
  const result = await findExistingImportExamples({ workdir: dir, verifyReport });
  assert.match(result, /react-icons\/fa/);
  assert.match(result, /Footer\.js/);
  assert.doesNotMatch(result, /node_modules/);
  await rm(dir, { recursive: true, force: true });
});

test("returns nothing when no file in the repo imports the unresolved package at all", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "import-scan-empty-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src/App.js"), `export default function App() { return null; }\n`);
  const verifyReport = `Module not found: Error: Can't resolve 'left-pad' in '${dir}/src'`;
  const result = await findExistingImportExamples({ workdir: dir, verifyReport });
  assert.equal(result, "");
  await rm(dir, { recursive: true, force: true });
});

test("handles a scoped package name correctly (base package is @scope/name, not the sub-path)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "import-scan-scoped-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "src/App.js"),
    `import { Icon } from "@radix-ui/react-icons/dist/thing";\n`
  );
  const verifyReport = `Module not found: Error: Can't resolve '@radix-ui/react-icons/other' in '${dir}/src'`;
  const result = await findExistingImportExamples({ workdir: dir, verifyReport });
  assert.match(result, /@radix-ui\/react-icons/);
  await rm(dir, { recursive: true, force: true });
});
