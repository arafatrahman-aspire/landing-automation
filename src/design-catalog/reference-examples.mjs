import { validateCatalog } from "./section-types.mjs";

/* Human-curated section-type -> reference-file map (new_plan.md §4.3).
 *
 * *** EDIT THIS FILE after inspecting the REAL target repo. ***
 *
 * Each entry's `referenceFiles` are relative paths INSIDE the target repo
 * that the coding agent should treat as a concrete, real example of that
 * section type — never a blank page. `resolve.mjs` reads these files' actual
 * content out of the freshly cloned workdir; if a path doesn't exist in a
 * given target repo (e.g. this hasn't been curated for it yet, or the repo
 * changed), that entry is silently skipped rather than failing the run —
 * the guide/file_manifest stages just won't get a grounded example for that
 * section, which is a quality gap to fix here, not a crash.
 *
 * The paths below are PLACEHOLDERS (a plausible-but-unverified guess) — swap
 * them for real paths in whatever repo this service actually targets. Same
 * "human sets the boundary, not the AI" philosophy as WRITE_PATH_ALLOWLIST.
 */
export const catalog = {
  hero: {
    referenceFiles: ["components/Hero.tsx", "app/about/page.tsx"],
    note: "Above-the-fold block: title, video-or-details, lead form. See the hero contract in steps.mjs's code() prompt for the structural requirement.",
  },
  details: {
    referenceFiles: ["components/Details.tsx"],
    note: "A short 'what / when / who' or offer breakdown block.",
  },
  timeline: {
    referenceFiles: ["components/Timeline.tsx"],
    note: "Use when the offer has a schedule or deadline worth visualizing as steps/dates.",
  },
  testimonials: {
    referenceFiles: ["components/Testimonials.tsx"],
    note: "Social proof — quotes, logos, or ratings.",
  },
  faq: {
    referenceFiles: ["components/Faq.tsx"],
    note: "Accordion or list of question/answer pairs — pull questions from research.faqQuestions when available.",
  },
  curriculum: {
    referenceFiles: ["components/Curriculum.tsx"],
    note: "For course/training campaigns — a module/lesson breakdown. Skip for non-course campaigns.",
  },
  pricing: {
    referenceFiles: ["components/Pricing.tsx"],
    note: "Plan/tier comparison. Skip if the offer has a single flat price already stated in the hero.",
  },
  instructor: {
    referenceFiles: ["components/Instructor.tsx"],
    note: "Presenter/instructor bio and credibility signal. Course/training campaigns only.",
  },
  "footer-cta": {
    referenceFiles: ["components/Button.tsx"],
    note: "Closing call-to-action repeating the main CTA, typically full-width near the page bottom.",
  },
};

const result = validateCatalog(catalog);
if (!result.ok) {
  // eslint-disable-next-line no-console
  console.error(`Invalid design-catalog/reference-examples.mjs — fix its shape:\n${result.errors}`);
  process.exit(1);
}
