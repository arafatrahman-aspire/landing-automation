import { describeFillableFields } from "./describe-fillable-fields.mjs";
import { buildContentRulesPromptFragment } from "../schemas/content-rules-prompt.mjs";
import { generateText, extractJson } from "../llm/generate-text.mjs";

/* AI-authored copy for STATIC sections — see static-section-data.md at the
 * repo root for the human-readable version of what this module does.
 *
 * A static section still renders via pure templating (fill-static-frame.mjs,
 * no coding agent, no tool loop) — but the copy it templates must be
 * campaign-specific. Until generateStaticSectionContent existed, every static
 * section rendered the frame's canned Aspire Tech / cybersecurity defaultData
 * regardless of the campaign.
 *
 * This makes ONE plain generateText() call per fillable static section — a
 * JSON-in, JSON-out request, not a coding-agent run — asking for copy that
 * fits the section's fillableFields shape. That shape is derived from
 * describeFillableFields(candidate.fillableFields), the exact schema
 * populateFrame() validates the result against, so the prompt and the
 * validator can never drift apart from each other.
 *
 * Failure of any kind here — LLM error, unparsable JSON, a shape the schema
 * rejects — returns {}. Callers that opt into authorStaticContent MUST treat
 * that as "do not ship the canned defaults": generate-sections.mjs falls
 * back to an ai-required coding-agent run for the section instead. Copy that
 * belongs to another industry is worse than spending one more agent call. */

/** A plain-value shape example for a field list, for the prompt only — not
 *  validation. `"string"` placeholders show the model what each field is and
 *  roughly how it's used; the real gate is candidate.fillableFields.safeParse
 *  on the way back out. Fields describeFillableFields calls "unsupported"
 *  are left out — nothing the model writes for one would parse anyway. */
export function buildFieldShapeExample(fields) {
  const shape = {};
  for (const field of fields) {
    if (field.kind === "text") {
      shape[field.key] = "string";
    } else if (field.kind === "text-list") {
      shape[field.key] = ["string", "as many as make sense"];
    } else if (field.kind === "group-list") {
      const member = {};
      for (const memberField of field.fields) member[memberField.key] = "string";
      shape[field.key] = [member, "... repeat for as many items as make sense"];
    }
  }
  return shape;
}

/**
 * True when overrides are complete enough to replace the frame's canned body
 * content — not just a heading while leaving an ISA FAQ list / cyber risk
 * bullets underneath via shallow merge.
 *
 * @param {object|null|undefined} candidate
 * @param {object} overrides
 * @returns {boolean}
 */
export function staticOverridesAreUsable(candidate, overrides) {
  if (!candidate?.fillableFields) return false;
  if (!overrides || typeof overrides !== "object" || Object.keys(overrides).length === 0) return false;

  const fields = describeFillableFields(candidate.fillableFields);
  for (const field of fields) {
    // List fields are the section body. Heading-only overrides leave the
    // catalog's cybersecurity items in place via `{ ...defaultData, ...overrides }`.
    if ((field.kind === "group-list" || field.kind === "text-list") && !(field.key in overrides)) {
      return false;
    }
  }
  return true;
}

/**
 * @param {object} p
 * @param {object} p.candidate - a frameCatalog[type][n] entry (design-catalog/static-frame-catalog.mjs)
 * @param {{type: string, summary: string}} p.section
 * @param {object} p.request - validated campaign brief (schemas/campaign-brief-schema.mjs)
 * @param {object} [p.guide] - full guide output, for cross-section context only
 * @param {(msg: string) => void} [p.logger]
 * @returns {Promise<object>} overrides for populateFrame — {} when the layout
 *   has no fillable copy or on any generation/parsing/validation failure
 */
export async function generateStaticSectionContent({ candidate, section, request, guide: guideData, logger = () => {}, images = [] }) {
  if (!candidate?.fillableFields) return {}; // no fillable copy on this candidate

  const fields = describeFillableFields(candidate.fillableFields);
  const shape = buildFieldShapeExample(fields);
  if (Object.keys(shape).length === 0) return {};

  const contentRules = buildContentRulesPromptFragment(request, { includeStructure: false });

  const listKeys = fields.filter((f) => f.kind === "group-list" || f.kind === "text-list").map((f) => f.key);
  const mustFill =
    listKeys.length > 0
      ? `\nREQUIRED: you MUST include ${listKeys.map((k) => `"${k}"`).join(" and ")} with NEW campaign-specific entries. Omitting them leaves another campaign's leftover list on the page — that is not acceptable.`
      : "";

  const prompt = `Write campaign-specific copy for ONE section of a marketing landing page.

SECTION: "${section.type}" — ${section.summary}
LAYOUT: ${candidate.description}

CAMPAIGN:
Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
CTA: ${request.cta}
${request.brief ? `Brief: ${request.brief}` : ""}
${contentRules ? `\n${contentRules}\n` : ""}
${guideData?.sections ? `Full section plan (context only — you are writing ONLY the "${section.type}" section's copy): ${JSON.stringify(guideData.sections)}` : ""}

Fill in this exact JSON shape with NEW copy written specifically for this campaign. Every string below is a placeholder showing you the field's purpose and rough length, not something to reuse or lightly edit:
${JSON.stringify(shape, null, 2)}
${mustFill}

Do NOT invent image URLs or remote hosts — photos are injected separately${
    Array.isArray(images) && images.length
      ? ` (assigned: ${images.map((i) => `${i.slot}=${i.publicUrl}`).join(", ")})`
      : ""
  }. Do not put a URL into any copy field.

Return ONLY a fenced \`\`\`json object matching that shape, no prose outside the fence. Do NOT reuse cybersecurity, SOC, cloud-certification, Income Share Agreement, or Aspire Tech training copy unless this campaign is actually about that.`;

  let text;
  try {
    text = await generateText({
      system:
        "You write concise, specific, on-brand marketing copy for one section of a landing page. Return ONLY a JSON object matching the requested shape, no prose outside it. Never reuse placeholder copy from another industry.",
      prompt,
      maxTokens: 4096,
      json: true,
    });
  } catch (err) {
    logger(`static content generation failed for "${section.type}" — will fall back to ai-required (${err.message})`);
    return {};
  }

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (err) {
    logger(`static content generation returned unparsable JSON for "${section.type}" — will fall back to ai-required (${err.message})`);
    return {};
  }

  const result = candidate.fillableFields.safeParse(parsed);
  if (!result.success) {
    logger(
      `static content generation returned a shape "${section.type}"'s layout doesn't accept — will fall back to ai-required (${result.error.issues[0]?.message ?? "invalid shape"})`
    );
    return {};
  }
  return result.data;
}
