import { SECTION_TYPES } from "../design-catalog/section-types.mjs";
import { resolveColorScheme } from "../theme/campaign-colors.mjs";

/* Turns the campaign brief's optional content-rule fields (campaign-brief-schema.mjs)
 * into prompt text, for both the guide stage (pipeline/steps/03-generate-guide.mjs)
 * and the per-section coding agent (sections/section-agent-prompt.mjs).
 *
 * Why these are separate named fields rather than more free text in `brief`:
 * a rule you want honoured EVERY time ("never call it cheap", "must mention
 * the 90% placement rate") competes for attention with everything else when
 * it's buried in one paragraph. Given its own labelled, numbered fragment it
 * reads as a constraint, which is what it is.
 *
 * Same shape as leadform/contract.mjs's buildLeadFormPromptFragment: one
 * function that owns its whole slice of the prompt, so callers concatenate
 * fragments instead of growing an ever-longer template literal.
 *
 * Everything here is optional except COLOR THEME, which always resolves to
 * Aspire TSS when the brief omits colorScheme. */

const TONE_GUIDANCE = {
  professional: "Measured and credible. Plain business English, no slang, no exclamation marks.",
  friendly: "Warm and conversational. Second person, contractions, short sentences.",
  urgent: "Direct and time-aware. Lead with what's at stake and why now, without manufacturing false scarcity.",
  technical: "Precise and specific. Assume domain literacy; prefer concrete detail over adjectives.",
  playful: "Light and energetic. Some personality is welcome; never at the expense of clarity.",
};

// Typical section counts, INCLUDING the always-present hero. Deliberately
// ranges rather than exact numbers — the right count depends on how much the
// campaign actually has to say, and an exact figure invites padding.
const LENGTH_GUIDANCE = {
  short: "2-3 sections total. A tight page: hero plus only what's needed to convert.",
  standard: "3-5 sections total.",
  long: "5-7 sections total. Room to build the case in depth — only if the campaign genuinely has that much to say.",
};

function numbered(items) {
  return items.map((item, i) => `  ${i + 1}. ${item}`).join("\n");
}

/**
 * @param {object} request - a validated campaign brief (briefSchema output)
 * @param {object} [opts]
 * @param {boolean} [opts.includeStructure] - include section-list/length rules.
 *   True for the guide stage, which decides the section list; false for the
 *   per-section coding agent, where the list is already settled and repeating
 *   it would just invite the agent to second-guess a decision it can't act on.
 * @returns {string} prompt text (always includes COLOR THEME; other blocks optional)
 */
export function buildContentRulesPromptFragment(request, { includeStructure = true } = {}) {
  const blocks = [];

  const palette = resolveColorScheme(request?.colorScheme);
  blocks.push(
    `COLOR THEME — use these exact hex values for brand/UI color; do not invent new brand colors:\n` +
      `  primary: ${palette.primary}\n` +
      `  secondary: ${palette.secondary}\n` +
      `  accent/CTA: ${palette.accent}\n` +
      `Prefer CSS variables --campaign-primary, --campaign-secondary, --campaign-accent (set on the page wrapper) when writing new markup.\n` +
      `CONTRAST WARNING: accent is usually a bright/saturated brand color (e.g. an orange or bright blue) — it is often NOT safe as a TEXT color on white or on primary/secondary backgrounds (a real run failed WCAG AA contrast, 4.5:1, using accent-colored heading text on a secondary-colored card). Reserve accent/primary/secondary for BACKGROUNDS with plain white or near-white text, never as small/normal-weight body or heading text color. If you do use one as text, only do so at a large size AND bold weight (e.g. text-xl font-bold or bigger) to qualify for the relaxed 3:1 large-text threshold — never at normal weight.`
  );

  if (request.tone) {
    blocks.push(`TONE: ${request.tone} — ${TONE_GUIDANCE[request.tone]}`);
  }

  if (request.brandNotes?.trim()) {
    blocks.push(`BRAND RULES (apply to every section, no exceptions):\n${request.brandNotes.trim()}`);
  }

  if (request.mustInclude?.length) {
    blocks.push(
      `MUST APPEAR ON THE PAGE — each of these has to show up somewhere in the copy, worded naturally rather than pasted in verbatim:\n${numbered(request.mustInclude)}`
    );
  }

  if (request.avoid?.length) {
    blocks.push(`MUST NOT APPEAR — do not state, imply, or paraphrase any of these:\n${numbered(request.avoid)}`);
  }

  if (request.referenceUrl) {
    // Explicitly flagged as un-fetched. Without this the model tends to write
    // as though it had read the page, inventing structure it never saw.
    blocks.push(
      `REFERENCE PAGE: ${request.referenceUrl}\n` +
        `The campaign owner offered this as a structural reference. You have NOT been given its contents and must not ` +
        `pretend to have read it — use it only if you already know the page, and ignore it otherwise.`
    );
  }

  if (includeStructure) {
    if (request.sectionTypes?.length) {
      const requested = request.sectionTypes.filter((t) => SECTION_TYPES.includes(t));
      if (requested.length > 0) {
        blocks.push(
          `REQUIRED SECTIONS: the campaign owner asked specifically for these section types: ${requested.join(", ")}. ` +
            `Include every one of them. You may add others only where genuinely necessary, and "hero" is always present regardless.`
        );
      }
    }

    if (request.pageLength) {
      blocks.push(`PAGE LENGTH: ${request.pageLength} — ${LENGTH_GUIDANCE[request.pageLength]}`);
    }
  }

  if (blocks.length === 0) return "";
  return `CAMPAIGN CONTENT RULES (from the campaign owner — these outrank your own judgement):\n\n${blocks.join("\n\n")}`;
}
