import * as runStore from "../state/campaign-repository.mjs";
import { validateGuide, truncateGuideFields } from "../schemas/content-guide-schema.mjs";
import { listFrameCandidates } from "../design-catalog/static-frame-catalog.mjs";
import { resolveSectionMode } from "../sections/classify-sections.mjs";
import { runCodegen } from "./run-campaign-pipeline.mjs";

/* The plan gate (v0.37) — the human step BEFORE anything gets generated.
 *
 * Deliberately mirrors approve-or-abandon-run.mjs, which is the same idea one
 * stage later: the graph ends, a status is recorded, and a SEPARATE, LATER
 * HTTP request rebuilds what it needs from the run store and carries on. No
 * LangGraph state survives in between (there is no checkpointer), and none is
 * needed — the only thing that has to persist is the guide, which
 * steps/03-generate-guide.mjs already writes to the run row.
 *
 * Why a gate here at all: steering the plan is free. It is four strings and a
 * section list, before a single coding-agent run has happened. Steering after
 * generation costs a full regeneration per change, which is why the refine
 * loop — the only control that existed before — is an expensive way to say
 * "actually, drop the pricing section".
 *
 * What "approve" does NOT do: replay a checkpoint. It re-drives the entire
 * pipeline via runCodegen() with the edited guide in the initial state.
 * research() and guide() short-circuit on their persisted results, so the
 * second pass effectively begins at classify_sections. This is exactly what
 * resume-interrupted-runs.mjs does for crash recovery — same mechanism,
 * different trigger. */

export class PlanActionError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason; // "not_found" | "wrong_status" | "invalid_plan"
  }
}

const GATE_STATUS = "awaiting_plan_approval";

async function loadRunAtGate(runId) {
  const run = await runStore.getRun(runId);
  if (!run) throw new PlanActionError("not_found", `no such run "${runId}"`);
  if (run.status !== GATE_STATUS) {
    throw new PlanActionError(
      "wrong_status",
      `run "${runId}" is not awaiting plan approval — status is "${run.status}". The plan can only be edited before generation starts.`
    );
  }
  if (!run.guide) {
    // Should be unreachable: the gate is only entered from a successful
    // guide(), which persists before returning. Loud rather than silent,
    // because a run parked here with nothing to review is a real defect.
    throw new Error(`run "${runId}" is at the plan gate but has no stored plan — this should be impossible`);
  }
  return run;
}

/**
 * The plan a human is being asked to approve, plus everything the UI needs to
 * offer real choices about it: which layouts each section type could use, and
 * how each section would be built if approved as-is.
 */
export async function getPlan(runId) {
  const run = await runStore.getRun(runId);
  if (!run) throw new PlanActionError("not_found", `no such run "${runId}"`);
  if (!run.guide) throw new PlanActionError("not_found", `run "${runId}" has no plan yet`);

  const aiRequired = run.request?.aiRequiredSections ?? [];

  return {
    editable: run.status === GATE_STATUS,
    status: run.status,
    guide: run.guide,
    sections: run.guide.sections.map((section) => ({
      ...section,
      // Same call classify-sections.mjs makes during the pipeline, so what the
      // UI promises and what the pipeline does cannot drift. Frame AVAILABILITY
      // isn't checked here (that needs the worktree, and this is a read of the
      // plan, not of the repo) — so a section shown as "static" can still
      // degrade to ai-required at classify time if its frame is missing.
      mode: resolveSectionMode(section.type, aiRequired),
      candidates: listFrameCandidates(section.type).map((c) => ({ id: c.id, description: c.description })),
    })),
  };
}

/**
 * Saves an edited plan without approving it, so a reviewer can work on it
 * across several visits. Re-validated through exactly the same
 * truncate-then-validate path the LLM's own output goes through in
 * steps/03-generate-guide.mjs — a human editing SEO copy overruns a length
 * limit at least as often as a model does, and there is no reason for the two
 * to be policed differently.
 */
export async function savePlan(runId, candidateGuide) {
  await loadRunAtGate(runId);

  const result = validateGuide(truncateGuideFields(candidateGuide));
  if (!result.ok) throw new PlanActionError("invalid_plan", result.errors);

  const hero = result.value.sections.filter((s) => s.type === "hero");
  if (hero.length !== 1 || result.value.sections[0]?.type !== "hero") {
    // The hero is the only section carrying the lead form, and verify's
    // hero-fit check assumes it is the first thing on the page. Enforced here
    // rather than in guideSchema so the schema stays a description of the
    // shape, not of this pipeline's rules.
    throw new PlanActionError("invalid_plan", "sections: there must be exactly one \"hero\", and it must be first");
  }

  await runStore.updateRun(runId, { guide: result.value });
  await runStore.appendLog(runId, "info", `plan: saved edits — ${result.value.sections.map((s) => s.type).join(", ")}`);
  return result.value;
}

/**
 * Approves the plan (optionally saving a final edit in the same call) and
 * lets the pipeline run on.
 *
 * Fire-and-forget, exactly like POST /campaigns and like resumeInterruptedRuns:
 * generation is minutes of clone + LLM + build, and the HTTP request that
 * approved it must not be held open for that. runCodegen sets the run's own
 * terminal status; the caller only learns that it started.
 */
export async function approvePlan(runId, { guide: editedGuide = null } = {}) {
  const run = await loadRunAtGate(runId);
  const guide = editedGuide ? await savePlan(runId, editedGuide) : run.guide;

  // A fresh pipeline execution gets a fresh retry budget — the counters belong
  // to one execution, and any left over from the pass that produced the plan
  // would silently deny this one its retries. Same reset resumeInterruptedRuns
  // performs for the same reason.
  await runStore.updateRun(runId, { status: "running", stage: "classify_sections", codeAttempts: 0, verifyAttempts: 0, error: null });
  await runStore.appendLog(runId, "info", "plan: approved — generating the page from the approved plan");

  runCodegen({
    runId,
    request: run.request,
    ...(run.researchNotes ? { researchNotes: run.researchNotes } : {}),
    guide,
    planApproved: true,
  }).catch(async (err) => {
    // runCodegen already recorded a status before rethrowing; this only stops
    // an unhandled rejection escaping the fire-and-forget call.
    await runStore.appendLog(runId, "error", `plan: generation failed after approval — ${err.message}`).catch(() => {});
  });

  return { ok: true, status: "running", guide };
}

/** Ends a run at the plan gate. Nothing was generated, nothing was committed —
 *  this only closes the record and releases the worktree for cleanup. */
export async function abandonAtPlan(runId) {
  await loadRunAtGate(runId);
  await runStore.updateRun(runId, { status: "abandoned", error: null });
  await runStore.appendLog(runId, "info", "plan: abandoned before generation — nothing was generated, committed or pushed");
  return { ok: true, status: "abandoned" };
}
