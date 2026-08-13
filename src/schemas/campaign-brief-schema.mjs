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

  /* --- Content rules (v0.37) ---------------------------------------------
   * Everything below is prompt input: it steers what the guide stage plans
   * and what the coding agent writes, and nothing here changes the pipeline's
   * shape. All optional — a brief that omits every one of them behaves
   * exactly as it did before.
   *
   * These exist because the only steering a user previously had was one free
   * text `brief` field. Free text is a poor place to put a rule you want
   * honoured every time ("never call it cheap"): it competes for attention
   * with everything else in the same blob. Named fields get their own labelled
   * prompt fragment, so a hard constraint reads as a hard constraint. */

  // Voice of the generated copy. An enum rather than free text so the prompt
  // fragment can state something concrete instead of forwarding an adjective.
  tone: z.enum(["professional", "friendly", "urgent", "technical", "playful"]).optional(),

  // Brand/style rules in the campaign owner's own words — naming conventions,
  // words to avoid, house style. Distinct from `brief` (what to say) because
  // this is how to say it, and it applies to every section.
  brandNotes: z.string().max(1000).optional(),

  // Specific claims/stats/offers that MUST appear somewhere on the page, and
  // claims that must not. Arrays rather than prose so each one can be listed
  // as its own numbered requirement.
  mustInclude: z.array(z.string().min(1).max(300)).max(10).optional(),
  avoid: z.array(z.string().min(1).max(300)).max(10).optional(),

  // A page whose structure/approach to echo. Passed to the model as a
  // reference to reason about, NOT fetched — this service does no outbound
  // scraping, and saying so keeps that boundary explicit.
  referenceUrl: z.string().url().optional(),

  // Which section types the page should contain at all. Omitted (the default)
  // means "let the plan decide", which is the behaviour that existed before.
  // Distinct from aiRequiredSections above: that one picks HOW a section is
  // built, this one picks WHETHER it exists.
  sectionTypes: z.array(sectionTypeSchema).max(9).optional(),

  // Rough target size, mapped to a section count in the guide prompt.
  pageLength: z.enum(["short", "standard", "long"]).optional(),

  // Pause after the plan is generated so a human can edit it before any
  // section is written. Unset falls back to REVIEW_PLAN_BEFORE_GENERATING.
  // Per-campaign because the answer genuinely differs: a careful launch page
  // wants the gate, a quick variation of an already-approved campaign doesn't.
  reviewPlan: z.boolean().optional(),
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
