import path from "node:path";
import { config } from "../config.mjs";
import * as runStore from "../state/campaign-repository.mjs";
import * as draftStore from "../staging/draft-versions.mjs";
import * as preview from "../preview/preview-server.mjs";
import { removeWorktree } from "../git/clone-and-commit.mjs";
import { commit, push, openPr } from "./steps/commit-push-and-open-pr.mjs";

/* Phase 7 (new_plan.md §6/§9.9) — the actual human approval gate. Nothing
 * reaches git until one of these is explicitly called, from a SEPARATE,
 * LATER HTTP request than the one that generated the run (server.mjs's
 * POST /campaigns/:runId/approve|abandon) — the in-process LangGraph state
 * from generate_sections is long gone by then (no checkpointer in v1), so
 * every function here rebuilds what it needs from run-store + the staged
 * draft instead of from live graph state.
 *
 * Deliberately NOT built here: reject-with-feedback-and-regenerate. That
 * needs a feedback UI and a way to re-enter section generation against a
 * specific run, which is naturally paired with the per-section refine UI
 * (module.md Module 4) — building it standalone now would mean throwing
 * it away/reshaping it once that UI exists. Approve/abandon are the two
 * outcomes that don't depend on anything not built yet. */

class ReviewActionError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason; // "not_found" | "wrong_status"
  }
}

function baseCloneDir() {
  return path.join(path.resolve(config.workdirRoot), "_base");
}

/** True when `workdir` is a per-run scratch tree under WORKDIR_ROOT, not the
 *  shared `_base` clone and not some other path (tests use temp clones). */
function isScratchWorktree(workdir) {
  if (!workdir) return false;
  const root = path.resolve(config.workdirRoot);
  const target = path.resolve(workdir);
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && target !== path.join(root, "_base");
}

/** After a PR is opened (or a run is abandoned), the local worktree + its
 *  `node_modules` are only wasting disk. Stop any preview first so file
 *  handles are released, then delete the worktree and its local git branch. */
async function discardScratchWorktree(runId, { workdir, branchName }) {
  await preview.stopPreview({ runId, baseDir: baseCloneDir() }).catch(() => {});
  if (!isScratchWorktree(workdir)) return { ok: true, skipped: true };
  const result = await removeWorktree({ baseDir: baseCloneDir(), workdir, branchName }).catch((err) => ({
    ok: false,
    reason: err.message,
  }));
  await runStore.updateRun(runId, { workdir: null });
  if (result?.ok === false) {
    await runStore.appendLog(runId, "warn", `scratch worktree could not be removed — ${result.reason}`);
  } else {
    await runStore.appendLog(runId, "info", `discarded local worktree and branch "${branchName}" to free disk`);
  }
  return result;
}

/** Rebuilds the fields commit()/push()/openPr() (pipeline/steps/)
 *  need, straight from run-store + the latest staged draft — those
 *  functions were written to take a LangGraph-shaped state object, and
 *  still do; this is the only place outside the graph that constructs one. */
async function reconstructApprovedState(runId) {
  const run = await runStore.getRun(runId);
  if (!run) throw new ReviewActionError("not_found", `no such run "${runId}"`);
  if (run.status !== "staged_for_review") {
    throw new ReviewActionError("wrong_status", `cannot approve run "${runId}" — status is "${run.status}", not "staged_for_review"`);
  }

  const draft = await draftStore.getLatestVersion(runId);
  if (!draft || draft.files.length === 0) {
    throw new Error(`approveRun: run "${runId}" is staged_for_review but has no staged draft — this should be impossible`);
  }

  const activePreview = await preview.getPreview(runId);

  return {
    runId,
    request: run.request,
    workdir: run.workdir,
    baseDir: baseCloneDir(),
    branchName: run.branchName,
    writtenByAgent: new Set(draft.files.map((f) => f.path)),
    agentSummary: run.agentSummary,
    sectionResults: run.sectionResults,
    guide: run.guide,
    verifyReport: null, // only reachable here after a PASSING verify
    previewStarted: Boolean(activePreview),
  };
}

// Mirror graph.mjs's STAGE_FAILURE_STATUS — commit/push/open_pr no longer
// run inside graph.invoke()'s try/catch (Phase 7), so this is the
// equivalent safety net for this path.
const APPROVE_STAGE_FAILURE_STATUS = { committing: "failed", pushing: "failed_push", opening_pr: "failed_push" };

/** Approve: commit -> push -> open PR, then delete the local scratch
 *  worktree (and stop its preview) so node_modules does not sit on disk. */
export async function approveRun(runId) {
  const state = await reconstructApprovedState(runId);
  await runStore.updateRun(runId, { status: "approved" });
  try {
    await commit(state);
    await push(state);
    const result = await openPr(state);
    // PR is on the remote now — the local worktree (often hundreds of MB of
    // node_modules) must not linger. Preview is stopped first so it cannot
    // keep the directory open.
    await discardScratchWorktree(runId, { workdir: state.workdir, branchName: state.branchName });
    return { ok: true, ...result };
  } catch (err) {
    const current = await runStore.getRun(runId);
    const status = APPROVE_STAGE_FAILURE_STATUS[current?.stage] ?? "failed";
    await runStore.appendLog(runId, "error", err.stack ?? err.message);
    await runStore.updateRun(runId, { status, error: err.message });
    throw err;
  }
}

/** Abandon: the human explicitly declines to ship this run. Terminal —
 *  stops any active preview and removes the worktree (same cleanup
 *  approveRun's success path would eventually do), but commits nothing. */
export async function abandonRun(runId) {
  const run = await runStore.getRun(runId);
  if (!run) throw new ReviewActionError("not_found", `no such run "${runId}"`);
  if (runStore.isTerminal(run.status)) {
    throw new ReviewActionError("wrong_status", `run "${runId}" is already terminal (status "${run.status}")`);
  }

  await discardScratchWorktree(runId, { workdir: run.workdir, branchName: run.branchName });
  await runStore.updateRun(runId, { status: "abandoned" });
  await runStore.appendLog(runId, "info", "abandoned by human decision — no commit/push/PR happened");
  return { ok: true, status: "abandoned" };
}

export { ReviewActionError, isScratchWorktree };
