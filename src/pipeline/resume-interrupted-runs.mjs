import * as runStore from "../state/campaign-repository.mjs";
import { runCodegen } from "./run-campaign-pipeline.mjs";

/* Crash resume. This service holds no LangGraph checkpointer — the whole
 * in-process graph state vanishes the moment the process dies — so "resume"
 * here means re-driving the pipeline from the start while reusing every
 * expensive result that WAS persisted, rather than restoring a mid-graph
 * snapshot.
 *
 * What that saves in practice: the research call and the guide call both
 * short-circuit when their output is already in the database (see
 * steps/02-research.mjs and steps/03-generate-guide.mjs), so a resumed run
 * skips straight past them.
 *
 * What it deliberately does NOT try to save: the generated section files.
 * A resumed run gets a fresh `git worktree` (the old one is untrustworthy —
 * it may hold a half-written file from the moment the process died), and a
 * fresh worktree has no section files in it, so they must be regenerated
 * regardless. Trying to replay them out of draft_files would mean trusting a
 * draft that was never verified.
 *
 * Which runs get here at all is decided by reconcileCrashedRuns()
 * (state/sqlite-campaign-repository.mjs): anything mid-generation is
 * resumable, anything already inside the commit/push/PR sequence is NOT (it
 * can't be re-driven without risking a double push) and anything sitting at
 * staged_for_review isn't crashed in the first place. */

/**
 * Re-drives every run left mid-generation by a previous process lifetime.
 * Failures are contained per-run: one run that can't be resumed is logged and
 * marked failed, never allowed to take down server boot.
 *
 * @param {object} [opts]
 * @param {string[]} opts.runIds - from reconcileCrashedRuns().resumable
 * @param {(msg: string) => void} [opts.logger]
 * @returns {Promise<{resumed: number, skipped: number}>}
 */
export async function resumeInterruptedRuns({ runIds = [], logger = () => {} } = {}) {
  let resumed = 0;
  let skipped = 0;

  for (const runId of runIds) {
    const run = await runStore.getRun(runId);
    if (!run) {
      skipped++;
      continue;
    }

    // The brief is the one input the pipeline cannot reconstruct or do
    // without. Its absence means the campaign row is corrupt, not that the
    // run is mid-flight — there's nothing to resume from.
    if (!run.request) {
      await runStore.updateRun(runId, {
        status: "failed",
        error: "Process restarted while this run was in progress, and it has no stored campaign brief to resume from.",
      });
      await runStore.appendLog(runId, "error", "resume: no stored brief — cannot re-drive this run");
      skipped++;
      continue;
    }

    logger(`resuming run ${runId} (was "${run.status}" at stage "${run.stage ?? "?"}")`);
    await runStore.appendLog(
      runId,
      "info",
      `resume: service restarted while this run was at stage "${run.stage ?? "?"}" — re-driving the pipeline, reusing the persisted ${
        run.guide ? "content plan" : "brief"
      }`
    );

    // Reset the per-attempt counters: the retry budget belongs to a single
    // pipeline execution, and a resumed run is starting a new one. Leaving
    // them at their pre-crash values could deny a fresh run its retries.
    await runStore.updateRun(runId, { status: "running", codeAttempts: 0, verifyAttempts: 0, error: null });

    // Same shape server.mjs uses for a brand-new run, plus the persisted
    // results the steps use to skip their own LLM calls.
    const initialState = {
      runId,
      request: run.request,
      ...(run.researchNotes ? { researchNotes: run.researchNotes } : {}),
      ...(run.guide ? { guide: run.guide } : {}),
    };

    // Fire-and-forget, exactly like POST /campaigns: boot must not block on
    // a full campaign pipeline (clone + LLM + build can run for minutes).
    // runCodegen sets the run's own terminal status; this catch only stops an
    // unhandled rejection from escaping.
    runCodegen(initialState).catch((err) => {
      logger(`resumed run ${runId} failed: ${err.message}`);
    });
    resumed++;
  }

  return { resumed, skipped };
}
