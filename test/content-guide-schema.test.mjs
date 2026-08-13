import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGuide, truncateGuideFields, LIMITS, classifiedSectionSchema } from "../src/schemas/content-guide-schema.mjs";

const validGuide = {
  heroTitle: "Save 50% on your annual plan — this week only",
  heroHasVideo: true,
  seoTitle: "Annual Plan Sale — 50% Off",
  seoMetaDescription: "Save 50% on an annual plan this week. Limited-time offer for small business owners.",
  sections: [
    { type: "hero", summary: "Title, video, lead form" },
    { type: "faq", summary: "3 common questions" },
  ],
};

test("accepts a valid guide", () => {
  const result = validateGuide(validGuide);
  assert.equal(result.ok, true);
});

test("rejects a section type outside the fixed catalog (can't invent new section types)", () => {
  const result = validateGuide({
    ...validGuide,
    sections: [{ type: "hero", summary: "..." }, { type: "made-up-section", summary: "..." }],
  });
  assert.equal(result.ok, false);
});

test("rejects an empty sections array", () => {
  const result = validateGuide({ ...validGuide, sections: [] });
  assert.equal(result.ok, false);
});

test("rejects a missing required field", () => {
  const { heroTitle, ...rest } = validGuide;
  const result = validateGuide(rest);
  assert.equal(result.ok, false);
});

test("truncateGuideFields clamps oversized SEO strings instead of failing (LLMs miscount characters)", () => {
  const oversized = {
    ...validGuide,
    seoTitle: "x".repeat(LIMITS.seoTitle + 50),
    seoMetaDescription: "y".repeat(LIMITS.seoMetaDescription + 50),
    sections: [{ type: "hero", summary: "z".repeat(2000) }],
  };
  const clamped = truncateGuideFields(oversized);
  assert.equal(validateGuide(clamped).ok, true);
  assert.ok(clamped.seoTitle.length <= LIMITS.seoTitle);
  assert.ok(clamped.seoMetaDescription.length <= LIMITS.seoMetaDescription);
  // Section summaries have no character cap — left intact.
  assert.equal(clamped.sections[0].summary.length, 2000);
});

test("section summaries of any length are accepted", () => {
  const long = {
    ...validGuide,
    sections: [{ type: "hero", summary: "Detailed brief. ".repeat(80).trim() }],
  };
  assert.equal(validateGuide(long).ok, true);
});

test("truncateGuideFields leaves well-formed fields untouched", () => {
  const clamped = truncateGuideFields(validGuide);
  assert.deepEqual(clamped, validGuide);
});

test("classifiedSectionSchema accepts a well-formed static section", () => {
  const result = classifiedSectionSchema.safeParse({ type: "faq", summary: "3 common questions", mode: "static", frameId: "faq-accordion" });
  assert.equal(result.success, true);
});

test("classifiedSectionSchema accepts a well-formed ai-required section", () => {
  const result = classifiedSectionSchema.safeParse({ type: "hero", summary: "Title, video, lead form", mode: "ai-required", frameId: null });
  assert.equal(result.success, true);
});

test("classifiedSectionSchema rejects mode:static with a null frameId", () => {
  const result = classifiedSectionSchema.safeParse({ type: "faq", summary: "...", mode: "static", frameId: null });
  assert.equal(result.success, false);
});

test("classifiedSectionSchema rejects mode:ai-required with a non-null frameId", () => {
  const result = classifiedSectionSchema.safeParse({ type: "hero", summary: "...", mode: "ai-required", frameId: "faq-accordion" });
  assert.equal(result.success, false);
});
