import { z } from "zod";
import { sectionTypeSchema } from "../design/schema.mjs";

/* The AI-declared content/section plan (orchestrator/steps.mjs, guide stage).
 * Structured and validated — NOT free text — so section composition can only
 * ever draw from the fixed catalog enum (new_plan.md §4.4: "a Zod enum, not
 * free text"). file_manifest and code both consume this as JSON. */

export const LIMITS = {
  heroTitle: 80,
  seoTitle: 70,
  seoMetaDescription: 200,
  sectionSummary: 400,
};

export const guideSchema = z.object({
  heroTitle: z.string().min(3).max(LIMITS.heroTitle),
  heroHasVideo: z.boolean(),
  seoTitle: z.string().min(3).max(LIMITS.seoTitle),
  seoMetaDescription: z.string().min(10).max(LIMITS.seoMetaDescription),
  sections: z
    .array(
      z.object({
        type: sectionTypeSchema,
        summary: z.string().min(1).max(LIMITS.sectionSummary),
      })
    )
    .min(1)
    .max(9),
});

/* new_plan.md §9.2 — section mode is resolved in code (sections/classify.mjs),
 * never asked of the LLM: the base guideSchema.sections shape above is
 * unchanged. classifiedSectionSchema validates classify.mjs's OUTPUT (the
 * guide's section list + the resolved mode/frameId), for defensiveness and
 * so it's documented as a real, checked shape rather than just a JS object. */
export const sectionModeSchema = z.enum(["static", "ai-required"]);

export const classifiedSectionSchema = z
  .object({
    type: sectionTypeSchema,
    summary: z.string().min(1).max(LIMITS.sectionSummary),
    mode: sectionModeSchema,
    frameId: z.string().min(1).nullable(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "static" && val.frameId === null) {
      ctx.addIssue({ code: "custom", path: ["frameId"], message: "frameId is required when mode is 'static'" });
    }
    if (val.mode === "ai-required" && val.frameId !== null) {
      ctx.addIssue({ code: "custom", path: ["frameId"], message: "frameId must be null when mode is 'ai-required'" });
    }
  });

function truncate(str, max) {
  if (typeof str !== "string" || str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Clamps known string fields to their schema max lengths BEFORE validation.
 * LLMs are unreliable at exact character counting even when told a limit —
 * length is objectively fixable, so it's handled deterministically here
 * rather than spending a regeneration attempt (and an extra LLM call) on
 * what's ultimately a cosmetic overage, not a structural problem.
 */
export function truncateGuideFields(candidate) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const clamped = { ...candidate };
  if (typeof clamped.heroTitle === "string") clamped.heroTitle = truncate(clamped.heroTitle, LIMITS.heroTitle);
  if (typeof clamped.seoTitle === "string") clamped.seoTitle = truncate(clamped.seoTitle, LIMITS.seoTitle);
  if (typeof clamped.seoMetaDescription === "string") {
    clamped.seoMetaDescription = truncate(clamped.seoMetaDescription, LIMITS.seoMetaDescription);
  }
  if (Array.isArray(clamped.sections)) {
    clamped.sections = clamped.sections.map((s) =>
      s && typeof s === "object" && typeof s.summary === "string"
        ? { ...s, summary: truncate(s.summary, LIMITS.sectionSummary) }
        : s
    );
  }
  return clamped;
}

/** @returns {{ok: true, value: object} | {ok: false, errors: string}} */
export function validateGuide(candidate) {
  const result = guideSchema.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
  };
}
