import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySections } from "../src/sections/classify-sections.mjs";
import { buildSectionAgentSystemPrompt } from "../src/sections/section-agent-prompt.mjs";
import { buildTypeScriptPromptFragment } from "../src/pipeline/steps/detect-typescript-strictness.mjs";

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
  assert.match(prompt, /id="regForm"/); // CTA anchors need this on the lead form
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
  assert.match(prompt, /href="#regForm"/); // still tells CTAs where to link
  assert.match(prompt, /CALL-TO-ACTION LINKS/);
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

test("the prompt demands a \"use client\" directive for interactive components (real build-failure regression)", () => {
  const [heroSection] = classifySections([{ type: "hero", summary: "Title, video, lead form" }]);
  const prompt = buildSectionAgentSystemPrompt(heroSection, {
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
    guide: null,
    filePath: "src/app/campaigns/x/sections/HeroSection0.tsx",
    componentName: "HeroSection0",
    previewLeadSinkUrl: "http://localhost:4300/internal/preview-lead-sink",
  });
  assert.match(prompt, /use client/);
  assert.match(prompt, /useState/);
  assert.match(prompt, /VERY FIRST LINE/);
});

test("prompt warns that fallback defaults must be typed for optional fields the JSX reads", () => {
  const [details] = classifySections([{ type: "details", summary: "Benefits" }], { aiRequiredSections: ["details"] });
  const prompt = buildSectionAgentSystemPrompt(details, {
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
    guide: null,
    filePath: "app/campaigns/x/sections/DetailsSection1.tsx",
    componentName: "DetailsSection1",
  });
  assert.match(prompt, /TYPE THE DEFAULTS YOU FALL BACK TO/);
  assert.match(prompt, /Property 'icon' does not exist/);
});

test("timeline prompt warns that ProcessExplainerFrame items need image", () => {
  const [timeline] = classifySections([{ type: "timeline", summary: "How it works" }], { aiRequiredSections: ["timeline"] });
  const prompt = buildSectionAgentSystemPrompt(timeline, {
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
    guide: null,
    filePath: "app/campaigns/x/sections/TimelineSection3.tsx",
    componentName: "TimelineSection3",
  });
  assert.match(prompt, /ProcessExplainerFrame/);
  assert.match(prompt, /image: StaticImageData/);
  assert.match(prompt, /Property 'image' is missing/);
});

test("section prompt includes assigned public image URLs and forbids dummy imports when provided", () => {
  const [details] = classifySections([{ type: "details", summary: "Benefits" }], { aiRequiredSections: ["details"] });
  const prompt = buildSectionAgentSystemPrompt(details, {
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
    guide: null,
    filePath: "app/campaigns/x/sections/DetailsSection1.tsx",
    componentName: "DetailsSection1",
    images: [
      {
        slot: "details",
        publicUrl: "https://abc.supabase.co/storage/v1/object/public/campaign-images/x/details-aaa.jpg",
        width: 800,
        height: 600,
        alt: "desk",
      },
    ],
  });
  assert.match(prompt, /CAMPAIGN IMAGES/);
  assert.match(prompt, /details-aaa\.jpg/);
  assert.match(prompt, /do not invent other remote hosts/i);
  assert.match(prompt, /Do not assign stock photos of people/);
});

test("the type-strictness rules reach the section prompt when provided", () => {
  const [heroSection] = classifySections([{ type: "hero", summary: "Title, video, lead form" }]);
  const base = {
    request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
    guide: null,
    filePath: "src/app/campaigns/x/sections/HeroSection0.tsx",
    componentName: "HeroSection0",
    previewLeadSinkUrl: "http://localhost:4300/internal/preview-lead-sink",
  };

  const withoutTs = buildSectionAgentSystemPrompt(heroSection, base);
  assert.doesNotMatch(withoutTs, /implicitly has an 'any' type/);

  const withTs = buildSectionAgentSystemPrompt(heroSection, {
    ...base,
    typescriptFragment: buildTypeScriptPromptFragment({ isTypeScript: true, strict: true }),
  });
  assert.match(withTs, /implicitly has an 'any' type/);
  assert.match(withTs, /interface IProps/);
});
