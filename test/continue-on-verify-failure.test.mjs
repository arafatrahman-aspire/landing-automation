import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

/* CONTINUE_ON_VERIFY_FAILURE: when verify still fails after every retry, stage
 * the draft for review anyway instead of ending the run. Deliberately opt-in —
 * approving such a draft opens a PR with code that does not compile, so the
 * run is flagged and the review UI warns about it. */

setTestConfigEnv({
  DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "continue-verify-")), "test.db"),
  CONTINUE_ON_VERIFY_FAILURE: "true",
  MAX_CODE_ATTEMPTS: "2",
});

const { config } = await import("../src/config.mjs");
const runStore = await import("../src/state/campaign-repository.mjs");
const { decideAfterVerify } = await import("../src/pipeline/decide-after-verify.mjs");

test("the flag is read from the environment", () => {
  assert.equal(config.continueOnVerifyFailure, true);
});

test("a failing build with retries left still retries — the flag doesn't short-circuit repair", () => {
  const route = decideAfterVerify(
    { verifyPassed: false, codeAttempts: 1 },
    { continueOnVerifyFailure: true, maxCodeAttempts: 2 }
  );
  assert.equal(route, "generate_sections");
});

test("with retries exhausted, the flag stages instead of ending the run", () => {
  const withFlag = decideAfterVerify(
    { verifyPassed: false, codeAttempts: 2 },
    { continueOnVerifyFailure: true, maxCodeAttempts: 2 }
  );
  const withoutFlag = decideAfterVerify(
    { verifyPassed: false, codeAttempts: 2 },
    { continueOnVerifyFailure: false, maxCodeAttempts: 2 }
  );
  assert.equal(withFlag, "stage_draft");
  assert.equal(withoutFlag, "end", "default behavior must be unchanged");
});

test("a passing build is unaffected by the flag", () => {
  assert.equal(
    decideAfterVerify({ verifyPassed: true, codeAttempts: 2 }, { continueOnVerifyFailure: true, maxCodeAttempts: 2 }),
    "stage_draft"
  );
});

test("verifyBypassed round-trips so the review UI can warn about an unbuildable draft", async () => {
  const runId = "run-bypassed";
  await runStore.createRun({ runId, slug: "b", campaignName: "B" });

  assert.equal((await runStore.getRun(runId)).verifyBypassed, false, "defaults to false");

  await runStore.updateRun(runId, { verifyBypassed: true, status: "staged_for_review", error: "Verification FAILED but staged anyway" });
  const run = await runStore.getRun(runId);
  assert.equal(run.verifyBypassed, true);
  assert.equal(run.status, "staged_for_review");
  assert.match(run.error, /FAILED/);
});
