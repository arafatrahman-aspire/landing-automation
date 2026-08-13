# Static Section Data Shapes

What `design-catalog/static-frame-catalog.mjs` actually reuses from the
target repo's `src/components/frames/landing/analyze/` folder, and what data
each one needs — written to answer one question: **when a "static" section
gets AI-authored copy, what shape does the AI need to fill in?**

A "static" section (`sections/classify-sections.mjs`) is never touched by a
coding agent — it's pure templating (`sections/fill-static-frame.mjs`): a
frame component imported verbatim, rendered with a literal `data` object.
`sections/generate-static-content.mjs` asks an LLM to fill that shape per
campaign. If that call fails or returns incomplete body copy, generation
falls back to an ai-required coding-agent section rather than shipping the
frame's canned cybersecurity defaults.

**This file is documentation for humans.** The JSON shape actually handed to
the model at generation time is *derived programmatically* from each
candidate's `fillableFields` Zod schema (`describe-fillable-fields.mjs`'s
`describeFillableFields()`) — the exact schema `populateFrame()` validates
the result against — so the runtime context and this doc describe the same
thing, but only the schema can never drift. Treat a mismatch here as this
file being stale, not the code being wrong.

Only fields listed under **Fillable** are ever sent to the model or accepted
back. Anything else on the frame's real interface (GHL form IDs, colors,
images) stays at the frame's own default — either because it's business
config, not campaign copy, or because it's a real photo this service has no
way to source or generate.

---

## hero
Always AI-required — never has a static candidate (`leadform/contract.mjs`
owns hero's own content contract). Not in this catalog.

## details → `risk-list-with-image` (`RiskListWithImageFrame`)
Image (frame's own default photo, never replaced) + heading + bulleted
label/description list + one CTA button.

- **Fillable:**
  ```json
  { "heading": "string", "items": [{ "label": "string", "description": "string" }], "buttonText": "string" }
  ```
- Full copy — no photo dependency. `items` is required for overrides to count
  as usable (heading-only would leave cyber risk bullets in place).

## timeline → `process-explainer` (`ProcessExplainerFrame`)
Title + description + ordered process-step list, next to a side image. Source
component's real prop shape is an ARRAY of one item and **requires**
`image: StaticImageData` — JSON cannot carry that, so `fill-static-frame.mjs`
attaches a stock frame asset (`frame-4-image-1.png`) at emit time. The catalog's
`mergeStrategy` merges text overrides into element 0; the AI still just fills
the flat shape below.

- **Fillable:**
  ```json
  { "title": "string", "description": "string", "processSteps": ["string", "..."] }
  ```

## testimonials
**No static candidate.** The only reusable frame (TestimonialCarouselFrame)
ships Aspire Tech cybersecurity quotes paired with real reviewer photos.
Bare-rendering it on an unrelated campaign is wrong, and this service can't
source replacement photos. `classify-sections.mjs` degrades to ai-required.

## faq → `faq-accordion` (`FaqAccordionFrame`)
Heading + accordion of question/answer pairs, each optionally its own
background color.

- **Fillable:**
  ```json
  { "heading": "string", "items": [{ "title": "string", "content": "string", "bg_color": "string (optional)" }] }
  ```
- Full copy — no photo dependency. `items` must be present in overrides or
  generation falls back to ai-required (heading-only leaves the ISA FAQ list).

## curriculum
**No static candidate.** SyllabusAccordionFrame only accepts
heading/button/GHL ids via `data` — accordion items are hardcoded from the
target repo's shared `FrameData` (Azure / AWS / Splunk modules). Overriding
the heading alone produced the photography-course bug. Degrades to
ai-required.

## pricing
**No static candidate at all** — deliberately absent, not mapped to `[]`
(`classify-sections.mjs` degrades it to ai-required). Completing this
frame's real default would mean shipping one specific certification
programme's actual prices and a live payment link on every unrelated
campaign; pricing is also the section most likely to need to be genuinely
campaign-specific, so there's no reusable template for it.

## instructor
**No static candidate.** TrainerProfilesFrame is photo-dependent (real bios +
certificate images) and can only bare-render the frame's cybersecurity
trainer roster. Degrades to ai-required for the same reason as testimonials.

## footer-cta → `cta-section` (`CtaSectionFrame`)
Centered text-only closing CTA on a solid background, no image.

- **Fillable:**
  ```json
  { "headings": "string", "contents": "string", "btnName": "string", "btnDis": "string" }
  ```
- Full copy — no photo dependency.

---

## Why some section types have no static candidate

`testimonials`, `instructor`, and `curriculum` each have a frame in the
target repo that looks reusable, but none of them can actually carry
campaign-specific body content without shipping another industry's claims
(photo-locked quotes/bios, or syllabus items hardcoded outside the `data`
prop). Prefer an ai-required coding-agent section over a pretty layout with
the wrong words.
