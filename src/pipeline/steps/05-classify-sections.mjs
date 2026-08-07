import * as runStore from "../../state/campaign-repository.mjs";
import { classifySections } from "../../sections/classify-sections.mjs";
import { resolveSectionReferences } from "../../design-catalog/resolve-references.mjs";
import { frameCatalog } from "../../design-catalog/static-frame-catalog.mjs";
import { findAvailableFrameIds } from "../../design-catalog/resolve-frame-file.mjs";
import { logStage } from "./log-helper.mjs";

// Pure decision over the guide's already-chosen section list — no LLM call
// (new_plan.md §9.2, module.md Module 2). Runs once; a verify-failure retry
// re-runs 06-generate-sections.mjs, not this one, since mode/frameId don't
// change just because a build broke. Replaces the old file_manifest
// LLM-planning step: every file's path is now deterministic
// (classify-sections.mjs + sections/compose-page.mjs's path convention)
// instead of guessed by an LLM call.
export async function classifySectionsStep(state) {
  await runStore.heartbeat(state.runId, "classify_sections");

  // Only a frame that REALLY exists in this clone may be templated against —
  // see design-catalog/resolve-frame-file.mjs for why a missing one is
  // otherwise an unrecoverable build failure rather than a retryable one.
  const allCandidates = Object.values(frameCatalog).flat();
  const availableFrameIds = await findAvailableFrameIds({ workdir: state.workdir, candidates: allCandidates });
  const missing = allCandidates.filter((c) => !availableFrameIds.has(c.id));
  if (missing.length > 0) {
    // Loud, not silent: a catalog pointing at components this repo doesn't
    // have is a real curation bug to fix, even though the run survives it.
    await logStage(
      state.runId,
      `classify_sections: WARNING — ${missing.length}/${allCandidates.length} catalog frame(s) do not exist in this repo and will be built by AI instead: ${missing
        .map((c) => c.importPath)
        .join(", ")}`
    );
  }

  const classified = classifySections(state.guide.sections, {
    aiRequiredSections: state.request.aiRequiredSections ?? [],
    isFrameAvailable: (candidate) => availableFrameIds.has(candidate.id),
  });
  const staticCount = classified.filter((s) => s.mode === "static").length;
  const aiCount = classified.length - staticCount;
  await logStage(state.runId, `classify_sections: ${staticCount} static, ${aiCount} ai-required — ${classified.map((s) => `${s.type}:${s.mode}`).join(", ")}`);

  // Persisted (not just in-process LangGraph state) so GET /campaigns/:runId
  // can show a human which reference files actually grounded the guide's
  // section choices — same behavior the old file_manifest step used to
  // provide, just moved here since this is now its natural successor.
  const chosenSections = state.guide.sections.map((s) => s.type);
  const resolved = await resolveSectionReferences({ workdir: state.workdir, sectionTypes: chosenSections });
  await runStore.updateRun(state.runId, {
    sectionReferences: resolved.map((r) => ({
      sectionType: r.sectionType,
      note: r.note,
      files: r.files.map((f) => ({ path: f.path, found: f.content !== null })),
    })),
  });

  return { classifiedSections: classified };
}
