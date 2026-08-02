import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSectionMode, classifySections } from "../src/sections/classify.mjs";
import { listFrameCandidates } from "../src/design/frame-catalog.mjs";

test("hero is always ai-required, even if flagged in aiRequiredSections is irrelevant", () => {
  assert.equal(resolveSectionMode("hero", []), "ai-required");
  assert.equal(resolveSectionMode("hero", ["hero"]), "ai-required");
});

test("a brief-flagged section type becomes ai-required", () => {
  assert.equal(resolveSectionMode("pricing", ["pricing"]), "ai-required");
});

test("an unflagged section type with a static candidate defaults to static", () => {
  assert.equal(resolveSectionMode("faq", []), "static");
});

test("a section type with no static candidate falls back to ai-required even if unflagged", () => {
  // "hero" has no catalog entry by design; asserting the general fallback
  // behavior against it directly (distinct from the special-case rule above,
  // since resolveSectionMode checks hero first) would be redundant — instead
  // confirm the fallback logic via a type with no candidates by construction.
  assert.equal(listFrameCandidates("does-not-exist").length, 0);
  assert.equal(resolveSectionMode("does-not-exist", []), "ai-required");
});

test("classifySections maps a full guide section list correctly", () => {
  const guideSections = [
    { type: "hero", summary: "Title, video, lead form" },
    { type: "faq", summary: "3 common questions" },
    { type: "pricing", summary: "Package tiers" },
  ];
  const classified = classifySections(guideSections, { aiRequiredSections: ["pricing"] });

  assert.deepEqual(
    classified.map((s) => ({ type: s.type, mode: s.mode })),
    [
      { type: "hero", mode: "ai-required" },
      { type: "faq", mode: "static" },
      { type: "pricing", mode: "ai-required" },
    ]
  );
  assert.equal(classified[0].frameId, null); // hero
  assert.equal(classified[1].frameId, listFrameCandidates("faq")[0].id); // faq
  assert.equal(classified[2].frameId, null); // pricing, flagged ai-required
});

test("classifySections preserves the original type/summary fields", () => {
  const classified = classifySections([{ type: "faq", summary: "3 common questions" }]);
  assert.equal(classified[0].type, "faq");
  assert.equal(classified[0].summary, "3 common questions");
});
