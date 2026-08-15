import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyBuild, detectPackageManager, isNextEslintToolingMismatch, isEslintOnlyBuildFailure, maybeIgnoreEslintDuringBuild } from "../src/verify/build-and-lint.mjs";

/* Local fixtures only — no network, no real npm install (a real package.json
 * with no dependencies makes `npm ci` a near-instant no-op). */

async function makeFixture(root, pkg) {
  await writeFile(path.join(root, "package.json"), JSON.stringify(pkg, null, 2));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
}

test("passes when build (and no lint) succeeds", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeFixture(root, { name: "fixture", version: "0.0.0", scripts: { build: "echo build-ok" } });

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000 });
  assert.equal(result.ok, true);
});

test("isNextEslintToolingMismatch detects the Next 14 + ESLint 9 Invalid Options crash", () => {
  const sample = `Invalid Options:
- Unknown options: useEslintrc, extensions, resolvePluginsRelativeTo
- 'extensions' has been removed.`;
  assert.equal(isNextEslintToolingMismatch(sample), true);
  assert.equal(isNextEslintToolingMismatch("error  Unexpected console statement  no-console"), false);
});

test("isEslintOnlyBuildFailure is true for the ESLint abort and false when types also failed", () => {
  const eslintOnly = `info  - Linting and checking validity of types ...
ESLint: Invalid Options:
- Unknown options: useEslintrc, extensions
Failed to compile.`;
  assert.equal(isEslintOnlyBuildFailure(eslintOnly), true);

  const withTypeError = `${eslintOnly}

./app/campaigns/x/sections/TimelineSection3.tsx:12:5
Type error: Property 'image' is missing in type '{ title: string }' but required in type 'ProcessExplainerItem'.`;
  assert.equal(isEslintOnlyBuildFailure(withTypeError), false);

  const withMissingProp = `ESLint: Invalid Options: useEslintrc, extensions
Failed to compile.
TimelineSection3.tsx: Property 'image' is missing on ProcessExplainerItem`;
  assert.equal(isEslintOnlyBuildFailure(withMissingProp), false);
});

test("maybeIgnoreEslintDuringBuild patches next.config only for Next ≤14 + ESLint ≥9", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "next.config.mjs"),
    "const nextConfig = {\n  reactStrictMode: true,\n};\nexport default nextConfig;\n"
  );

  await makeFixture(root, { name: "fixture", version: "0.0.0", dependencies: { next: "^15.0.0" }, devDependencies: { eslint: "^9.0.0" } });
  const skipped = await maybeIgnoreEslintDuringBuild(root);
  assert.equal(skipped.patched, false);

  await makeFixture(root, { name: "fixture", version: "0.0.0", dependencies: { next: "^14.2.14" }, devDependencies: { eslint: "^9.0.0" } });
  const applied = await maybeIgnoreEslintDuringBuild(root);
  assert.equal(applied.patched, true);
  assert.equal(applied.path, "next.config.mjs");
});

test("build fail that is only the Next/ESLint tooling mismatch is treated as verify pass", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "fail-eslint.mjs"),
    "console.error('ESLint: Invalid Options:\\n- Unknown options: useEslintrc, extensions\\nFailed to compile.');\nprocess.exit(1);\n"
  );
  await makeFixture(root, { name: "fixture", version: "0.0.0", scripts: { build: "node fail-eslint.mjs" } });

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000 });
  assert.equal(result.ok, true);
  assert.match(result.report, /ESLint step skipped|tooling mismatch/i);
});

test("build fail with ESLint mismatch AND a Type error still fails verify", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "fail-types.mjs"),
    "console.error(\"ESLint: Invalid Options: useEslintrc, extensions\\nType error: Property 'image' is missing\");\nprocess.exit(1);\n"
  );
  await makeFixture(root, { name: "fixture", version: "0.0.0", scripts: { build: "node fail-types.mjs" } });

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000 });
  assert.equal(result.ok, false);
  assert.match(result.report, /build/i);
});

test("build pass + Next/ESLint tooling-mismatch lint failure is treated as verify pass", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeFixture(root, {
    name: "fixture",
    version: "0.0.0",
    scripts: {
      build: "echo build-ok",
      lint: "node -e \"console.error('Invalid Options:\\n- Unknown options: useEslintrc, extensions'); process.exit(1)\"",
    },
  });

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000 });
  assert.equal(result.ok, true);
  assert.match(result.report, /Lint skipped/i);
  assert.match(result.report, /ESLint 9/i);
});

test("a real lint rule failure still fails verify", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeFixture(root, {
    name: "fixture",
    version: "0.0.0",
    scripts: {
      build: "echo build-ok",
      lint: "node -e \"console.error('error  Unexpected console  no-console'); process.exit(1)\"",
    },
  });

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000 });
  assert.equal(result.ok, false);
  assert.match(result.report, /lint failed/i);
});

test("fails with a report when the build script exits non-zero", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeFixture(root, { name: "fixture", version: "0.0.0", scripts: { build: "exit 1" } });

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000 });
  assert.equal(result.ok, false);
  assert.match(result.report, /build/i);
});

test("fails fast (not retryable-looking) when there is no build script at all", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeFixture(root, { name: "fixture", version: "0.0.0", scripts: {} });

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000 });
  assert.equal(result.ok, false);
  assert.match(result.report, /no "build" script/i);
});

test("detectPackageManager reads lockfiles", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await detectPackageManager(root), "npm"); // no lockfile -> default
  await writeFile(path.join(root, "pnpm-lock.yaml"), "");
  assert.equal(await detectPackageManager(root), "pnpm");
});

test("detectPackageManager's override wins even with a conflicting lockfile present", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "yarn.lock"), ""); // would normally pick yarn
  assert.equal(await detectPackageManager(root, "npm"), "npm");
  assert.equal(await detectPackageManager(root), "yarn"); // unchanged without an override
});

/* The target repo's stack isn't fixed (Next.js today, Laravel tomorrow) —
 * these cover the ecosystem-detection fallbacks beyond a root package.json. */

test("finds package.json one level down (monorepo/asset-subfolder repos)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "frontend"), { recursive: true });
  await makeFixture(path.join(root, "frontend"), { name: "fixture", version: "0.0.0", scripts: { build: "echo build-ok" } });

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000 });
  assert.equal(result.ok, true);
});

test("PHP/Laravel repo (composer.json, no package.json): no .php files created is a pass with a note", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "composer.json"), JSON.stringify({ name: "fixture/app" }));

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000, changedPaths: ["resources/views/campaigns/x/index.blade.php"] });
  assert.equal(result.ok, true);
  assert.match(result.report, /no plain \.php files/i);
});

test("neither package.json nor composer.json is an unrecognized-stack failure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await verifyBuild({ workdir: root, installTimeoutMs: 60_000, buildTimeoutMs: 60_000 });
  assert.equal(result.ok, false);
  assert.match(result.report, /composer\.json/i);
});

test("PHP syntax gate: passes clean files, fails a syntax error", { skip: await hasPhp() ? false : "php not installed in this environment" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "composer.json"), JSON.stringify({ name: "fixture/app" }));
  await mkdir(path.join(root, "app", "campaigns", "x"), { recursive: true });
  await writeFile(path.join(root, "app", "campaigns", "x", "Controller.php"), "<?php\nclass Controller {}\n");

  const ok = await verifyBuild({
    workdir: root,
    installTimeoutMs: 60_000,
    buildTimeoutMs: 60_000,
    changedPaths: ["app/campaigns/x/Controller.php"],
  });
  assert.equal(ok.ok, true);

  await writeFile(path.join(root, "app", "campaigns", "x", "Broken.php"), "<?php\nclass Broken {\n");
  const bad = await verifyBuild({
    workdir: root,
    installTimeoutMs: 60_000,
    buildTimeoutMs: 60_000,
    changedPaths: ["app/campaigns/x/Controller.php", "app/campaigns/x/Broken.php"],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.report, /php -l failed/i);
});

async function hasPhp() {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("php", ["-v"]);
    return true;
  } catch {
    return false;
  }
}
