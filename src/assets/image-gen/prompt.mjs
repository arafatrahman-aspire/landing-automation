const SLOT_INTENT = {
  hero: "wide cinematic hero banner showing the campaign's outcome or aspiration",
  details: "side image illustrating the skill, tool, or benefit being offered",
  timeline: "side image showing learning, process, or progression",
};

const QUALITY_SUFFIX =
  "Photorealistic landscape photograph, professional marketing photography, clean composition, " +
  "no text, no captions, no logos, no watermarks, no readable UI, no people, no faces, no portraits.";

function firstQuery(imageQueries, slot) {
  const list = Array.isArray(imageQueries?.[slot]) ? imageQueries[slot] : [];
  for (const q of list) {
    const trimmed = String(q ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function promptFromRecord(imagePrompts, slot) {
  const raw = imagePrompts?.[slot];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((q) => String(q ?? "").trim());
    if (first) return String(first).trim();
  }
  return "";
}

/**
 * One generation prompt per campaign slot. Prefers the research LLM's
 * `imagePrompts[slot]`; otherwise composes from the first imageQuery plus
 * campaign context. Always appends no-text / no-people constraints.
 *
 * @param {object} p
 * @param {string} p.slot
 * @param {string} [p.campaignName]
 * @param {string} [p.offer]
 * @param {string} [p.audience]
 * @param {object} [p.imagePrompts]
 * @param {object} [p.imageQueries]
 * @returns {string}
 */
export function buildGenerationPrompt({
  slot,
  campaignName = "",
  offer = "",
  audience = "",
  imagePrompts = null,
  imageQueries = null,
}) {
  const written = promptFromRecord(imagePrompts, slot);
  const visual = firstQuery(imageQueries, slot);
  const intent = SLOT_INTENT[slot] ?? SLOT_INTENT.details;
  const parts = [];

  if (written) {
    parts.push(written);
  } else {
    parts.push(`Create a ${intent}.`);
    if (visual) parts.push(`Visual subject: ${visual}.`);
    if (campaignName) parts.push(`Campaign: ${campaignName}.`);
    if (offer) parts.push(`Offer: ${offer}.`);
    if (audience) parts.push(`Audience: ${audience}.`);
  }

  parts.push(QUALITY_SUFFIX);
  return parts.filter(Boolean).join(" ");
}
