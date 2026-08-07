import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSectionMode, classifySections } from "../src/sections/classify-sections.mjs";
import { listFrameCandidates } from "../src/design-catalog/static-frame-catalog.mjs";

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

/* Frame-availability fallback — regression cover for the real run where the
 * target repo's analyze/ frame directory was untracked in git, so every
 * catalog frame was missing from the fresh worktree and all four static
 * sections generated unresolvable imports. */

test("a section whose only frames are missing from the repo degrades to ai-required, not a broken static import", () => {
  const classified = classifySections([{ type: "faq", summary: "3 common questions" }], {
    isFrameAvailable: () => false, // nothing in the catalog exists in this checkout
  });
  assert.equal(classified[0].mode, "ai-required");
  assert.equal(classified[0].frameId, null);
});

test("classifySections picks the first AVAILABLE candidate, not blindly the first listed", () => {
  const faqCandidates = listFrameCandidates("faq");
  if (faqCandidates.length < 2) return; // only meaningful once a type has multiple candidates

  const classified = classifySections([{ type: "faq", summary: "x" }], {
    isFrameAvailable: (c) => c.id === faqCandidates[1].id, // only the SECOND one exists
  });
  assert.equal(classified[0].mode, "static");
  assert.equal(classified[0].frameId, faqCandidates[1].id);
});

test("resolveSectionMode still reports static when the frame is actually present", () => {
  assert.equal(resolveSectionMode("faq", [], () => true), "static");
  assert.equal(resolveSectionMode("faq", [], () => false), "ai-required");
  // hero is ai-required regardless of frame availability
  assert.equal(resolveSectionMode("hero", [], () => true), "ai-required");
});
