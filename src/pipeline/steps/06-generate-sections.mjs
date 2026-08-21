import { config, resolveAllowlist } from "../../config.mjs";
import * as runStore from "../../state/campaign-repository.mjs";
import { generateSections } from "../../sections/generate-sections.mjs";
import { PREVIEW_LEAD_SINK_PATH } from "../../leadform/contract.mjs";
import { findExistingImportExamples } from "./find-existing-imports.mjs";
import { extractFailingFiles } from "../../verify/failing-files.mjs";
import { detectTypeScriptStrictness, buildTypeScriptPromptFragment } from "./detect-typescript-strictness.mjs";
import { readDeclaredPackages } from "../../verify/precheck-section-file.mjs";
import { logStage } from "./log-helper.mjs";

// Fan-out section generation (new_plan.md §9.5/§9.6, module.md Module 2).
// Static sections are templated directly (no LLM); each ai-required section
// gets its own independent coding-agent run scoped to exactly one file, all
// concurrent — see sections/generate-sections.mjs for the actual dispatcher,
// this step just wires it up to run-store logging and the allowlist.
export async function generateSectionsStep(state) {
  const attempt = state.codeAttempts + 1;
  await runStore.heartbeat(state.runId, "generate_sections");
  await runStore.updateRun(state.runId, { codeAttempts: attempt });
  await logStage(state.runId, `generate_sections: fan-out starting (attempt ${attempt}, ${state.classifiedSections.length} section(s))`);

  const allowlist = resolveAllowlist(config.writePathAllowlistTemplates, state.request.slug);
  // Only produces anything on a retry (verifyReport is set) — see find-existing-imports.mjs.
  const importExamples = await findExistingImportExamples({ workdir: state.workdir, verifyReport: state.verifyReport });

  // The target repo's own type-checker settings decide what will actually
  // compile there — `next build` runs tsc, so an untyped prop in a strict repo
  // is a hard build failure.
  const tsStrictness = await detectTypeScriptStrictness(state.workdir);
  const typescriptFragment = buildTypeScriptPromptFragment(tsStrictness);
  // Feeds the fast per-file precheck: which packages may legitimately be imported.
  const declaredPackages = await readDeclaredPackages(state.workdir);

  // On a retry, repair only the files the build actually blamed and keep every
  // section that already compiled. Regenerating the lot re-rolls sections that
  // were fine, which is how consecutive attempts end up failing on different
  // errors instead of converging.
  const retryFailedPaths = state.verifyReport ? extractFailingFiles(state.verifyReport, { allowlistBase: allowlist[0] }) : null;
  if (retryFailedPaths?.size) {
    await logStage(state.runId, `generate_sections: retry is targeting only the ${retryFailedPaths.size} file(s) the build blamed — ${[...retryFailedPaths].join(", ")}`);
  } else if (state.verifyReport) {
    await logStage(state.runId, "generate_sections: the build failure named no specific section file — regenerating every ai-required section");
  }

  const result = await generateSections({
    classifiedSections: state.classifiedSections,
    workdir: state.workdir,
    allowlist,
    pristineFiles: state.pristineFiles,
    request: state.request,
    guide: state.guide,
    verifyReport: state.verifyReport,
    importExamples,
    maxIterations: config.maxAgentIterations,
    previewLeadSinkUrl: `${config.servicePublicBaseUrl}${PREVIEW_LEAD_SINK_PATH}`,
    retryFailedPaths,
    previousSectionResults: state.sectionResults ?? null,
    typescriptFragment,
    strictTypes: tsStrictness.strict,
    declaredPackages,
    authorStaticContent: true,
    images: state.researchNotes?.images ?? [],
    logger: (msg) => logStage(state.runId, `generate_sections: ${msg}`),
  });

  if (result.codeFinished) {
    await logStage(state.runId, `generate_sections: all ${result.sectionResults.length} section(s) finished — ${result.writtenByAgent.size} file(s) written`);
  } else {
    await logStage(state.runId, "generate_sections: one or more ai-required sections hit max iterations without finish_coding");
  }

  // Persisted (not just in-process LangGraph state) so approveRun()
  // (pipeline/approve-or-abandon-run.mjs) — invoked from a LATER, separate
  // request, long after this graph.invoke() call has returned — can rebuild
  // what commit()/openPr() need without a LangGraph checkpointer.
  await runStore.updateRun(state.runId, { agentSummary: result.agentSummary, sectionResults: result.sectionResults });

  return {
    agentSummary: result.agentSummary,
    writtenByAgent: result.writtenByAgent,
    sectionResults: result.sectionResults,
    codeAttempts: attempt,
    codeFinished: result.codeFinished,
    // An unfinished section must never reach verify as if the page were
    // buildable — route straight to the retry/halt decision with a clear reason.
    ...(result.codeFinished ? {} : { verifyPassed: false, verifyReport: "One or more ai-required sections hit max iterations without calling finish_coding." }),
  };
}
