import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { populateFrame } from "../src/sections/fill-static-frame.mjs";
import { frameCatalog } from "../src/design-catalog/static-frame-catalog.mjs";

test("merges overrides over defaultData for an object-shaped candidate", () => {
  const candidate = {
    component: "FaqAccordionFrame",
    importPath: "@components/frames/landing/analyze/FaqAccordionFrame",
    defaultData: { heading: "Default heading", items: [{ title: "Q", content: "A" }] },
    fillableFields: z.object({ heading: z.string().min(1) }).partial(),
  };
  const { fileContent, dataUsed } = populateFrame({
    candidate,
    overrides: { heading: "Custom campaign heading" },
    componentName: "FaqSection",
  });

  assert.equal(dataUsed.heading, "Custom campaign heading");
  assert.deepEqual(dataUsed.items, candidate.defaultData.items); // untouched, not in overrides
  assert.match(fileContent, /import FaqAccordionFrame from "@components\/frames\/landing\/analyze\/FaqAccordionFrame";/);
  assert.match(fileContent, /const data = {/);
  assert.match(fileContent, /"Custom campaign heading"/);
  assert.match(fileContent, /export default function FaqSection\(\)/);
  assert.match(fileContent, /<FaqAccordionFrame data={data} \/>/);
});

test("uses defaultData untouched when no overrides are given", () => {
  const candidate = {
    component: "CtaSectionFrame",
    importPath: "@components/frames/landing/analyze/CtaSectionFrame",
    defaultData: { headings: "Default heading" },
    fillableFields: z.object({ headings: z.string().min(1) }).partial(),
  };
  const { dataUsed } = populateFrame({ candidate, componentName: "FooterCta" });
  assert.deepEqual(dataUsed, candidate.defaultData);
});

test("applies a custom mergeStrategy for array-shaped candidate data", () => {
  const candidate = {
    component: "ProcessExplainerFrame",
    importPath: "@components/frames/landing/analyze/ProcessExplainerFrame",
    defaultData: [{ title: "Default title", description: "Default desc", processSteps: ["a", "b"] }],
    fillableFields: z.object({ title: z.string().min(1) }).partial(),
    mergeStrategy: (defaultData, overrides) => [{ ...defaultData[0], ...overrides }],
  };
  const { dataUsed } = populateFrame({ candidate, overrides: { title: "Custom title" }, componentName: "Timeline" });
  assert.ok(Array.isArray(dataUsed));
  assert.equal(dataUsed[0].title, "Custom title");
  assert.deepEqual(dataUsed[0].processSteps, ["a", "b"]);
});

test("renders bare (no data prop) for a candidate with no fillableFields/defaultData", () => {
  const candidate = {
    component: "TestimonialCarouselFrame",
    importPath: "@components/frames/landing/analyze/TestimonialCarouselFrame",
  };
  const { fileContent, dataUsed } = populateFrame({ candidate, componentName: "Testimonials" });
  assert.equal(dataUsed, null);
  assert.doesNotMatch(fileContent, /const data =/);
  assert.match(fileContent, /<TestimonialCarouselFrame \/>/);
});

test("rejects overrides that don't match fillableFields", () => {
  const candidate = {
    component: "FaqAccordionFrame",
    importPath: "x",
    defaultData: { heading: "x" },
    fillableFields: z.object({ heading: z.string().min(1) }).partial(),
  };
  assert.throws(() => populateFrame({ candidate, overrides: { heading: 123 }, componentName: "FaqSection" }));
});

test("rejects a non-PascalCase componentName", () => {
  const candidate = { component: "X", importPath: "x" };
  assert.throws(() => populateFrame({ candidate, componentName: "faqSection" }));
  assert.throws(() => populateFrame({ candidate, componentName: "faq-section" }));
});

test("every real catalog candidate populates without throwing", () => {
  for (const [sectionType, candidates] of Object.entries(frameCatalog)) {
    for (const candidate of candidates) {
      const result = populateFrame({ candidate, componentName: "GeneratedSection" });
      assert.equal(typeof result.fileContent, "string", `${sectionType}/${candidate.id} failed to populate`);
    }
  }
});

/* ---------------- "use client" boundary ---------------- */

test('every generated wrapper opens with "use client"', () => {
  // The regression: a wrapper rendering SyllabusAccordionFrame (which calls
  // useState but carries no "use client" of its own) sat between a Server
  // Component page and a hook — so the build failed with "You're importing a
  // component that needs useState... none of its parents are marked with
  // 'use client'". Both wrapper shapes must carry the boundary.
  const withData = frameCatalog.faq[0];
  const bare = Object.values(frameCatalog)
    .flat()
    .find((c) => !c.fillableFields);

  assert.match(populateFrame({ candidate: withData, componentName: "FaqSection" }).fileContent, /^"use client";\n\n/);
  if (bare) {
    assert.match(populateFrame({ candidate: bare, componentName: "BareSection" }).fileContent, /^"use client";\n\n/);
  }
});

test('the directive comes before the import, not after', () => {
  // Anything above it — even a comment — and Next stops treating it as a
  // directive, which fails exactly the same way as omitting it. Uses a
  // candidate with no special-cased inline emit (faq-accordion and
  // cta-section are now always inlined and have no import at all), so this
  // exercises the plain raw-frame-import path that still has one.
  const candidate = { component: "TestimonialCarouselFrame", importPath: "@components/frames/landing/analyze/TestimonialCarouselFrame" };
  const { fileContent } = populateFrame({ candidate, componentName: "Testimonials" });
  const lines = fileContent.split("\n");
  assert.equal(lines[0], '"use client";');
  assert.ok(fileContent.indexOf('"use client"') < fileContent.indexOf("import "));
});

test("risk-list-with-image emits a working #regForm CTA instead of the dead frame button", () => {
  const candidate = frameCatalog.details.find((c) => c.id === "risk-list-with-image");
  assert.ok(candidate, "expected risk-list-with-image in catalog");
  const { fileContent } = populateFrame({
    candidate,
    overrides: { buttonText: "Reserve my spot" },
    componentName: "DetailsSection1",
  });
  assert.match(fileContent, /href="#regForm"/);
  assert.match(fileContent, /Reserve my spot/);
  assert.doesNotMatch(fileContent, /RiskListWithImageFrame/);
});

test("process-explainer emits a StaticImageData image so TypeScript accepts ProcessExplainerItem", () => {
  const candidate = frameCatalog.timeline.find((c) => c.id === "process-explainer");
  assert.ok(candidate, "expected process-explainer in catalog");
  const { fileContent } = populateFrame({
    candidate,
    overrides: { title: "Your 3-day path" },
    componentName: "TimelineSection3",
  });
  assert.match(fileContent, /import SideImage from "@assets\/images\/frames\/landing\/frame-4-image-1\.png"/);
  assert.match(fileContent, /image: SideImage/);
  assert.match(fileContent, /Your 3-day path/);
  assert.match(fileContent, /ProcessExplainerFrame/);
  // Must not JSON-serialize data without image (the original type error).
  assert.doesNotMatch(fileContent, /const data = \[/);
});

test("risk-list-with-image uses a remote details URL instead of DummyImage", () => {
  const candidate = frameCatalog.details.find((c) => c.id === "risk-list-with-image");
  const { fileContent } = populateFrame({
    candidate,
    componentName: "DetailsSection1",
    images: [
      {
        slot: "details",
        query: "workspace",
        source: "pexels",
        publicUrl: "https://abc.supabase.co/storage/v1/object/public/campaign-images/x/details-aaa.jpg",
        width: 800,
        height: 600,
        alt: "workspace desk",
      },
    ],
  });
  assert.match(fileContent, /https:\/\/abc\.supabase\.co\/storage\/v1\/object\/public\/campaign-images\/x\/details-aaa\.jpg/);
  assert.match(fileContent, /workspace desk/);
  assert.match(fileContent, /width=\{800\}/);
  assert.doesNotMatch(fileContent, /DummyImage/);
  assert.doesNotMatch(fileContent, /frame-3-image-1/);
});

test("process-explainer with a timeline URL inlines next/image instead of ProcessExplainerFrame", () => {
  const candidate = frameCatalog.timeline.find((c) => c.id === "process-explainer");
  const { fileContent } = populateFrame({
    candidate,
    overrides: { title: "Your 3-day path" },
    componentName: "TimelineSection3",
    images: [
      {
        slot: "timeline",
        query: "process",
        source: "serpapi",
        publicUrl: "https://abc.supabase.co/storage/v1/object/public/campaign-images/x/timeline-bbb.jpg",
        width: 1024,
        height: 768,
        alt: "planning board",
      },
    ],
  });
  assert.match(fileContent, /planning board/);
  assert.match(fileContent, /timeline-bbb\.jpg/);
  assert.doesNotMatch(fileContent, /ProcessExplainerFrame/);
  assert.doesNotMatch(fileContent, /frame-4-image-1/);
});

test("custom colorScheme substitutes hex on the inlined details CTA", () => {
  const candidate = frameCatalog.details.find((c) => c.id === "risk-list-with-image");
  const { fileContent } = populateFrame({
    candidate,
    componentName: "DetailsSection1",
    colorScheme: { preset: "custom", primary: "#111111", secondary: "#222222", accent: "#333333" },
  });
  assert.match(fileContent, /bg-\[#222222\]/);
  assert.doesNotMatch(fileContent, /bg-\[#004aad\]/);
});

test("custom colorScheme's hex reaches the redesigned FAQ grid", () => {
  const { fileContent } = populateFrame({
    candidate: frameCatalog.faq[0],
    overrides: { heading: "Photo FAQs" },
    componentName: "FaqSection2",
    colorScheme: { preset: "custom", primary: "#111111", secondary: "#222222", accent: "#333333" },
  });
  assert.match(fileContent, /Photo FAQs/);
  assert.match(fileContent, /color: "#111111"/);
  assert.doesNotMatch(fileContent, /FaqAccordionFrame/);
});

test("FAQ is always the redesigned card grid (not the raw frame), for every preset", () => {
  const { fileContent } = populateFrame({
    candidate: frameCatalog.faq[0],
    componentName: "FaqSection2",
    colorScheme: { preset: "aspire" },
  });
  assert.doesNotMatch(fileContent, /FaqAccordionFrame/);
  // 2-column responsive grid, not the old single-column stacked list.
  assert.match(fileContent, /md:grid-cols-2/);
  // item.bg_color may still ride along in the JSON data blob (harmless,
  // unused) but the JSX must never render it as a className/style — that's
  // the raw frame's footgun (a real run filled it with an invalid bare CSS
  // custom-property name), and this design has no bg_color usage at all.
  assert.doesNotMatch(fileContent, /item\.bg_color/);
});

test("cta-section is always inlined (not the raw frame) — its baked colors fail WCAG AA contrast", () => {
  const candidate = frameCatalog["footer-cta"].find((c) => c.id === "cta-section");
  const { fileContent } = populateFrame({
    candidate,
    componentName: "FooterCtaSection1",
    colorScheme: { preset: "aspire" },
  });
  assert.doesNotMatch(fileContent, /CtaSectionFrame/);
  assert.doesNotMatch(fileContent, /text-green-400/);
  assert.match(fileContent, /font-bold/);
});
