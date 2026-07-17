import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
