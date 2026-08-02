import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { getFrameCandidate } from "../design/frame-catalog.mjs";
import { populateFrame } from "./populate-frame.mjs";
import { resolveWritePath } from "../ai/tools.mjs";
import { runCodingAgent } from "../ai/coding-agent.mjs";
import { buildLeadFormPromptFragment } from "../leadform/contract.mjs";

/* Fan-out section generation (new_plan.md §9.5/§9.6 — Hybrid Section
 * Assembly, module.md Module 2). Replaces the old single whole-page `code`
 * node's job: every classified section (sections/classify.mjs) is generated
 * independently — static sections via pure templating (populate-frame.mjs,
 * no LLM), ai-required sections via their OWN scoped coding-agent run — all
 * concurrently, then composed into one page file.
 *
 * NOT YET wired into orchestrator/graph.mjs or steps.mjs — see module.md
 * Module 2's note. Retiring the old `file_manifest` node (this module's
 * deterministic per-section paths replace what it used to guess) touches
 * config.mjs, ai/text.mjs, state/schema.mjs, the UI, and dev/run-agent-
 * standalone.mjs — a separate, larger-blast-radius change than this
 * dispatcher itself, left for the next module rather than bundled in here.
 *
 * The pure helpers below (path/name conventions, static file generation,
 * per-section prompt text, page composition) are fully unit-tested. The
 * dispatcher (`generateSections`) that actually calls the coding agent is
 * not — this codebase never mocks the LLM (see write-tool-allowlist.test.mjs's
 * convention); AI-touching code is verified live, same as the old `code()`. */

const PASCAL_WORD_RE = /[^a-z0-9]+/i;

function toPascalCase(...parts) {
  return parts
    .join("-")
    .split(PASCAL_WORD_RE)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

/** Deterministic, human-readable component name per section — includes the
 *  index so two sections of the same type (unusual, but not schema-forbidden)
 *  never collide. */
export function sectionComponentName(sectionType, index) {
  return `${toPascalCase(sectionType)}Section${index}`;
}

export function sectionFilePath(allowlistBase, componentName) {
  return `${allowlistBase}sections/${componentName}.tsx`;
}

export function pageFilePath(allowlistBase) {
  return `${allowlistBase}page.tsx`;
}

/** Stable per-position slot id (new_plan.md §9.6/module.md Module 3) — the
 *  identity `draft_files.section_slot` is keyed on. Positional, not
 *  type-derived, so a future refine that swaps a slot's section TYPE
 *  (Module 4's "new" action) doesn't orphan its own version history. */
export function sectionSlotId(index) {
  return `section-${index}`;
}

/**
 * Pure: builds the file content for one STATIC section. Throws if the
 * classified section has no matching catalog candidate — classify.mjs only
 * ever sets mode:"static" when one exists, so this indicates a caller bug,
 * not a runtime/data condition to handle gracefully.
 */
export function buildStaticSectionFile(section, { allowlistBase, index }) {
  const candidate = getFrameCandidate(section.type, section.frameId);
  if (!candidate) {
    throw new Error(`buildStaticSectionFile: no candidate "${section.frameId}" for section type "${section.type}"`);
  }
  const componentName = sectionComponentName(section.type, index);
  const { fileContent } = populateFrame({ candidate, componentName });
  return { path: sectionFilePath(allowlistBase, componentName), content: fileContent, componentName };
}

/** Pure: hero contract text, including the lead-form field/honeypot/
 *  submission contract (leadform/contract.mjs, Phase 8) — the hero is the
 *  one section that's always ai-required, so this is the only place that
 *  contract needs threading into a prompt. */
function buildHeroContract({ requiresJobField, previewLeadSinkUrl }) {
  return `HERO REQUIREMENT (above the fold, no scrolling, at BOTH desktop and mobile widths): one block containing the shortened campaign title, a video-or-details block, and the lead-capture form. Video-or-details and the form sit side by side on desktop, stacked vertically on mobile. Use responsive sizing (e.g. CSS clamp() or the repo's existing type scale) so the title shrinks gracefully rather than overflowing. Mark these three elements with these EXACT attributes (an automated check looks for them to verify placement — plain HTML attributes, not classes): \`data-hero-title\` on the title element, \`data-hero-media\` on the video-or-details block, \`data-hero-form\` on the lead form. These attributes are invisible to visitors and don't affect styling.

${buildLeadFormPromptFragment({ requiresJobField, previewLeadSinkUrl })}`;
}

/** Pure: system prompt for ONE section's coding-agent run — much narrower
 *  than the old whole-page prompt, since this agent only ever writes one
 *  declared file. `verifyReport`/`importExamples` come from a PREVIOUS
 *  attempt's whole-page verify failure (verify runs against the assembled
 *  page, not per-section, so a failure can't always be pinned to one exact
 *  section) — handed to every ai-required section on retry, same spirit as
 *  the old code()'s single-loop retry feedback, just not perfectly targeted
 *  to whichever section actually caused it. */
export function buildSectionAgentSystemPrompt(
  section,
  { request, guide: guideData, filePath, componentName, verifyReport = null, importExamples = "", previewLeadSinkUrl }
) {
  return `You are a coding agent implementing ONE section component of a marketing landing page inside an existing frontend repository, matching its existing design system and shared component library.

GUARDRAILS (enforced in code, not just instructions):
- You may create EXACTLY ONE file: ${filePath}
- You can NEVER modify or overwrite a file that already existed in this repository.
- You have no shell access. Explore with list_files/read_file, write with write_file, and call finish_coding when done.
- Export a default React component named ${componentName} from that file. It takes no required props (it may accept an optional \`data\` prop, but must render sensibly with none).

Explore the repository first (package.json, an existing page or component, the styling approach) so this component matches its REAL conventions (framework, component patterns, import style, design tokens/colors, spacing).

SECTION TO BUILD: "${section.type}" — ${section.summary}
${section.type === "hero" ? `\n${buildHeroContract({ requiresJobField: Boolean(request.requiresJobField), previewLeadSinkUrl })}\n` : ""}
CAMPAIGN CONTEXT:
Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
CTA: ${request.cta}
Video URL: ${request.videoUrl ?? "(none provided)"}
${guideData ? `Full content/section plan (for cross-section context only — you are ONLY building the "${section.type}" section): ${JSON.stringify(guideData)}` : ""}

IMPORT PATHS MUST BE COPIED FROM REAL USAGE, NEVER GUESSED FROM GENERAL KNOWLEDGE: before importing anything beyond a package's plain root export, find an EXISTING file in this repo that already imports from that same package and copy its exact import path verbatim. If nothing in the repo already imports it, avoid introducing it rather than guessing.
${importExamples}${verifyReport ? `\nA PREVIOUS ATTEMPT AT THIS PAGE FAILED VERIFICATION (build/lint/layout/SEO/accessibility) — the failure may or may not be caused by this specific section, but check whether it applies here and fix it if so:\n${verifyReport}\n` : ""}`;
}

/** Deterministic composition of the classified sections into one page file
 *  — never agent-written, so it's always exactly consistent with what was
 *  actually generated. */
export function composePage(orderedSections, { allowlistBase }) {
  const imports = orderedSections
    .map((s) => `import ${s.componentName} from "./sections/${s.componentName}";`)
    .join("\n");
  const renders = orderedSections.map((s) => `      <${s.componentName} />`).join("\n");
  const content = `${imports}

export default function Page() {
  return (
    <>
${renders}
    </>
  );
}
`;
  return { path: pageFilePath(allowlistBase), content };
}

/**
 * Writes one pre-built file through the same write guard the coding agent's
 * write_file tool uses (resolveWritePath) — static/composed files aren't
 * agent-written, but still go through the identical containment/pristine/
 * allowlist checks for consistency, not just convenience.
 */
export async function writeGuardedFile({ workdir, allowedPrefixes, pristineFiles, relPath, content }) {
  const check = resolveWritePath({ requestedPath: relPath, workdir, allowedPrefixes, pristineFiles, writtenByAgent: new Set(), manifestPaths: null });
  if (!check.ok) {
    throw new Error(`generate-sections: refusing to write "${relPath}" — ${check.message}`);
  }
  await mkdir(path.dirname(check.absolutePath), { recursive: true });
  await writeFile(check.absolutePath, content);
  return check.relativePath;
}

/**
 * The dispatcher. Static sections are written directly (no LLM); each
 * ai-required section gets its own independent runCodingAgent() call,
 * scoped to exactly one file — all sections run concurrently via
 * Promise.all. Returns a shape compatible with the old `code()` node's
 * contract (writtenByAgent/codeFinished/agentSummary) so verify()/
 * stageDraft() need no changes to keep working once this is wired in.
 *
 * @param {object} p
 * @param {Array} p.classifiedSections - sections/classify.mjs output
 * @param {string} p.workdir
 * @param {string[]} p.allowlist
 * @param {Set<string>} p.pristineFiles
 * @param {object} p.request - validated campaign brief
 * @param {object} p.guide - full guide output (context for AI sections)
 * @param {(msg: string) => void} [p.logger]
 * @param {number} [p.maxIterations]
 * @param {string|null} [p.verifyReport] - previous attempt's whole-page verify failure, if this is a retry
 * @param {string} [p.importExamples] - findExistingImportExamples() output, if this is a retry
 * @param {string} p.previewLeadSinkUrl - absolute URL the hero's lead form should POST to in preview (leadform/contract.mjs)
 */
export async function generateSections({
  classifiedSections,
  workdir,
  allowlist,
  pristineFiles,
  request,
  guide: guideData,
  logger = () => {},
  maxIterations,
  verifyReport = null,
  importExamples = "",
  previewLeadSinkUrl,
}) {
  const allowlistBase = allowlist[0];

  const results = await Promise.all(
    classifiedSections.map(async (section, index) => {
      if (section.mode === "static") {
        const built = buildStaticSectionFile(section, { allowlistBase, index });
        const relPath = await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles, relPath: built.path, content: built.content });
        logger(`generate_sections: [${section.type}] static — wrote ${relPath}`);
        return { type: section.type, mode: "static", path: relPath, componentName: built.componentName, slot: sectionSlotId(index), frameId: section.frameId, finished: true };
      }

      const componentName = sectionComponentName(section.type, index);
      const filePath = sectionFilePath(allowlistBase, componentName);
      const systemPrompt = buildSectionAgentSystemPrompt(section, {
        request,
        guide: guideData,
        filePath,
        componentName,
        verifyReport,
        importExamples,
        previewLeadSinkUrl,
      });

      const agentResult = await runCodingAgent({
        workdir,
        allowedPrefixes: allowlist,
        pristineFiles,
        manifestPaths: new Set([filePath]),
        systemPrompt,
        taskPrompt: `Explore the repository, then implement ${componentName} at ${filePath}. Call finish_coding when done.`,
        maxIterations,
        logger: (msg) => logger(`generate_sections: [${section.type}] ${msg}`),
      });

      return {
        type: section.type,
        mode: "ai-required",
        path: filePath,
        componentName,
        slot: sectionSlotId(index),
        finished: agentResult.finished,
        summary: agentResult.summary,
        iterations: agentResult.iterations,
      };
    })
  );

  const orderedForPage = results.map((r) => ({ componentName: r.componentName }));
  const pageFile = composePage(orderedForPage, { allowlistBase });
  const pagePath = await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles, relPath: pageFile.path, content: pageFile.content });
  logger(`generate_sections: composed ${pagePath} from ${results.length} section(s)`);

  const writtenFiles = new Set([...results.map((r) => r.path), pagePath]);
  const allFinished = results.every((r) => r.finished);
  const agentSummary = results
    .filter((r) => r.mode === "ai-required")
    .map((r) => `${r.type}: ${r.summary ?? "(unfinished)"}`)
    .join("\n");

  return { sectionResults: results, writtenByAgent: writtenFiles, codeFinished: allFinished, agentSummary };
}
