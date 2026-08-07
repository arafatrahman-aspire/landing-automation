import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

// A throwaway DB per test file — without this, DB_PATH falls back to the real
// ./data/campaigns.db and these tests would write into live data.
setTestConfigEnv({ DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "resume-runs-")), "test.db") });
const runStore = await import("../src/state/campaign-repository.mjs");
const { resumeInterruptedRuns } = await import("../src/pipeline/resume-interrupted-runs.mjs");

/* These cover the decision-making around resume — which runs get re-driven,
 * what state they carry forward — without letting a real pipeline start.
 * Anything that would actually invoke the graph (and therefore the LLM) is
 * kept out: this codebase never mocks the LLM, so the full resume path is
 * verified live, same convention as generate-sections. */

const BRIEF = {
  slug: "resume-test",
  campaignName: "Resume Test",
  offer: "x",
  audience: "y",
  cta: "z",
  brief: "",
};

test("a run with no stored brief is failed, not re-driven into a crash", async () => {
  const runId = "resume-no-brief";
  // createRun without a `request` — nothing to rebuild the pipeline from.
  await runStore.createRun({ runId, slug: "nb", campaignName: "NB" });
  await runStore.updateRun(runId, { status: "running" });

  const { resumed, skipped } = await resumeInterruptedRuns({ runIds: [runId] });

  assert.equal(resumed, 0);
  assert.equal(skipped, 1);
  const run = await runStore.getRun(runId);
  assert.equal(run.status, "failed");
  assert.match(run.error, /no stored campaign brief/);
});

test("an unknown runId is skipped rather than throwing", async () => {
  const { resumed, skipped } = await resumeInterruptedRuns({ runIds: ["does-not-exist"] });
  assert.equal(resumed, 0);
  assert.equal(skipped, 1);
});

test("resuming resets the per-attempt retry counters so a re-driven run gets a full budget", async () => {
  const runId = "resume-counters";
  await runStore.createRun({ runId, slug: BRIEF.slug, campaignName: BRIEF.campaignName, request: BRIEF });
  // Simulate dying mid-generation after burning the retry budget.
  await runStore.updateRun(runId, { status: "running", stage: "generate_sections", codeAttempts: 2, verifyAttempts: 2, error: "boom" });

  await resumeInterruptedRuns({ runIds: [runId] });

  const run = await runStore.getRun(runId);
  assert.equal(run.codeAttempts, 0, "retry budget must reset for the new execution");
  assert.equal(run.verifyAttempts, 0);
  assert.equal(run.error, null, "the pre-crash error must be cleared");

  // It logged its own resume for a human reading the run log later.
  const log = await runStore.getFullLog(runId);
  assert.match(log, /resume: service restarted/);
});

test("the resume log records that a persisted content plan is being reused", async () => {
  const runId = "resume-with-guide";
  await runStore.createRun({ runId, slug: BRIEF.slug, campaignName: BRIEF.campaignName, request: BRIEF });
  await runStore.updateRun(runId, {
    status: "running",
    stage: "generate_sections",
    guide: { heroTitle: "T", sections: [{ type: "hero", summary: "s" }] },
  });

  await resumeInterruptedRuns({ runIds: [runId] });

  const log = await runStore.getFullLog(runId);
  assert.match(log, /reusing the persisted content plan/);
});
