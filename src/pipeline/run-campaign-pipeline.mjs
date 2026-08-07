import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { config } from "../config.mjs";
import * as steps from "./steps/index.mjs";
import * as runStore from "../state/campaign-repository.mjs";

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
  verifyAttempts: Annotation({ reducer: (_prev, next) => next, default: () => 0 }),
  codeAttempts: Annotation({ reducer: (_prev, next) => next, default: () => 0 }),
  prUrl: Annotation(),
  prNumber: Annotation(),
  status: Annotation(),
  previewStarted: Annotation(),
});

function routeAfterVerify(state) {
  if (state.verifyPassed) return "stage_draft";
  if (state.codeAttempts < config.maxCodeAttempts) return "generate_sections";
  // Escape hatch (CONTINUE_ON_VERIFY_FAILURE): stage and preview the draft
  // even though it doesn't build, so a human can look at it rather than the
  // run just ending. The run carries verifyBypassed so the review UI can say
  // plainly that this page is NOT known to build.
  if (config.continueOnVerifyFailure) return "stage_draft";
  return END;
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
    .addEdge("generate_guide", "classify_sections")
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
