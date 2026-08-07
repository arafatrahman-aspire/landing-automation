import { z } from "zod";

/* The fixed section-type catalog (new_plan.md §4.4): page composition may
 * ONLY draw from this list — it's a Zod enum, not free text, so the guide
 * stage can't invent a new section type on the fly. Adding a genuinely new
 * section type is a deliberate edit to this file (and to design-catalog/reference-examples.mjs
 * alongside it), not something a campaign brief can trigger. */
export const SECTION_TYPES = [
  "hero",
  "details",
  "timeline",
  "testimonials",
  "faq",
  "curriculum",
  "pricing",
  "instructor",
  "footer-cta",
];

export const sectionTypeSchema = z.enum(SECTION_TYPES);

const catalogEntrySchema = z.object({
  referenceFiles: z.array(z.string().min(1)).min(1),
  note: z.string().min(1),
});

export const catalogSchema = z.record(z.string(), catalogEntrySchema).superRefine((val, ctx) => {
  for (const key of Object.keys(val)) {
    if (!SECTION_TYPES.includes(key)) {
      ctx.addIssue({ code: "custom", path: [key], message: `"${key}" is not a recognized section type (${SECTION_TYPES.join(", ")})` });
    }
  }
});

/** @returns {{ok: true, value: object} | {ok: false, errors: string}} */
export function validateCatalog(candidate) {
  const result = catalogSchema.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
  };
}
