import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBrief } from "../src/schemas/campaign-brief-schema.mjs";

test("accepts a valid brief", () => {
  const result = validateBrief({
    slug: "spring-security-sale",
    campaignName: "Spring Security Sale",
    offer: "20% off certification bundles",
    audience: "IT managers at mid-size orgs",
    cta: "Book a demo",
    brief: "Emphasize the discount deadline.",
  });
  assert.equal(result.ok, true);
});

test("rejects a slug with uppercase/underscore/spaces", () => {
  for (const slug of ["Spring_Sale", "spring sale", "SPRING-SALE"]) {
    const result = validateBrief({
      slug,
      campaignName: "x",
      offer: "some offer text",
      audience: "some audience text",
      cta: "Go",
    });
    assert.equal(result.ok, false, `expected "${slug}" to be rejected`);
  }
});

test("rejects a missing required field", () => {
  const result = validateBrief({ slug: "valid-slug", campaignName: "x" });
  assert.equal(result.ok, false);
});

test("accepts a valid aiRequiredSections list", () => {
  const result = validateBrief({
    slug: "spring-security-sale",
    campaignName: "Spring Security Sale",
    offer: "20% off certification bundles",
    audience: "IT managers at mid-size orgs",
    cta: "Book a demo",
    aiRequiredSections: ["pricing", "faq"],
  });
  assert.equal(result.ok, true);
});

test("requiresJobField defaults to false and can be set explicitly", () => {
  const base = { slug: "x-slug", campaignName: "Some Campaign", offer: "some offer text", audience: "some audience text", cta: "Go" };
  const withoutIt = validateBrief(base);
  assert.equal(withoutIt.ok, true);
  assert.equal(withoutIt.value.requiresJobField, false);

  const withIt = validateBrief({ ...base, requiresJobField: true });
  assert.equal(withIt.ok, true);
  assert.equal(withIt.value.requiresJobField, true);
});

test("rejects an aiRequiredSections entry outside the fixed section catalog", () => {
  const result = validateBrief({
    slug: "spring-security-sale",
    campaignName: "Spring Security Sale",
    offer: "20% off certification bundles",
    audience: "IT managers at mid-size orgs",
    cta: "Book a demo",
    aiRequiredSections: ["made-up-section"],
  });
  assert.equal(result.ok, false);
});
