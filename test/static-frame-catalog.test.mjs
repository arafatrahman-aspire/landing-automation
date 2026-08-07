import { test } from "node:test";
import assert from "node:assert/strict";
import { frameCatalog, listFrameCandidates, getFrameCandidate } from "../src/design-catalog/static-frame-catalog.mjs";
import { SECTION_TYPES } from "../src/design-catalog/section-types.mjs";

test("frame catalog has no entry for hero (always ai-required, never static)", () => {
  assert.equal("hero" in frameCatalog, false);
});

test("every catalog key is a recognized section type", () => {
  for (const key of Object.keys(frameCatalog)) {
    assert.ok(SECTION_TYPES.includes(key), `"${key}" is not a recognized section type`);
  }
});

test("every candidate's defaultData satisfies its own fillableFields schema", () => {
  for (const [sectionType, candidates] of Object.entries(frameCatalog)) {
    for (const candidate of candidates) {
      if (!candidate.fillableFields) continue;
      const target = candidate.mergeStrategy ? candidate.defaultData[0] : candidate.defaultData;
      const result = candidate.fillableFields.safeParse(target);
      assert.equal(result.success, true, `${sectionType}/${candidate.id}: ${result.success ? "" : result.error.message}`);
    }
  }
});

test("candidates without fillableFields also have no defaultData (bare-render only)", () => {
  for (const candidates of Object.values(frameCatalog)) {
    for (const candidate of candidates) {
      if (!candidate.fillableFields) {
        assert.equal(candidate.defaultData, undefined);
      }
    }
  }
});

test("listFrameCandidates returns [] for a type with no static candidates", () => {
  assert.deepEqual(listFrameCandidates("hero"), []);
});

test("getFrameCandidate finds a real candidate by id and returns null for an unknown one", () => {
  const [expected] = listFrameCandidates("faq");
  assert.equal(getFrameCandidate("faq", expected.id), expected);
  assert.equal(getFrameCandidate("faq", "not-a-real-id"), null);
  assert.equal(getFrameCandidate("hero", "not-a-real-id"), null);
});
