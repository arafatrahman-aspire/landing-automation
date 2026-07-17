import { z } from "zod";

/* The AI-declared "which files am I about to create" plan (orchestrator/steps.mjs,
 * fileManifest stage) — produced BEFORE the coding agent runs, then used as one of
 * the write-tool's guardrail layers (ai/tools.mjs: a write is rejected if its path
 * isn't in this manifest, in addition to the human-set path-prefix allowlist). */

export const fileManifestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  summary: z.string().min(10).max(500),
  designNotes: z.string().min(10).max(2000),
  filesToCreate: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        purpose: z.string().min(3).max(300),
      })
    )
    .min(1)
    .max(15),
});

/** @returns {{ok: true, value: object} | {ok: false, errors: string}} */
export function validateFileManifest(candidate) {
  const result = fileManifestSchema.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
  };
}
