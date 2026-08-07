import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionComponentName, sectionFilePath, pageFilePath, sectionSlotId, composePage } from "../src/sections/compose-page.mjs";

test("sectionComponentName is PascalCase and index-suffixed (collision-safe)", () => {
  assert.equal(sectionComponentName("faq", 1), "FaqSection1");
  assert.equal(sectionComponentName("footer-cta", 4), "FooterCtaSection4");
});

test("sectionFilePath / pageFilePath follow the allowlist-relative sections/ convention", () => {
  assert.equal(sectionFilePath("app/campaigns/spring-sale/", "FaqSection1"), "app/campaigns/spring-sale/sections/FaqSection1.tsx");
  assert.equal(pageFilePath("app/campaigns/spring-sale/"), "app/campaigns/spring-sale/page.tsx");
});

test("sectionSlotId is positional, not tied to section type", () => {
  assert.equal(sectionSlotId(0), "section-0");
  assert.equal(sectionSlotId(3), "section-3");
});

test("composePage imports and renders every section in order", () => {
  const { path: p, content } = composePage(
    [{ componentName: "HeroSection0" }, { componentName: "FaqSection1" }],
    { allowlistBase: "app/campaigns/x/" }
  );
  assert.equal(p, "app/campaigns/x/page.tsx");
  assert.match(content, /import HeroSection0 from "\.\/sections\/HeroSection0";/);
  assert.match(content, /import FaqSection1 from "\.\/sections\/FaqSection1";/);
  const heroIdx = content.indexOf("<HeroSection0");
  const faqIdx = content.indexOf("<FaqSection1");
  assert.ok(heroIdx > -1 && faqIdx > -1 && heroIdx < faqIdx, "sections must render in declared order");
});
