import { buildHeroContract, buildCtaLinkPromptFragment } from "./hero-contract.mjs";
import { buildContentRulesPromptFragment } from "../schemas/content-rules-prompt.mjs";

// System prompt for ONE section's coding-agent run — much narrower than a
// whole-page prompt would be, since this agent only ever writes one declared
// file (see sections/generate-sections.mjs for how each section gets its own
// independent run).
export function buildSectionAgentSystemPrompt(
  section,
  { request, guide: guideData, filePath, componentName, verifyReport = null, importExamples = "", previewLeadSinkUrl, typescriptFragment = "" }
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
CAMPAIGN CONTEXT:
Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
CTA: ${request.cta}
Video URL: ${request.videoUrl ?? "(none provided)"}
${contentRules ? `\n${contentRules}\n` : ""}
${guideData ? `Full content/section plan (for cross-section context only — you are ONLY building the "${section.type}" section): ${JSON.stringify(guideData)}` : ""}

IMPORT PATHS MUST BE COPIED FROM REAL USAGE, NEVER GUESSED FROM GENERAL KNOWLEDGE: before importing anything beyond a package's plain root export, find an EXISTING file in this repo that already imports from that same package and copy its exact import path verbatim. If nothing in the repo already imports it, avoid introducing it rather than guessing.

NEVER IMPORT A PROJECT-LOCAL FILE YOU HAVE NOT OPENED (a real past run failed on exactly this, importing "../../../components/Accordion", which did not exist). A relative or aliased import of another file in this repository is only allowed if you called read_file on that exact path in this session and it returned content. If you want a UI element — accordion, tabs, carousel, modal — and no real component for it exists here, build it INLINE inside your own single file. You are writing ONE self-contained file; it is always correct to implement what you need locally rather than to import something you hope exists.

WRITE THE COMPLETE FILE IN ONE write_file CALL, and make sure it parses: balanced braces and parentheses, every JSX tag closed, no placeholder ellipses, no truncation mid-expression. A file that doesn't parse fails the whole page's build, not just this section.
${typescriptFragment}
${importExamples}${verifyReport ? `\nA PREVIOUS ATTEMPT AT THIS PAGE FAILED VERIFICATION (build/lint/layout/SEO/accessibility) — the failure may or may not be caused by this specific section, but check whether it applies here and fix it if so:\n${verifyReport}\n` : ""}`;
}
