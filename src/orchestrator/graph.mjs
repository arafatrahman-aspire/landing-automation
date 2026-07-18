import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { config } from "../config.mjs";
import * as steps from "./steps.mjs";
import * as runStore from "../state/run-store.mjs";

/* LangGraph state machine (mirrors the parent project's
 * scripts/campaign/lib/graph.mjs pattern — StateGraph + a single
 * "retry once, then halt, never proceed on a failed gate" conditional edge):
 *
 *   intake -> research -> clone -> generate_guide -> file_manifest -> code -> verify
 *                                                                  ▲       │
 *                                                                  └retry──┘ (codeAttempts < MAX_CODE_ATTEMPTS)
 *                                                                          │ pass
 *                                                              commit -> push -> open_pr -> END
 *
 * `clone` happens BEFORE guide/file_manifest (not after, as you might expect)
 * because the target repo's actual stack isn't fixed — it could be Next.js,
 * Laravel, Vue, plain HTML, whatever — and guide/file_manifest need to see
 * the real repo (via a lightweight scan, steps.detectRepoConventions) to
 * choose real file extensions/conventions, instead of guessing blind and
 * having file_manifest lock in paths the coding agent then can't match.
 *
 * A verify failure that exhausts retries routes straight to END without
 * ever reaching commit/push/open_pr — no broken PR can ever be opened. */

const CodegenState = Annotation.Root({
  runId: Annotation(),
  request: Annotation(), // validated brief (schemas/brief-schema.mjs)
  researchNotes: Annotation(),
  guide: Annotation(),
  fileManifest: Annotation(), // validated (schemas/file-manifest-schema.mjs)
  workdir: Annotation(),
  branchName: Annotation(),
  pristineFiles: Annotation(), // Set<string> — snapshot right after clone
  writtenByAgent: Annotation(),
  agentSummary: Annotation(),
  agentIterations: Annotation(),
  codeFinished: Annotation(),
  verifyPassed: Annotation(),
  verifyReport: Annotation(),
  verifyAttempts: Annotation({ reducer: (_prev, next) => next, default: () => 0 }),
  codeAttempts: Annotation({ reducer: (_prev, next) => next, default: () => 0 }),
  prUrl: Annotation(),
  prNumber: Annotation(),
  status: Annotation(),
});

function routeAfterVerify(state) {
  if (state.verifyPassed) return "commit";
  if (state.codeAttempts < config.maxCodeAttempts) return "code";
  return END;
}

export function createCodegenGraph() {
  return new StateGraph(CodegenState)
    .addNode("intake", steps.intake)
    .addNode("research", steps.research)
    .addNode("clone", steps.clone)
    // node can't share a name with the "guide" state channel
    .addNode("generate_guide", steps.guide)
    .addNode("file_manifest", steps.fileManifest)
    .addNode("code", steps.code)
    .addNode("verify", steps.verify)
    .addNode("commit", steps.commit)
    .addNode("push", steps.push)
    .addNode("open_pr", steps.openPr)
    .addEdge(START, "intake")
    .addEdge("intake", "research")
    .addEdge("research", "clone")
    .addEdge("clone", "generate_guide")
    .addEdge("generate_guide", "file_manifest")
    .addEdge("file_manifest", "code")
    .addEdge("code", "verify")
    .addConditionalEdges("verify", routeAfterVerify)
    .addEdge("commit", "push")
    .addEdge("push", "open_pr")
    .addEdge("open_pr", END)
    .compile();
}

// Node name -> the run-store status to record if an exception is thrown
// while that node was active (heartbeat's `stage` field, set by every node
// in steps.mjs, tells us which one was running).
const STAGE_FAILURE_STATUS = {
  clone: "failed_clone",
  code: "failed",
  verify: "failed_verification",
  committing: "failed",
  pushing: "failed_push",
  opening_pr: "failed_push", // branch is already pushed at this point
};

/**
 * Runs the graph for one campaign request and guarantees the run-store
 * record ends in a terminal, informative status even for exceptions no
 * explicit halt path covers (e.g. an unexpected GitHub 500).
 */
export async function runCodegen(initialState) {
  const graph = createCodegenGraph();
  await runStore.updateRun(initialState.runId, { status: "running" });
  try {
    const final = await graph.invoke(initialState);
    if (final.status !== "completed") {
      // Reached END via the retry-exhausted path in routeAfterVerify, not open_pr
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
