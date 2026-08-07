import { z } from "zod";

/* Static frame catalog (new_plan.md §9.3 — Hybrid Section Assembly).
 *
 * Candidate frame components come from the TARGET repo's own analyzed
 * component library: atss-frontend's
 * src/components/frames/landing/analyze/ (catalogued earlier this project —
 * ~53 legacy "Frame*" components renamed by section type, each already
 * following one uniform shape: `function XFrame({ data = defaultXData })`).
 * This file is the human-curated bridge from the fixed SECTION_TYPES enum
 * (design-catalog/section-types.mjs) to those real components — analogous to
 * design-catalog/reference-examples.mjs, but for literal reuse (fill-static-frame.mjs) instead of
 * LLM grounding examples.
 *
 * `defaultData` is a FULL, real copy of each frame's own built-in default
 * data object (never partial) — fill-static-frame.mjs merges guide overrides
 * on top of it. It has to be the complete object, not just the fillable
 * subset: these components take `data` as an all-or-nothing prop with no
 * internal deep-merge, so a partial object would blank out every field the
 * merge doesn't cover, including real photos this catalog has no way to
 * reproduce (image imports aren't representable as plain data here, in the
 * SERVICE repo, since they only resolve inside the target repo's own build).
 *
 * `fillableFields` is a Zod schema for the subset of top-level keys campaign
 * copy is allowed to override. A candidate with NO `fillableFields` (and no
 * `defaultData`) always renders bare (`<XFrame />`, no `data` prop at all) —
 * deliberate for frames whose real defaults include photos (testimonials,
 * instructor bios): this service can't generate or source real photos, so
 * it never guesses at replacing them.
 *
 * `hero` intentionally has NO entry: per new_plan.md §9.2, hero is always
 * ai-required, never static.
 */

const importBase = "@components/frames/landing/analyze";

export const frameCatalog = {
  details: [
    {
      id: "risk-list-with-image",
      component: "RiskListWithImageFrame",
      importPath: `${importBase}/RiskListWithImageFrame`,
      description: "Image + bulleted risk/feature list + single CTA button. Fully campaign-fillable (no photo fields).",
      defaultData: {
        heading: "Uncover the urgent and critical protections businesses must have in place now to protect…",
        items: [
          {
            label: "Their Bank Accounts: ",
            description:
              "The bank is NOT required to replace funds stolen due to cybercrime, and unless businesses have a very specific type of insurance policy, any financial losses will be denied coverage, plus…",
          },
          {
            label: "Client Data: ",
            description:
              "The courts will not support your case if you expose client data to cybercriminals, not to mention the reputational damages that come along with breaking data breach laws, and…",
          },
          {
            label: "Confidential Information: ",
            description:
              "Payroll, HR, accounting firms and more have direct access to highly confidential information which could be sold, stolen or encrypted, and also…",
          },
          {
            label: "Reputation: ",
            description:
              "When a data breach occurs, news travels FAST and it is the responsibility of the business, and those in charge, to have the proper protections in place for their confidential information and their clients.",
          },
        ],
        buttonText: "GET INSTANT ACCESS",
      },
      fillableFields: z
        .object({
          heading: z.string().min(1),
          items: z.array(z.object({ label: z.string().min(1), description: z.string().min(1) })).min(1),
          buttonText: z.string().min(1),
        })
        .partial(),
    },
  ],

  timeline: [
    {
      id: "process-explainer",
      component: "ProcessExplainerFrame",
      importPath: `${importBase}/ProcessExplainerFrame`,
      description:
        "Title + description + ordered process-step list + side image. The source component has no built-in default (fully prop-driven already) — this catalog entry supplies a generic one. Data shape is an ARRAY of one item; the side image always stays the frame's own default.",
      // ProcessExplainerFrame's `data` prop is `ProcessExplainerItem[]`, not
      // an object — mergeStrategy below merges overrides into element 0.
      defaultData: [
        {
          title: "Your Path Forward",
          description: "A clear, guided process from first contact to results.",
          processSteps: ["Step 1: Discovery", "Step 2: Plan", "Step 3: Execute", "Step 4: Review"],
        },
      ],
      fillableFields: z
        .object({
          title: z.string().min(1),
          description: z.string().min(1),
          processSteps: z.array(z.string().min(1)).min(1),
        })
        .partial(),
      mergeStrategy: (defaultData, overrides) => [{ ...defaultData[0], ...overrides }],
    },
  ],

  testimonials: [
    {
      id: "testimonial-carousel",
      component: "TestimonialCarouselFrame",
      importPath: `${importBase}/TestimonialCarouselFrame`,
      description:
        "Auto-playing testimonial carousel. Not campaign-fillable — every quote is paired with a real reviewer photo this service can't source or generate, so it always renders with the frame's own curated default untouched.",
      // No defaultData/fillableFields on purpose — see file header. Listed
      // here so it's still selectable as "the" static candidate for this
      // section type; fill-static-frame.mjs always renders it bare.
    },
  ],

  faq: [
    {
      id: "faq-accordion",
      component: "FaqAccordionFrame",
      importPath: `${importBase}/FaqAccordionFrame`,
      description: "Accordion of question/answer pairs — fully campaign-fillable.",
      defaultData: {
        heading: "Frequently Asked Questions",
        items: [
          {
            title: "Are there flexible payment options?",
            content:
              "Yes, Aspire Tech offers an Income Share Agreement (ISA) option, allowing participants to defer payments until they secure a job with a predetermined salary threshold.",
            bg_color: "bg-[#ecf7fb]",
          },
          {
            title: "What is an Income Share Agreement (ISA)?",
            content:
              "It's a payment model where participants pay a fixed percentage of their income for a set duration after securing employment. No payment is required upfront.",
            bg_color: "bg-[#ecf7fb]",
          },
          {
            title: "Who is eligible for the training program?",
            content:
              "The program is open to anyone with an interest in cybersecurity and cloud technologies, including beginners and professionals looking to improve their skills.",
          },
          {
            title: "What makes Aspire Tech's training unique?",
            content:
              "Aspire Tech is a full-fledged cybersecurity service provider, ensuring participants gain real-world knowledge through practical labs, live projects, and expert mentorship.",
            bg_color: "bg-[#ecf7fb]",
          },
          {
            title: "What is the placement success rate?",
            content:
              "Placement rates range from 40%–90%, depending on the package, with graduates earning salaries between $50,000–$100,000 annually.",
            bg_color: "bg-[#ecf7fb]",
          },
          {
            title: "Can I balance the training with a full-time job?",
            content: "Yes, the flexible schedules (evening and weekend classes) make it possible for working professionals to attend.",
            bg_color: "bg-[#ecf7fb]",
          },
          {
            title: "Who leads the training sessions?",
            content:
              "The sessions are led by a team of industry experts with decades of experience in cloud and cybersecurity, including certifications such as CISSP, CCISO, and AWS",
            bg_color: "bg-[#ecf7fb]",
          },
        ],
      },
      fillableFields: z
        .object({
          heading: z.string().min(1),
          items: z
            .array(
              z.object({
                title: z.string().min(1),
                content: z.string().min(1),
                bg_color: z.string().optional(),
              })
            )
            .min(1),
        })
        .partial(),
    },
  ],

  curriculum: [
    {
      id: "syllabus-accordion",
      component: "SyllabusAccordionFrame",
      importPath: `${importBase}/SyllabusAccordionFrame`,
      description:
        "Syllabus accordion + download-syllabus modal CTA. Heading and button text are campaign-fillable; the GHL form wiring (ghlFormId/ghlFormName) stays default — that's business config, not campaign copy.",
      defaultData: {
        heading: "Syllabus Of Cloud Security Training Program",
        ghlFormId: "RzdOq6FcRqPL9VxYEKN4",
        ghlFormName: "Training - USA-Mar2025-Download-Sylabus",
        downloadButtonText: "Download Full Syllabus",
      },
      fillableFields: z
        .object({
          heading: z.string().min(1),
          downloadButtonText: z.string().min(1),
        })
        .partial(),
    },
  ],

  pricing: [
    {
      id: "pricing-packages-grid",
      component: "PricingPackagesGridFrame",
      importPath: `${importBase}/PricingPackagesGridFrame`,
      description:
        "Tiered pricing card grid + comparison table. Only the intro copy is campaign-fillable — the packages/prices themselves stay curated defaults (too structured/sensitive for a text guide to reinvent reliably).",
      defaultData: {
        eyebrow: "Certification Training",
        heading: "Choose Your Learning Path",
        description:
          "Select the certification package that aligns with your career goals and budget. Each tier includes industry-recognized certifications and career support.",
      },
      fillableFields: z
        .object({
          eyebrow: z.string().min(1),
          heading: z.string().min(1),
          description: z.string().min(1),
        })
        .partial(),
    },
  ],

  instructor: [
    {
      id: "trainer-profiles",
      component: "TrainerProfilesFrame",
      importPath: `${importBase}/TrainerProfilesFrame`,
      description: "Trainer/instructor profile card grid. Only the section heading is campaign-fillable — real bios/photos stay curated defaults.",
      defaultData: {
        heading: "Meet Your Trainers",
      },
      fillableFields: z
        .object({
          heading: z.string().min(1),
        })
        .partial(),
    },
  ],

  "footer-cta": [
    {
      id: "cta-section",
      component: "CtaSectionFrame",
      importPath: `${importBase}/CtaSectionFrame`,
      description: "Centered text-only closing CTA on a solid background — fully campaign-fillable.",
      defaultData: {
        headings: "Take the First Step to Transform Your SOC!",
        contents:
          "Don't miss your chance to revolutionize your security operations with cutting-edge AI. Join our exclusive workshop and gain the skills, insights, and tools to stay ahead of cyber threats.",
        btnName: "Reserve Spot Now",
        btnDis: "Your next breakthrough in security is just a click away!",
      },
      fillableFields: z
        .object({
          headings: z.string().min(1),
          contents: z.string().min(1),
          btnName: z.string().min(1),
          btnDis: z.string().min(1),
        })
        .partial(),
    },
  ],
};

export function listFrameCandidates(sectionType) {
  return frameCatalog[sectionType] ?? [];
}

export function getFrameCandidate(sectionType, frameId) {
  return listFrameCandidates(sectionType).find((c) => c.id === frameId) ?? null;
}

/** Fail loud at import time if the catalog itself is malformed — same
 *  philosophy as design-catalog/reference-examples.mjs and config.mjs. */
function validateFrameCatalog() {
  if ("hero" in frameCatalog) {
    throw new Error("design-catalog/static-frame-catalog.mjs: 'hero' must never have a static candidate — hero is always ai-required.");
  }
  for (const [sectionType, candidates] of Object.entries(frameCatalog)) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`design-catalog/static-frame-catalog.mjs: "${sectionType}" must map to a non-empty array of candidates.`);
    }
    for (const candidate of candidates) {
      if (!candidate.id || !candidate.component || !candidate.importPath) {
        throw new Error(`design-catalog/static-frame-catalog.mjs: "${sectionType}" has a candidate missing id/component/importPath.`);
      }
      const hasData = candidate.defaultData !== undefined;
      const hasFillable = candidate.fillableFields !== undefined;
      if (hasData !== hasFillable) {
        throw new Error(
          `design-catalog/static-frame-catalog.mjs: "${sectionType}"/"${candidate.id}" must declare defaultData and fillableFields together, or neither.`
        );
      }
      if (hasFillable) {
        // mergeStrategy candidates (e.g. timeline's array-shaped data) validate
        // fillableFields against the single element it actually merges into,
        // not the outer array.
        const checkTarget = candidate.mergeStrategy ? candidate.defaultData[0] : candidate.defaultData;
        const parsed = candidate.fillableFields.safeParse(checkTarget);
        if (!parsed.success) {
          throw new Error(
            `design-catalog/static-frame-catalog.mjs: "${sectionType}"/"${candidate.id}"'s defaultData doesn't satisfy its own fillableFields schema: ${parsed.error.message}`
          );
        }
      }
    }
  }
}

validateFrameCatalog();
