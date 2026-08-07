import { listFrameCandidates } from "../design-catalog/static-frame-catalog.mjs";

/* Section classification (new_plan.md §9.2 — Hybrid Section Assembly).
 *
 * Pure, deterministic pass over the guide's already-chosen section list
 * (pipeline/steps/'s `guide()` output — unchanged, still just
 * {type, summary} per section). Mode is decided in code, never asked of
 * the LLM: hero is always ai-required; everything else defaults to static
 * unless the campaign brief explicitly flagged it, or there's simply no
 * static candidate to template against for that section type. */

/* `isFrameAvailable` lets the caller rule out catalog candidates whose
 * component doesn't actually exist in THIS clone of the target repo
 * (design-catalog/resolve-frame-file.mjs does the real filesystem check in
 * pipeline/steps/05-classify-sections.mjs). Defaulting it to "everything is
 * available" keeps these two functions pure and independently unit-testable —
 * the I/O stays in the pipeline step, not in here. A section whose only
 * candidates are missing degrades to ai-required rather than generating an
 * unresolvable import that would fail the build with no way to retry out of
 * it (static sections are templated, never agent-corrected). */

/**
 * @param {string} sectionType
 * @param {string[]} aiRequiredSections - brief.aiRequiredSections, campaign-flagged types
 * @param {(candidate: object) => boolean} [isFrameAvailable]
 * @returns {"static" | "ai-required"}
 */
export function resolveSectionMode(sectionType, aiRequiredSections = [], isFrameAvailable = () => true) {
  if (sectionType === "hero") return "ai-required";
  if (aiRequiredSections.includes(sectionType)) return "ai-required";
  return listFrameCandidates(sectionType).some(isFrameAvailable) ? "static" : "ai-required";
}

/**
 * @param {Array<{type: string, summary: string}>} guideSections
 * @param {object} [opts]
 * @param {string[]} [opts.aiRequiredSections]
 * @param {(candidate: object) => boolean} [opts.isFrameAvailable]
 * @returns {Array<{type: string, summary: string, mode: "static"|"ai-required", frameId: string|null}>}
 */
export function classifySections(guideSections, { aiRequiredSections = [], isFrameAvailable = () => true } = {}) {
  return guideSections.map((section) => {
    const mode = resolveSectionMode(section.type, aiRequiredSections, isFrameAvailable);
    if (mode === "static") {
      // Pick the first candidate that actually resolves, not just the first listed.
      const candidate = listFrameCandidates(section.type).find(isFrameAvailable);
      return { ...section, mode, frameId: candidate.id };
    }
    return { ...section, mode, frameId: null };
  });
}
