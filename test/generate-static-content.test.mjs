import test from "node:test";
import assert from "node:assert/strict";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";
import { describeFillableFields } from "../src/sections/describe-fillable-fields.mjs";
import { frameCatalog } from "../src/design-catalog/static-frame-catalog.mjs";

/* generate-static-content.mjs transitively imports llm/generate-text.mjs ->
 * config.mjs, which validates process.env at first import — must be a
 * dynamic import AFTER setTestConfigEnv(), never a static top-of-file import
 * (same convention as test/generate-sections.test.mjs).
 *
 * It also makes a real generateText() call for its success path — same as
 * guide()/research() (steps/03-generate-guide.mjs, steps/02-research.mjs),
 * which have no direct unit tests either, because that path needs a real
 * network call and API key. What's tested here is everything reachable
 * WITHOUT a network call: the pure shape-building helper, usability gate,
 * and the early-return when a candidate has no fillableFields. */
setTestConfigEnv();
const { buildFieldShapeExample, generateStaticSectionContent, staticOverridesAreUsable } = await import(
  "../src/sections/generate-static-content.mjs"
);

test("buildFieldShapeExample renders the three describeFillableFields shapes as plain-value placeholders", () => {
  const fields = describeFillableFields(frameCatalog.faq[0].fillableFields);
  const shape = buildFieldShapeExample(fields);
  assert.deepEqual(shape, {
    heading: "string",
    items: [{ title: "string", content: "string", bg_color: "string" }, "... repeat for as many items as make sense"],
  });
});

test("buildFieldShapeExample handles a text field and a text-list field", () => {
  const fields = describeFillableFields(frameCatalog.timeline[0].fillableFields);
  const shape = buildFieldShapeExample(fields);
  assert.equal(shape.title, "string");
  assert.equal(shape.description, "string");
  assert.deepEqual(shape.processSteps, ["string", "as many as make sense"]);
});

test("buildFieldShapeExample skips unsupported fields (none produced for anything in the real catalog)", () => {
  const fields = [{ key: "weird", label: "Weird", kind: "unsupported" }];
  assert.deepEqual(buildFieldShapeExample(fields), {});
});

test("generateStaticSectionContent returns {} with no network call when there are no fillableFields", async () => {
  const result = await generateStaticSectionContent({
    candidate: { id: "bare", description: "x" },
    section: { type: "faq", summary: "x" },
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
  });
  assert.deepEqual(result, {});
});

test("staticOverridesAreUsable rejects empty overrides and heading-only FAQ overrides", () => {
  const faq = frameCatalog.faq[0];
  assert.equal(staticOverridesAreUsable(faq, {}), false);
  assert.equal(staticOverridesAreUsable(faq, { heading: "Photography FAQs" }), false, "heading alone leaves cyber items");
  assert.equal(
    staticOverridesAreUsable(faq, {
      heading: "Photography FAQs",
      items: [{ title: "Do I need a DSLR?", content: "No — a phone works." }],
    }),
    true
  );
});

test("staticOverridesAreUsable rejects a candidate with no fillableFields", () => {
  assert.equal(staticOverridesAreUsable({ id: "bare" }, { heading: "x" }), false);
});

test("curriculum/testimonials/instructor have no static candidates (force ai-required)", () => {
  assert.equal("curriculum" in frameCatalog, false);
  assert.equal("testimonials" in frameCatalog, false);
  assert.equal("instructor" in frameCatalog, false);
  assert.equal("pricing" in frameCatalog, false);
});
