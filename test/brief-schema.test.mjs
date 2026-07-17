import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBrief } from "../src/schemas/brief-schema.mjs";

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
