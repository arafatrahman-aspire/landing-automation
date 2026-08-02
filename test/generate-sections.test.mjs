import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";
import { classifySections } from "../src/sections/classify.mjs";

// generate-sections.mjs transitively imports ai/coding-agent.mjs -> config.mjs,
// which validates process.env at first import — must be a dynamic import
// AFTER setTestConfigEnv(), never a static top-of-file import (same
// convention as test/sqlite-repository.test.mjs / test/draft-store.test.mjs).
setTestConfigEnv();
const {
  sectionComponentName,
  sectionFilePath,
  pageFilePath,
  sectionSlotId,
  buildStaticSectionFile,
  buildSectionAgentSystemPrompt,
  composePage,
  generateSections,
} = await import("../src/sections/generate-sections.mjs");

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

test("buildStaticSectionFile produces real, importable wrapper content for a static section", () => {
  const [faqSection] = classifySections([{ type: "faq", summary: "3 common questions" }]);
  const built = buildStaticSectionFile(faqSection, { allowlistBase: "app/campaigns/x/", index: 0 });
  assert.equal(built.path, "app/campaigns/x/sections/FaqSection0.tsx");
  assert.equal(built.componentName, "FaqSection0");
  assert.match(built.content, /export default function FaqSection0/);
});

test("buildStaticSectionFile throws for an ai-required section (no frameId to look up)", () => {
  const [heroSection] = classifySections([{ type: "hero", summary: "Title, video, lead form" }]);
  assert.throws(() => buildStaticSectionFile(heroSection, { allowlistBase: "app/campaigns/x/", index: 0 }));
});

test("buildSectionAgentSystemPrompt scopes the guardrail to exactly one file", () => {
  const [heroSection] = classifySections([{ type: "hero", summary: "Title, video, lead form" }]);
  const prompt = buildSectionAgentSystemPrompt(heroSection, {
    request: { campaignName: "Spring Sale", offer: "20% off", audience: "IT managers", cta: "Book a demo" },
    guide: null,
    filePath: "app/campaigns/x/sections/HeroSection0.tsx",
    componentName: "HeroSection0",
    previewLeadSinkUrl: "http://localhost:4300/internal/preview-lead-sink",
  });
  assert.match(prompt, /You may create EXACTLY ONE file: app\/campaigns\/x\/sections\/HeroSection0\.tsx/);
  assert.match(prompt, /data-hero-title/); // hero contract included for hero sections
  assert.match(prompt, /export a default React component named HeroSection0/i);
});

test("buildSectionAgentSystemPrompt includes the lead-form contract for hero, honoring requiresJobField", () => {
  const [heroSection] = classifySections([{ type: "hero", summary: "Title, video, lead form" }]);
  const base = {
    guide: null,
    filePath: "app/campaigns/x/sections/HeroSection0.tsx",
    componentName: "HeroSection0",
    previewLeadSinkUrl: "http://localhost:4300/internal/preview-lead-sink",
  };

  const withoutJobField = buildSectionAgentSystemPrompt(heroSection, {
    ...base,
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
  });
  assert.match(withoutJobField, /company_website/); // honeypot field name
  assert.match(withoutJobField, /http:\/\/localhost:4300\/internal\/preview-lead-sink/);
  assert.doesNotMatch(withoutJobField, /jobTitle/);

  const withJobField = buildSectionAgentSystemPrompt(heroSection, {
    ...base,
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x", requiresJobField: true },
  });
  assert.match(withJobField, /jobTitle/);
});

test("buildSectionAgentSystemPrompt omits the hero contract for non-hero sections", () => {
  const [pricingSection] = classifySections([{ type: "pricing", summary: "Package tiers" }], { aiRequiredSections: ["pricing"] });
  const prompt = buildSectionAgentSystemPrompt(pricingSection, {
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
    guide: null,
    filePath: "app/campaigns/x/sections/PricingSection0.tsx",
    componentName: "PricingSection0",
  });
  assert.doesNotMatch(prompt, /data-hero-title/);
  assert.doesNotMatch(prompt, /company_website/); // lead-form contract only threaded into hero
});

test("buildSectionAgentSystemPrompt includes verifyReport feedback only when retrying", () => {
  const [heroSection] = classifySections([{ type: "hero", summary: "Title, video, lead form" }]);
  const base = {
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
    guide: null,
    filePath: "x.tsx",
    componentName: "X",
    previewLeadSinkUrl: "http://localhost:4300/internal/preview-lead-sink",
  };

  const fresh = buildSectionAgentSystemPrompt(heroSection, base);
  assert.doesNotMatch(fresh, /FAILED VERIFICATION/);

  const retry = buildSectionAgentSystemPrompt(heroSection, { ...base, verifyReport: "hero-fit: title overflows on mobile" });
  assert.match(retry, /FAILED VERIFICATION/);
  assert.match(retry, /title overflows on mobile/);
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

test("generateSections writes real files for an all-static section list (no LLM/network involved)", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "generate-sections-test-"));
  try {
    const classified = classifySections([
      { type: "faq", summary: "3 common questions" },
      { type: "footer-cta", summary: "Closing CTA" },
    ]);
    const allowlist = ["app/campaigns/spring-sale/"];

    const result = await generateSections({
      classifiedSections: classified,
      workdir,
      allowlist,
      pristineFiles: new Set(),
      request: { campaignName: "Spring Sale", offer: "20% off", audience: "IT managers", cta: "Book a demo" },
      guide: { sections: classified },
    });

    assert.equal(result.codeFinished, true);
    assert.equal(result.sectionResults.length, 2);
    assert.equal(result.writtenByAgent.size, 3); // 2 sections + composed page

    for (const relPath of result.writtenByAgent) {
      const content = await readFile(path.join(workdir, relPath), "utf8");
      assert.ok(content.length > 0, `${relPath} should have real content`);
    }
    const pageContent = await readFile(path.join(workdir, "app/campaigns/spring-sale/page.tsx"), "utf8");
    assert.match(pageContent, /FaqSection0/);
    assert.match(pageContent, /FooterCtaSection1/);

    assert.deepEqual(result.sectionResults.map((r) => r.slot), ["section-0", "section-1"]);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("generateSections' static writes go through the same guard as agent writes — refuses a pristine (pre-existing) path", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "generate-sections-test-"));
  try {
    const classified = classifySections([{ type: "faq", summary: "3 common questions" }]);
    const allowlist = ["app/campaigns/spring-sale/"];
    await assert.rejects(
      generateSections({
        classifiedSections: classified,
        workdir,
        allowlist,
        // Pretend this exact deterministic path already existed before the
        // run — the pristine-file guard must reject it exactly like it
        // would for the coding agent's own write_file tool.
        pristineFiles: new Set(["app/campaigns/spring-sale/sections/FaqSection0.tsx"]),
        request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
        guide: { sections: classified },
      }),
      /existed before this run/
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});
