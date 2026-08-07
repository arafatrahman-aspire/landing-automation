import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCatalog, SECTION_TYPES, sectionTypeSchema } from "../src/design-catalog/section-types.mjs";

test("SECTION_TYPES is a non-empty fixed list", () => {
  assert.ok(Array.isArray(SECTION_TYPES) && SECTION_TYPES.length > 0);
  assert.ok(SECTION_TYPES.includes("hero"));
});

test("sectionTypeSchema rejects anything outside the fixed catalog", () => {
  assert.equal(sectionTypeSchema.safeParse("hero").success, true);
  assert.equal(sectionTypeSchema.safeParse("made-up-section").success, false);
});

test("validateCatalog accepts a well-formed catalog", () => {
  const result = validateCatalog({
    hero: { referenceFiles: ["components/Hero.tsx"], note: "above the fold" },
  });
  assert.equal(result.ok, true);
});

test("validateCatalog rejects a section type outside the fixed enum", () => {
  const result = validateCatalog({
    "not-a-real-section": { referenceFiles: ["x.tsx"], note: "..." },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors, /not a recognized section type/i);
});

test("validateCatalog rejects an entry missing referenceFiles/note", () => {
  const result = validateCatalog({ hero: { referenceFiles: [] } });
  assert.equal(result.ok, false);
});

test("the shipped design-catalog/reference-examples.mjs is itself valid (self-check)", async () => {
  const { catalog } = await import("../src/design-catalog/reference-examples.mjs");
  const result = validateCatalog(catalog);
  assert.equal(result.ok, true, result.ok ? "" : result.errors);
});
