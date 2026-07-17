import { z } from "zod";

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
  deadline: z.string().date().optional(),
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
