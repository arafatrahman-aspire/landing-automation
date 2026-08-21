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

test("composePage wraps the page in data-campaign-theme with Aspire CSS variables by default", () => {
  const { content } = composePage([{ componentName: "HeroSection0" }], { allowlistBase: "app/campaigns/x/" });
  assert.match(content, /data-campaign-theme/);
  assert.match(content, /--campaign-primary:#125B80/);
  assert.match(content, /--campaign-secondary:#004aad/);
  assert.match(content, /--campaign-accent:#ea4b0c/);
});

test("composePage uses a custom palette's hex in CSS variables", () => {
  const { content } = composePage([{ componentName: "HeroSection0" }], {
    allowlistBase: "app/campaigns/x/",
    colorScheme: { preset: "custom", primary: "#111111", secondary: "#222222", accent: "#333333" },
  });
  assert.match(content, /--campaign-primary:#111111/);
  assert.match(content, /--campaign-accent:#333333/);
  assert.doesNotMatch(content, /--campaign-primary:#125B80/);
});

test("composePage emits an OG metadata export and JSON-LD script when a request is given", () => {
  const { content } = composePage([{ componentName: "HeroSection0" }], {
    allowlistBase: "app/campaigns/x/",
    request: { campaignName: "Splunk Course v7", offer: "Become a certified SOC analyst in 8 weeks." },
  });
  assert.match(content, /export const metadata = \{/);
  assert.match(content, /title: "Splunk Course v7"/);
  assert.match(content, /openGraph: \{/);
  assert.match(content, /<script type="application\/ld\+json"/);
  assert.match(content, /\\"@type\\":\\"Course\\"/);
});

test("composePage emits no metadata/JSON-LD when no request is given (existing callers unaffected)", () => {
  const { content } = composePage([{ componentName: "HeroSection0" }], { allowlistBase: "app/campaigns/x/" });
  assert.doesNotMatch(content, /export const metadata/);
  assert.doesNotMatch(content, /application\/ld\+json/);
});
