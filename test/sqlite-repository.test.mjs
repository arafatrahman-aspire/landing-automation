import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv({ DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "sqlite-repo-")), "test.db") });

// Dynamic import: config.mjs (pulled in transitively via state/db.mjs) must
// see the env above before its first import, so this can't be a static
// top-of-file import.
const repo = await import("../src/state/repository.mjs");

test("createRun -> getRun round-trips the campaign fields and starts in a sane initial state", async () => {
  const runId = "run-1";
  await repo.createRun({ runId, slug: "spring-sale", campaignName: "Spring Sale", request: { offer: "20% off" } });
  const run = await repo.getRun(runId);
  assert.equal(run.slug, "spring-sale");
  assert.equal(run.campaignName, "Spring Sale");
  assert.equal(run.status, "queued");
  assert.equal(run.stage, "intake");
  assert.equal(run.codeAttempts, 0);
  assert.equal(run.verifyAttempts, 0);
  assert.equal(run.guide, null);
  assert.equal(run.logTail.length, 1);
  assert.match(run.logTail[0].message, /run created/);
});

test("getRun returns null for a run that doesn't exist", async () => {
  assert.equal(await repo.getRun("no-such-run"), null);
});

test("updateRun merges scalar and JSON-serialized fields, and rejects an unknown runId", async () => {
  const runId = "run-2";
  await repo.createRun({ runId, slug: "x", campaignName: "X" });

  await repo.updateRun(runId, { branchName: "codegen/x-1234" });
  let run = await repo.getRun(runId);
  assert.equal(run.branchName, "codegen/x-1234");

  const guide = { heroTitle: "Hi", heroHasVideo: false, seoTitle: "Hi", seoMetaDescription: "d", sections: [] };
  await repo.updateRun(runId, { guide, verifyAttempts: 2 });
  run = await repo.getRun(runId);
  assert.deepEqual(run.guide, guide);
  assert.equal(run.verifyAttempts, 2);

  await assert.rejects(() => repo.updateRun("nope", { status: "failed" }), /no such run/);
});

test("heartbeat updates stage and heartbeatAt", async () => {
  const runId = "run-3";
  await repo.createRun({ runId, slug: "x", campaignName: "X" });
  await repo.heartbeat(runId, "clone");
  const run = await repo.getRun(runId);
  assert.equal(run.stage, "clone");
  assert.ok(run.heartbeatAt);
});

test("appendLog accumulates lines in order and getFullLog renders them as plain text", async () => {
  const runId = "run-4";
  await repo.createRun({ runId, slug: "x", campaignName: "X" });
  await repo.appendLog(runId, "info", "first");
  await repo.appendLog(runId, "error", "second");
  const log = await repo.getFullLog(runId);
  const lines = log.trim().split("\n");
  assert.equal(lines.length, 3); // "run created" + the two appended
  assert.match(lines[1], /\[info\] first/);
  assert.match(lines[2], /\[error\] second/);
});

test("getFullLog returns null for a nonexistent run", async () => {
  assert.equal(await repo.getFullLog("no-such-run"), null);
});

test("logTail on getRun is capped and reflects the most recent entries", async () => {
  const runId = "run-5";
  await repo.createRun({ runId, slug: "x", campaignName: "X" });
  for (let i = 0; i < 60; i++) {
    await repo.appendLog(runId, "info", `line ${i}`);
  }
  const run = await repo.getRun(runId);
  assert.equal(run.logTail.length, 50);
  assert.equal(run.logTail.at(-1).message, "line 59");
});

test("listRuns returns every run", async () => {
  const runs = await repo.listRuns();
  const ids = runs.map((r) => r.runId);
  assert.ok(ids.includes("run-1"));
  assert.ok(ids.includes("run-4"));
});

test("isTerminal recognizes terminal vs. in-flight statuses", () => {
  assert.equal(repo.isTerminal("completed"), true);
  assert.equal(repo.isTerminal("failed_verification"), true);
  assert.equal(repo.isTerminal("running"), false);
  assert.equal(repo.isTerminal("queued"), false);
});

test("deleteRun refuses a non-terminal run (409-equivalent) and a missing one (404-equivalent)", async () => {
  const runId = "run-6";
  await repo.createRun({ runId, slug: "x", campaignName: "X" });
  await repo.updateRun(runId, { status: "running" });

  const notTerminal = await repo.deleteRun(runId);
  assert.deepEqual(notTerminal, { ok: false, reason: "not_terminal", status: "running" });

  const notFound = await repo.deleteRun("no-such-run");
  assert.deepEqual(notFound, { ok: false, reason: "not_found" });
});

test("deleteRun removes a terminal run's record and logs entirely", async () => {
  const runId = "run-7";
  await repo.createRun({ runId, slug: "x", campaignName: "X" });
  await repo.updateRun(runId, { status: "completed" });

  const result = await repo.deleteRun(runId);
  assert.deepEqual(result, { ok: true });
  assert.equal(await repo.getRun(runId), null);
  assert.equal(await repo.getFullLog(runId), null);
});

test("reconcileCrashedRuns marks non-terminal runs failed, distinguishing an already-pushed branch", async () => {
  const runId = "run-8";
  await repo.createRun({ runId, slug: "x", campaignName: "X" });
  await repo.updateRun(runId, { status: "pushing", branchName: "codegen/x-9999" });

  const runId2 = "run-9";
  await repo.createRun({ runId: runId2, slug: "y", campaignName: "Y" });
  await repo.updateRun(runId2, { status: "running" });

  const count = await repo.reconcileCrashedRuns();
  assert.ok(count >= 2);

  const run1 = await repo.getRun(runId);
  assert.equal(run1.status, "failed_push_incomplete");
  assert.match(run1.error, /codegen\/x-9999/);

  const run2 = await repo.getRun(runId2);
  assert.equal(run2.status, "failed");
});
