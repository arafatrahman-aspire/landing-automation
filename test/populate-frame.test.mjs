import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { populateFrame } from "../src/sections/populate-frame.mjs";
import { frameCatalog } from "../src/design/frame-catalog.mjs";

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
