import { buildHeroContract, buildCtaLinkPromptFragment } from "./hero-contract.mjs";
import { buildContentRulesPromptFragment } from "../schemas/content-rules-prompt.mjs";
import { imageForSlot } from "../assets/campaign-images.mjs";

function buildCampaignImagesPromptFragment(images, sectionType, videoUrl) {
  const list = Array.isArray(images) ? images.filter((img) => img?.publicUrl) : [];
  const lines = [
    "CAMPAIGN IMAGES:",
    "Use these public URLs with next/image (src as a string). Do not invent other remote hosts. Do not import dummy frame assets (@assets/images/frames/...) when a URL was provided for this section.",
    "Do not assign stock photos of people or faces to testimonials or instructors — those sections must not use these URLs as headshots.",
  ];

  if (list.length === 0) {
    return "";
  }

  for (const img of list) {
    lines.push(
      `- slot "${img.slot}": ${img.publicUrl} (${img.width ?? "?"}x${img.height ?? "?"}) alt=${JSON.stringify(img.alt ?? "")}`
    );
  }

  const forThisSection = imageForSlot(list, sectionType);
  if (forThisSection) {
    lines.push(`This section ("${sectionType}") SHOULD use: ${forThisSection.publicUrl}`);
  } else if (sectionType === "hero" && videoUrl) {
    lines.push("This hero has a video URL — do not add a stock photo behind/instead of the video.");
  } else if (sectionType === "hero") {
    const hero = imageForSlot(list, "hero");
    if (hero) lines.push(`This hero has no video — use the hero image URL: ${hero.publicUrl}`);
  }

  lines.push(
    "",
    "NEXT/IMAGE SIZING RULES (a real past run broke the layout by ignoring these):",
    "NEVER use explicit width/height props with a remote URL — Pexels images have large intrinsic dimensions",
    "(e.g. 4912x3264) that overflow flex/grid containers when rendered at their natural size.",
    "Instead, ALWAYS use the `fill` prop and wrap the <Image> in a positioned parent div:",
    "  <div className=\"relative w-full aspect-video overflow-hidden rounded-xl\">",
    "    <Image src={url} alt={alt} fill className=\"object-cover\" />",
    "  </div>",
    "For a side-by-side layout column use `md:w-1/2` on the wrapper div.",
    "For a full-width hero banner use `w-full aspect-[21/9] md:aspect-[3/1]` so the image never overflows.",
    "Never set `height` or `style={{ height }}` on the <Image> element itself — let the container div control height."
  );

  return `${lines.join("\n")}\n`;
}

// System prompt for ONE section's coding-agent run — much narrower than a
// whole-page prompt would be, since this agent only ever writes one declared
// file (see sections/generate-sections.mjs for how each section gets its own
// independent run).
export function buildSectionAgentSystemPrompt(
  section,
  { request, guide: guideData, filePath, componentName, verifyReport = null, importExamples = "", previewLeadSinkUrl, typescriptFragment = "", images = [] }
) {
  // verifyReport/importExamples come from a PREVIOUS attempt's whole-page
  // verify failure (verify runs against the assembled page, not per-section,
  // so a failure can't always be pinned to one exact section) — handed to
  // every ai-required section on retry, not perfectly targeted to whichever
  // section actually caused it.

  // Tone/brand/must-include rules, without the structural ones: which sections
  // exist and how long the page is were settled by the guide stage, and this
  // agent can only write its own single file. Repeating decisions it cannot
  // act on invites it to argue with them in the copy.
  const contentRules = buildContentRulesPromptFragment(request, { includeStructure: false });
  const imageRules = buildCampaignImagesPromptFragment(images, section.type, request.videoUrl);
  const timelineImage = imageForSlot(images, "timeline");

  return `You are a coding agent implementing ONE section component of a marketing landing page inside an existing frontend repository, matching its existing design system and shared component library.

GUARDRAILS (enforced in code, not just instructions):
- You may create EXACTLY ONE file: ${filePath}
- You can NEVER modify or overwrite a file that already existed in this repository.
- You have no shell access. Explore with list_files/read_file, write with write_file, and call finish_coding when done.
- Export a default React component named ${componentName} from that file. It takes no required props (it may accept an optional \`data\` prop, but must render sensibly with none).

CLIENT-COMPONENT DIRECTIVE (a real past run failed the build on exactly this): if this repository is a Next.js project using the App Router — an \`app/\` directory, which is where your file is being written — then every component is a SERVER component by default, and server components may not use client-side React. If your component uses ANY of useState, useEffect, useRef, useReducer, useContext, or ANY event-handler prop (onClick, onChange, onSubmit, ...), then \`"use client";\` MUST be the VERY FIRST LINE of the file, above every import. A missing directive is a hard build failure, not a warning. Any form is interactive, so a section containing one always needs this line. Confirm the convention by reading an existing interactive component in this repo before you write.

Explore the repository first (package.json, an existing page or component, the styling approach) so this component matches its REAL conventions (framework, component patterns, import style, design tokens/colors, spacing).

SECTION TO BUILD: "${section.type}" — ${section.summary}
${section.type === "hero" ? `\n${buildHeroContract({ requiresJobField: Boolean(request.requiresJobField), previewLeadSinkUrl })}\n` : `\n${buildCtaLinkPromptFragment()}\n`}
${
    section.type === "timeline"
      ? timelineImage
        ? `TIMELINE: a campaign photo is assigned at ${timelineImage.publicUrl}. Implement the steps INLINE with next/image using that URL. Do not import ProcessExplainerFrame (it requires StaticImageData, not a remote string) and do not import dummy frame assets.\n`
        : `TIMELINE / ProcessExplainerFrame: if you reuse ProcessExplainerFrame, every item MUST include \`image: StaticImageData\` — import a stock asset such as \`@assets/images/frames/landing/frame-4-image-1.png\` and pass \`image: SideImage\`. A JSON-only \`{ title, description, processSteps }\` fails the TypeScript build with "Property 'image' is missing on ProcessExplainerItem". If you are not importing a real image, implement the steps inline instead of wrapping that frame.\n`
      : ""
  }
CAMPAIGN CONTEXT:
Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
CTA: ${request.cta}
Video URL: ${request.videoUrl ?? "(none provided)"}
${contentRules ? `\n${contentRules}\n` : ""}
${imageRules}
${guideData ? `Full content/section plan (for cross-section context only — you are ONLY building the "${section.type}" section): ${JSON.stringify(guideData)}` : ""}

IMPORT PATHS MUST BE COPIED FROM REAL USAGE, NEVER GUESSED FROM GENERAL KNOWLEDGE: before importing anything beyond a package's plain root export, find an EXISTING file in this repo that already imports from that same package and copy its exact import path verbatim. If nothing in the repo already imports it, avoid introducing it rather than guessing.

NEVER IMPORT A PROJECT-LOCAL FILE YOU HAVE NOT OPENED (a real past run failed on exactly this, importing "../../../components/Accordion", which did not exist). A relative or aliased import of another file in this repository is only allowed if you called read_file on that exact path in this session and it returned content. If you want a UI element — accordion, tabs, carousel, modal — and no real component for it exists here, build it INLINE inside your own single file. You are writing ONE self-contained file; it is always correct to implement what you need locally rather than to import something you hope exists.

WRITE THE COMPLETE FILE IN ONE write_file CALL, and make sure it parses: balanced braces and parentheses, every JSX tag closed, no placeholder ellipses, no truncation mid-expression. A file that doesn't parse fails the whole page's build, not just this section.

ACCESSIBILITY (WCAG 2A/2AA — checked automatically with axe-core; a violation fails verification):
- Every icon-only \`<button>\` or \`<a>\` (no visible text, e.g. a close/hamburger/social icon) MUST have \`aria-label="..."\` describing its action. Never ship a clickable element whose only content is an SVG/icon with no accessible name.
- Every \`<input>\`, \`<select>\`, and \`<textarea>\` MUST have an associated label: either wrap it in a \`<label>\`, or give the input an \`id\` and the label a matching \`htmlFor\`, or add \`aria-label\` if no visible label fits the design.
- Every \`<a>\` MUST have discernible text — never an empty link or one whose only content is a generic icon with no \`aria-label\`.
- Body text and interactive elements need sufficient color contrast against their background (WCAG AA: 4.5:1 for normal text, 3:1 for large text/UI components). Do not put light-gray or low-opacity text on a light/white background, or a light color on a light accent background — use the repo's existing dark text tokens for body copy.
- HEADINGS ON A DARK/COLORED BACKGROUND (this has caused a real contrast failure — read carefully): this repo's globals.css sets \`h1\`–\`h6 { color: ... }\` (a fixed dark navy) in \`@layer base\`. A directly-targeted rule on an element ALWAYS wins over a color the element would otherwise inherit from a parent — this is true regardless of Tailwind's layer order, because layer order only decides between rules that target the SAME element, and inheritance isn't a rule targeting the element at all. So putting \`text-white\` (or any color) on a wrapping \`<div>\`/\`<section>\`/\`<button>\` does NOTHING for an \`<h1>\`–\`<h6>\` inside it — the heading still renders in the site's fixed dark navy, and if that div/section/button has a dark or colored background, the heading becomes low-contrast or unreadable. Whenever a heading tag sits on anything other than a plain white/light background, put the color utility (e.g. \`text-white\`) DIRECTLY on the heading tag itself, never only on an ancestor. This applies to \`<h1>\` through \`<h6>\` specifically — plain \`<p>\`/\`<span>\`/\`<div>\` text does inherit normally and isn't affected.
- If you use \`var(--campaign-accent)\` (or primary/secondary) as a background with text on top, the text needs \`font-bold\` AND at least \`text-xl\` (20px) to reliably clear the WCAG large-text 3:1 threshold — \`text-lg\` (18px), even bold, is NOT large enough and will fail at the stricter 4.5:1 normal-text threshold with this brand's accent color.

TYPE THE DEFAULTS YOU FALL BACK TO: \`const items = data?.items || defaults\` infers \`items\` from \`defaults\`. If the JSX later reads a field (e.g. \`item.icon\`), annotate \`defaults\` with the same interface — including optional fields. A real build failed with \`Property 'icon' does not exist on type '{ text: string; }'\` because defaults were unannotated objects with only \`text\`.
${typescriptFragment}
${importExamples}${verifyReport ? `\nA PREVIOUS ATTEMPT AT THIS PAGE FAILED VERIFICATION (build/lint/layout/SEO/accessibility) — the failure may or may not be caused by this specific section, but check whether it applies here and fix it if so:\n${verifyReport}\n` : ""}`;
}
