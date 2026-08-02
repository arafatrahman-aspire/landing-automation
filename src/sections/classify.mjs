import { listFrameCandidates } from "../design/frame-catalog.mjs";

/* Section classification (new_plan.md §9.2 — Hybrid Section Assembly).
 *
 * Pure, deterministic pass over the guide's already-chosen section list
 * (orchestrator/steps.mjs's `guide()` output — unchanged, still just
 * {type, summary} per section). Mode is decided in code, never asked of
 * the LLM: hero is always ai-required; everything else defaults to static
 * unless the campaign brief explicitly flagged it, or there's simply no
 * static candidate to template against for that section type. */

/**
 * @param {string} sectionType
 * @param {string[]} aiRequiredSections - brief.aiRequiredSections, campaign-flagged types
 * @returns {"static" | "ai-required"}
 */
export function resolveSectionMode(sectionType, aiRequiredSections = []) {
  if (sectionType === "hero") return "ai-required";
  if (aiRequiredSections.includes(sectionType)) return "ai-required";
  return listFrameCandidates(sectionType).length > 0 ? "static" : "ai-required";
}

/**
 * @param {Array<{type: string, summary: string}>} guideSections
 * @param {object} [opts]
 * @param {string[]} [opts.aiRequiredSections]
 * @returns {Array<{type: string, summary: string, mode: "static"|"ai-required", frameId: string|null}>}
 */
export function classifySections(guideSections, { aiRequiredSections = [] } = {}) {
  return guideSections.map((section) => {
    const mode = resolveSectionMode(section.type, aiRequiredSections);
    if (mode === "static") {
      const [candidate] = listFrameCandidates(section.type);
      return { ...section, mode, frameId: candidate.id };
    }
    return { ...section, mode, frameId: null };
  });
}
