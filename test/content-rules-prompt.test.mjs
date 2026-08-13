import test from "node:test";
import assert from "node:assert/strict";

import { buildContentRulesPromptFragment } from "../src/schemas/content-rules-prompt.mjs";
import { validateBrief } from "../src/schemas/campaign-brief-schema.mjs";

/* Every fragment is built from a brief that has been through validateBrief,
 * so these tests double as a check that the schema actually accepts the shapes
 * the UI will send. */

const BASE = {
  slug: "spring-sale",
  campaignName: "Spring Sale",
  offer: "A 6-week course",
  audience: "Security engineers",
  cta: "Book a seat",
};

function brief(extra) {
  const result = validateBrief({ ...BASE, ...extra });
  assert.ok(result.ok, `brief did not validate: ${result.errors ?? ""}`);
  return result.value;
}

test("a brief with no content rules produces nothing at all", () => {
  // The whole point of the optional fields: an old-style brief must leave the
  // prompts byte-identical to what they were before this existed.
  assert.equal(buildContentRulesPromptFragment(brief({})), "");
});

test("tone is expanded into concrete guidance, not passed through as an adjective", () => {
  const fragment = buildContentRulesPromptFragment(brief({ tone: "urgent" }));
  assert.match(fragment, /TONE: urgent/);
  assert.match(fragment, /without manufacturing false scarcity/);
});

test("must-include and avoid are numbered separately and unambiguously", () => {
  const fragment = buildContentRulesPromptFragment(
    brief({ mustInclude: ["90% placement rate", "CREST accredited"], avoid: ["cheap", "guaranteed job"] })
  );
  assert.match(fragment, /MUST APPEAR ON THE PAGE/);
  assert.match(fragment, /1\. 90% placement rate/);
  assert.match(fragment, /2\. CREST accredited/);
  assert.match(fragment, /MUST NOT APPEAR/);
  assert.match(fragment, /1\. cheap/);
});

test("a reference URL is explicitly marked as not fetched", () => {
  // Without this the model writes as though it had read the page and invents
  // structure it never saw. This service does no outbound scraping.
  const fragment = buildContentRulesPromptFragment(brief({ referenceUrl: "https://example.com/lp" }));
  assert.match(fragment, /https:\/\/example\.com\/lp/);
  assert.match(fragment, /have NOT been given its contents/);
});

test("structural rules are included for the guide stage and withheld from the section agent", () => {
  const withStructure = brief({ sectionTypes: ["faq", "pricing"], pageLength: "short", tone: "friendly" });

  const guideFragment = buildContentRulesPromptFragment(withStructure, { includeStructure: true });
  assert.match(guideFragment, /REQUIRED SECTIONS/);
  assert.match(guideFragment, /faq, pricing/);
  assert.match(guideFragment, /PAGE LENGTH: short/);

  // The per-section agent can only write its own one file — restating which
  // sections exist just invites it to argue with a settled decision.
  const agentFragment = buildContentRulesPromptFragment(withStructure, { includeStructure: false });
  assert.doesNotMatch(agentFragment, /REQUIRED SECTIONS/);
  assert.doesNotMatch(agentFragment, /PAGE LENGTH/);
  // Non-structural rules still apply to it.
  assert.match(agentFragment, /TONE: friendly/);
});

test("the rules are framed as outranking the model's own judgement", () => {
  const fragment = buildContentRulesPromptFragment(brief({ brandNotes: "Never write 'cheap'." }));
  assert.match(fragment, /outrank your own judgement/);
  assert.match(fragment, /Never write 'cheap'\./);
});

test("the schema rejects rule lists that are too long or empty-stringed", () => {
  assert.equal(validateBrief({ ...BASE, mustInclude: Array(11).fill("x") }).ok, false);
  assert.equal(validateBrief({ ...BASE, mustInclude: [""] }).ok, false);
  assert.equal(validateBrief({ ...BASE, tone: "sarcastic" }).ok, false);
  assert.equal(validateBrief({ ...BASE, referenceUrl: "not-a-url" }).ok, false);
  assert.equal(validateBrief({ ...BASE, sectionTypes: ["not-a-section"] }).ok, false);
});

test("an unknown section type in sectionTypes cannot reach the prompt", () => {
  // Defence in depth: the schema rejects it, and the fragment filters again
  // against SECTION_TYPES rather than trusting its input.
  const fragment = buildContentRulesPromptFragment({ sectionTypes: ["faq", "made-up-type"] }, { includeStructure: true });
  assert.match(fragment, /faq/);
  assert.doesNotMatch(fragment, /made-up-type/);
});
