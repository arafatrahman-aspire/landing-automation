import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyBuild, detectPackageManager } from "../src/verify/build.mjs";

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
