import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { config } from "../config.mjs";
import * as steps from "./steps/index.mjs";
import * as runStore from "../state/campaign-repository.mjs";
import { decideAfterVerify } from "./decide-after-verify.mjs";

/* LangGraph state machine (mirrors the parent project's
 * scripts/campaign/lib/graph.mjs pattern — StateGraph + a single
 * "retry once, then halt, never proceed on a failed gate" conditional edge):
 *
 *   intake -> research -> clone -> generate_guide -> classify_sections -> generate_sections -> verify
 *                                                                                            ▲       │
 *                                                                                            └retry──┘ (codeAttempts < MAX_CODE_ATTEMPTS)
 *                                                                                                    │ pass
 *                                                          stage_draft -> preview_build -> END (status: staged_for_review)
 *
 * THE PLAN GATE (v0.37): generate_guide has a conditional edge. On the first
 * pass it ends the graph at `awaiting_plan_approval` — the plan exists, and
 * nothing has been generated from it. A human edits the hero copy, SEO tags
 * and section list, approves, and pipeline/approve-or-edit-plan.mjs re-drives
 * runCodegen() from the top with `planApproved: true` and the edited guide in
 * the initial state; research() and guide() both short-circuit on their own
 * persisted results, so the second pass costs nothing extra and starts at
 * classify_sections in practice. No checkpointer is involved — this is the
 * same re-drive mechanism resume-interrupted-runs.mjs uses for crash recovery.
 *
 * `clone` happens BEFORE guide (not after, as you might expect) because the
 * target repo's actual stack isn't fixed — it could be Next.js, Laravel,
 * Vue, plain HTML, whatever — and guide needs to see the real repo (via a
 * lightweight scan, steps.detectRepoConventions) to choose real file
 * extensions/conventions, instead of guessing blind.
 *
 * new_plan.md §9 (Hybrid Section Assembly) replaced the old single whole-page
 * `file_manifest` -> `code` pair with `classify_sections` (pure, no LLM —
 * sections/classify-sections.mjs decides static vs. ai-required per section) ->
 * `generate_sections` (the fan-out: static sections templated directly,
 * each ai-required section its own independent coding-agent run, all
 * concurrent — sections/generate-sections.mjs). Every file's path is now
 * deterministic, so there's nothing left for an upfront file_manifest LLM
 * call to plan. A verify retry re-enters at `generate_sections`, not
 * `classify_sections` — mode/frameId don't change because a build broke.
 *
 * Phase 7 (new_plan.md §6/§9.9): commit/push/open_pr are NO LONGER graph
 * nodes. The graph's only job is to get a verified, previewable draft
 * staged — it now ends at `preview_build` either way (success or a verify
 * failure that exhausts retries), and runCodegen() below sets the run's
 * final status from `state.verifyPassed` alone, not from reaching a
 * particular node. commit/push/open_pr moved to plain async functions
 * (pipeline/approve-or-abandon-run.mjs: approveRun/abandonRun), invoked by a
 * SEPARATE, LATER API request once a human approves — this graph's
 * in-process state is long gone by then (no checkpointer in v1), so
 * approveRun reconstructs what it needs from the campaign-repository state
 * + the staged draft instead of from LangGraph state. Nothing reaches git
 * until that happens: no commit, no branch, no push, ever, from this graph alone. */

const CodegenState = Annotation.Root({
  runId: Annotation(),
  request: Annotation(), // validated brief (schemas/campaign-brief-schema.mjs)
  researchNotes: Annotation(),
  guide: Annotation(),
  classifiedSections: Annotation(), // sections/classify-sections.mjs output
  sectionResults: Annotation(), // sections/generate-sections.mjs per-section results
  workdir: Annotation(),
  baseDir: Annotation(),
  branchName: Annotation(),
  pristineFiles: Annotation(), // Set<string> — snapshot right after clone
  writtenByAgent: Annotation(),
  agentSummary: Annotation(),
  codeFinished: Annotation(),
  verifyPassed: Annotation(),
  verifyReport: Annotation(),
  verifyBypassed: Annotation(),
  // True when the build failed only in files outside this campaign's allowlist
  // (target repo does not build on its own). Skips the generate_sections retry.
  verifyForeignFailure: Annotation(),
  verifyAttempts: Annotation({ reducer: (_prev, next) => next, default: () => 0 }),
  codeAttempts: Annotation({ reducer: (_prev, next) => next, default: () => 0 }),
  prUrl: Annotation(),
  prNumber: Annotation(),
  status: Annotation(),
  previewStarted: Annotation(),
  // The plan gate (v0.37). False/absent on the first pass, so the graph stops
  // after generate_guide; approve-or-edit-plan.mjs re-drives the whole
  // pipeline with this true, and the second pass runs straight through.
  planApproved: Annotation(),
});

/* Stop after the plan and wait for a human, or carry straight on?
 *
 * Steering the plan is free — it's four fields and a section list, before a
 * single LLM coding run has happened. Steering after generation costs a full
 * regeneration per change. So the gate defaults ON, per campaign
 * (`brief.reviewPlan`) falling back to REVIEW_PLAN_BEFORE_GENERATING.
 *
 * The second pass is not a resume from a checkpoint — there is no
 * checkpointer. approvePlan() re-drives runCodegen() from the top with the
 * persisted (and possibly human-edited) guide in the initial state, and both
 * research() and guide() short-circuit on their own persisted results. That
 * is exactly the mechanism resume-interrupted-runs.mjs already uses for crash
 * recovery, which is why this gate needed no new graph entry point. */
function routeAfterGuide(state) {
  if (state.planApproved) return "classify_sections";
  const wantsGate = state.request?.reviewPlan ?? config.reviewPlanBeforeGenerating;
  return wantsGate ? END : "classify_sections";
}

function routeAfterVerify(state) {
  const decision = decideAfterVerify(state, {
    maxCodeAttempts: config.maxCodeAttempts,
    continueOnVerifyFailure: config.continueOnVerifyFailure,
  });
  return decision === "end" ? END : decision;
}

export function createCodegenGraph() {
  return new StateGraph(CodegenState)
    .addNode("intake", steps.intake)
    .addNode("research", steps.research)
    .addNode("clone", steps.clone)
    // node can't share a name with the "guide" state channel
    .addNode("generate_guide", steps.guide)
    .addNode("classify_sections", steps.classifySectionsStep)
    .addNode("generate_sections", steps.generateSectionsStep)
    .addNode("verify", steps.verify)
    .addNode("stage_draft", steps.stageDraft)
    .addNode("preview_build", steps.previewBuild)
    .addEdge(START, "intake")
    .addEdge("intake", "research")
    .addEdge("research", "clone")
    .addEdge("clone", "generate_guide")
    .addConditionalEdges("generate_guide", routeAfterGuide)
    .addEdge("classify_sections", "generate_sections")
    .addEdge("generate_sections", "verify")
    .addConditionalEdges("verify", routeAfterVerify)
    .addEdge("stage_draft", "preview_build")
    .addEdge("preview_build", END)
    .compile();
}

// Node name -> the run status to record if an exception is thrown while
// that node was active (heartbeat's `stage` field, set by every step in
// pipeline/steps/, tells us which one was running). committing/pushing/
// opening_pr aren't reachable from THIS graph anymore (Phase 7) — they're
// covered by approve-or-abandon-run.mjs's own try/catch instead.
const STAGE_FAILURE_STATUS = {
  clone: "failed_clone",
  classify_sections: "failed",
  generate_sections: "failed",
  verify: "failed_verification",
  stage_draft: "failed",
  preview_build: "failed", // shouldn't fire — previewBuild() catches its own failures and never throws
};

/**
 * Runs the graph for one campaign request and guarantees the run-store
 * record ends in an informative status even for exceptions no explicit halt
 * path covers (e.g. an unexpected error mid-verify). The graph itself now
 * always ends at `preview_build` on the success path or END directly on a
 * retry-exhausted verify failure (Phase 7 — see the header comment above) —
 * `state.verifyPassed` is what actually distinguishes those two, not which
 * node was reached, since both paths reach END/return the same way.
 */
export async function runCodegen(initialState) {
  const graph = createCodegenGraph();
  await runStore.updateRun(initialState.runId, { status: "running" });
  try {
    const final = await graph.invoke(initialState);

    // Stopped at the plan gate (routeAfterGuide). Distinguishable from every
    // other END by having a guide but no verify outcome at all — nothing was
    // generated, so verifyPassed/verifyBypassed/verifyReport are all unset.
    // Checked FIRST: a run that never reached verify must not fall through to
    // the "retries exhausted" branch below and be marked failed.
    if (final.guide && !final.planApproved && final.verifyPassed === undefined && final.verifyBypassed === undefined) {
      await runStore.updateRun(initialState.runId, { status: "awaiting_plan_approval", stage: "awaiting_plan_approval" });
      await runStore.appendLog(
        initialState.runId,
        "info",
        `plan: ready for review — ${final.guide.sections.length} section(s): ${final.guide.sections.map((s) => s.type).join(", ")}. ` +
          `Nothing has been generated yet; edit the plan and approve it to continue.`
      );
      return final;
    }

    if (!final.verifyPassed && final.verifyBypassed) {
      // Staged despite a failing build (CONTINUE_ON_VERIFY_FAILURE). It still
      // reaches review — but the report is kept on the run so the UI and the
      // reviewer can see exactly what didn't compile.
      await runStore.updateRun(initialState.runId, {
        status: "staged_for_review",
        error: `Verification FAILED but the draft was staged anyway (CONTINUE_ON_VERIFY_FAILURE=true). This page is NOT known to build:\n\n${final.verifyReport ?? "(no report)"}`,
      });
    } else if (final.verifyPassed) {
      // Success path: generate_sections -> verify(pass) -> stage_draft ->
      // preview_build -> END. Nothing has been committed/pushed — the run
      // now waits for a human (approveRun/abandonRun in approve-or-abandon-run.mjs).
      await runStore.updateRun(initialState.runId, { status: "staged_for_review" });
    } else {
      // Reached END via the retry-exhausted path in routeAfterVerify.
      await runStore.updateRun(initialState.runId, {
        status: "failed_verification",
        error: final.verifyReport ?? "Verification failed and retries were exhausted.",
      });
    }
    return final;
  } catch (err) {
    const current = await runStore.getRun(initialState.runId);
    const status = STAGE_FAILURE_STATUS[current?.stage] ?? "failed";
    await runStore.appendLog(initialState.runId, "error", err.stack ?? err.message);
    await runStore.updateRun(initialState.runId, { status, error: err.message });
    throw err;
  }
}
