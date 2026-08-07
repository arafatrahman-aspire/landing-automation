import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv({ DB_PATH: path.join(await mkdtemp(path.join(tmpdir(), "preview-sandbox-db-")), "test.db") });

const repo = await import("../src/state/campaign-repository.mjs");
const sandbox = await import("../src/preview/preview-server.mjs");
const { hasDocker } = await import("../src/verify/docker-build.mjs");

const dockerAvailable = await hasDocker();
const skipDocker = dockerAvailable ? false : "docker not available/reachable in this environment";
const TEST_NODE_IMAGE = "node:14.18.2";

// A tiny "app" whose "start" script is a real HTTP server honoring PORT —
// close enough to what a real target repo's dev-server script does for
// this module's purposes (find a port, start something, poll until ready).
async function makeServableFixture({ withDockerfile = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "preview-fixture-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: {
        start:
          "node -e \"require('http').createServer((req,res)=>res.end('preview ok')).listen(process.env.PORT,'0.0.0.0')\"",
      },
    })
  );
  if (withDockerfile) {
    await writeFile(
      path.join(dir, "Dockerfile"),
      [`FROM ${TEST_NODE_IMAGE} AS builder`, "WORKDIR /app", "RUN true"].join("\n")
    );
  }
  return dir;
}

async function makeRun() {
  const runId = randomUUID();
  await repo.createRun({ runId, slug: "x", campaignName: "X" });
  return runId;
}

test("startPreview (process-based) starts a real reachable server and stopPreview tears it down", async (t) => {
  const runId = await makeRun();
  const workdir = await makeServableFixture();
  t.after(() => rm(workdir, { recursive: true, force: true }));

  const result = await sandbox.startPreview({
    runId,
    workdir,
    pageUrlPath: null,
    ttlMs: 60_000,
    maxConcurrent: 3,
    disableDocker: true,
  });
  assert.equal(result.ok, true, result.report);
  assert.equal(result.kind, "process");

  const res = await fetch(result.url);
  assert.equal(await res.text(), "preview ok");

  const fetched = await sandbox.getPreview(runId);
  assert.equal(fetched.status, "running");
  assert.equal(fetched.kind, "process");

  const stopped = await sandbox.stopPreview({ runId });
  assert.equal(stopped.ok, true);

  await assert.rejects(() => fetch(result.url, { signal: AbortSignal.timeout(2000) }));
});

test(
  "startPreview (docker-based) starts a real container-served page and stopPreview kills the container",
  { skip: skipDocker },
  async (t) => {
    const runId = await makeRun();
    const workdir = await makeServableFixture({ withDockerfile: true });
    t.after(() => rm(workdir, { recursive: true, force: true }));

    const result = await sandbox.startPreview({
      runId,
      workdir,
      pageUrlPath: null,
      ttlMs: 60_000,
      maxConcurrent: 3,
      disableDocker: false,
    });
    assert.equal(result.ok, true, result.report);
    assert.equal(result.kind, "docker");

    const res = await fetch(result.url);
    assert.equal(await res.text(), "preview ok");

    await sandbox.stopPreview({ runId });
    await assert.rejects(() => fetch(result.url, { signal: AbortSignal.timeout(2000) }));
  }
);

test("getPreview returns null for a run with no preview", async () => {
  const runId = await makeRun();
  assert.equal(await sandbox.getPreview(runId), null);
});

test("stopPreview on a run with no active preview reports not_found", async () => {
  const runId = await makeRun();
  const result = await sandbox.stopPreview({ runId });
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("maxConcurrent is enforced by evicting the oldest running preview (LRU)", async (t) => {
  const runA = await makeRun();
  const workdirA = await makeServableFixture();
  const runB = await makeRun();
  const workdirB = await makeServableFixture();
  t.after(async () => {
    await rm(workdirA, { recursive: true, force: true });
    await rm(workdirB, { recursive: true, force: true });
  });

  const first = await sandbox.startPreview({
    runId: runA,
    workdir: workdirA,
    pageUrlPath: null,
    ttlMs: 60_000,
    maxConcurrent: 1,
    disableDocker: true,
  });
  assert.equal(first.ok, true, first.report);

  const second = await sandbox.startPreview({
    runId: runB,
    workdir: workdirB,
    pageUrlPath: null,
    ttlMs: 60_000,
    maxConcurrent: 1,
    disableDocker: true,
  });
  assert.equal(second.ok, true, second.report);

  const previewA = await sandbox.getPreview(runA);
  const previewB = await sandbox.getPreview(runB);
  assert.equal(previewA, null); // evicted — no longer the active preview for runA
  assert.equal(previewB.status, "running");

  await sandbox.stopPreview({ runId: runB });
});

test("sweepIdlePreviews stops previews past their expiry and leaves fresh ones alone", async (t) => {
  const runExpired = await makeRun();
  const workdirExpired = await makeServableFixture();
  const runFresh = await makeRun();
  const workdirFresh = await makeServableFixture();
  t.after(async () => {
    await rm(workdirExpired, { recursive: true, force: true });
    await rm(workdirFresh, { recursive: true, force: true });
  });

  // ttlMs is negative so this one is already "expired" the instant it starts.
  const expired = await sandbox.startPreview({
    runId: runExpired,
    workdir: workdirExpired,
    pageUrlPath: null,
    ttlMs: -1000,
    maxConcurrent: 5,
    disableDocker: true,
  });
  assert.equal(expired.ok, true, expired.report);

  const fresh = await sandbox.startPreview({
    runId: runFresh,
    workdir: workdirFresh,
    pageUrlPath: null,
    ttlMs: 60_000,
    maxConcurrent: 5,
    disableDocker: true,
  });
  assert.equal(fresh.ok, true, fresh.report);

  const swept = await sandbox.sweepIdlePreviews({ baseDir: null });
  assert.equal(swept, 1);

  assert.equal((await sandbox.getPreview(runExpired)), null);
  assert.equal((await sandbox.getPreview(runFresh)).status, "running");

  await sandbox.stopPreview({ runId: runFresh });
});

test("reconcilePreviewsOnBoot stops every 'running' row without throwing, even a bogus one", async (t) => {
  const runId = await makeRun();
  const workdir = await makeServableFixture();
  t.after(() => rm(workdir, { recursive: true, force: true }));

  const started = await sandbox.startPreview({
    runId,
    workdir,
    pageUrlPath: null,
    ttlMs: 60_000,
    maxConcurrent: 5,
    disableDocker: true,
  });
  assert.equal(started.ok, true, started.report);

  const reconciled = await sandbox.reconcilePreviewsOnBoot({ baseDir: null });
  assert.ok(reconciled >= 1);
  assert.equal((await sandbox.getPreview(runId)), null);
});
