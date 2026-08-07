import { z } from "zod";
import { sectionTypeSchema } from "../design-catalog/section-types.mjs";

/* Validates POST /campaigns request bodies (src/server.mjs). */

export const briefSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase kebab-case (a-z, 0-9, dashes)"),
  campaignName: z.string().min(3).max(120),
  offer: z.string().min(5).max(500),
  audience: z.string().min(5).max(500),
  cta: z.string().min(2).max(60),
  brief: z.string().max(4000).default(""),
  videoUrl: z.string().url().optional(),
  deadline: z.string().date().optional(),
  // new_plan.md §9.2 — section types this campaign wants bespoke AI
  // generation for, beyond the always-ai-required hero. Everything else
  // defaults to static templating (sections/classify-sections.mjs).
  aiRequiredSections: z.array(sectionTypeSchema).max(9).optional(),
  // Phase 8 (new_plan.md §4.8/§6) — set at campaign creation, e.g. on for
  // B2B/professional courses, off for consumer campaigns. Threaded into the
  // hero's lead-form contract (leadform/contract.mjs).
  requiresJobField: z.boolean().optional().default(false),
});

/** @returns {{ok: true, value: object} | {ok: false, errors: string}} */
export function validateBrief(candidate) {
  const result = briefSchema.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
  };
}
