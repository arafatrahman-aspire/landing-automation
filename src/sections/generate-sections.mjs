import path from "node:path";
import { readFile } from "node:fs/promises";
import { getFrameCandidate } from "../design-catalog/static-frame-catalog.mjs";
import { populateFrame } from "./fill-static-frame.mjs";
import { generateStaticSectionContent, staticOverridesAreUsable } from "./generate-static-content.mjs";
import { runCodingAgent } from "../llm/coding-agent.mjs";
import { sectionComponentName, sectionFilePath, sectionSlotId, composePage } from "./compose-page.mjs";
import { buildSectionAgentSystemPrompt } from "./section-agent-prompt.mjs";
import { writeGuardedFile } from "./write-guarded-file.mjs";
import { precheckSectionFile } from "../verify/precheck-section-file.mjs";

// The fan-out dispatcher for Hybrid Section Assembly (new_plan.md §9.5/§9.6).
// Every classified section (sections/classify-sections.mjs) is generated
// independently: static sections via pure templating (fill-static-frame.mjs,
// no LLM), ai-required sections via their OWN scoped coding-agent run — all
// concurrently — then composed into one page file (compose-page.mjs).

// Pure: builds the file content for one STATIC section. Throws if the
// classified section has no matching catalog candidate — classify-sections.mjs
// only ever sets mode:"static" when one exists, so this indicates a caller
// bug, not a runtime/data condition to handle gracefully.
export function buildStaticSectionFile(section, { allowlistBase, index, overrides = {}, images = [], colorScheme }) {
  const candidate = getFrameCandidate(section.type, section.frameId);
  if (!candidate) {
    throw new Error(`buildStaticSectionFile: no candidate "${section.frameId}" for section type "${section.type}"`);
  }
  const componentName = sectionComponentName(section.type, index);
  const { fileContent, dataUsed } = populateFrame({ candidate, overrides, componentName, images, colorScheme });
  // dataUsed comes back so the caller can record what this section actually
  // renders. That record is what the copy editor (sections/describe-fillable-fields.mjs
  // + refine's "edit-copy") starts from — without it, editing a section would
  // have to reset to the frame's stock defaults and silently discard any
  // earlier edit.
  return { path: sectionFilePath(allowlistBase, componentName), content: fileContent, componentName, dataUsed };
}

/**
 * The dispatcher. Static sections are written directly (no LLM); each
 * ai-required section gets its own independent runCodingAgent() call,
 * scoped to exactly one file — all sections run concurrently via
 * Promise.all. Returns writtenByAgent/codeFinished/agentSummary, the shape
 * pipeline/steps/07-verify.mjs and pipeline/steps/08-stage-draft.mjs expect.
 *
 * @param {object} p
 * @param {Array} p.classifiedSections - sections/classify-sections.mjs output
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
 * @param {Set<string>|null} [p.retryFailedPaths] - on a retry, the only files the last failure blamed (verify/failing-files.mjs)
 * @param {Array|null} [p.previousSectionResults] - last attempt's results, reused verbatim for sections not being repaired
 * @param {string} [p.typescriptFragment] - target-repo type-strictness rules (steps/detect-typescript-strictness.mjs)
 * @param {boolean} [p.authorStaticContent] - when true, each static section's copy is
 *   AI-generated per campaign (generate-static-content.mjs) instead of the frame's
 *   own canned defaultData. Defaults to false so callers that don't opt in (and
 *   every existing test) see the old, network-free behavior unchanged.
 * @param {Array} [p.images] - researchNotes.images public URLs to inject into frames/prompts
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
  retryFailedPaths = null,
  previousSectionResults = null,
  typescriptFragment = "",
  strictTypes = false,
  declaredPackages = null,
  precheckAttempts = 2,
  authorStaticContent = false,
  images = [],
}) {
  const allowlistBase = allowlist[0];
  const campaignImages = Array.isArray(images) ? images : [];
  const colorScheme = request?.colorScheme;

  // A targeted repair only happens when the failure named specific files of
  // ours AND we still have last attempt's results to carry forward for the
  // sections we're leaving alone. Otherwise fall back to regenerating
  // everything, which is the only safe option when the blame is unclear.
  const isTargetedRepair = Boolean(retryFailedPaths?.size) && Boolean(previousSectionResults?.length);

  async function generateAiRequiredSection(section, index, { asFallbackFromStatic = false } = {}) {
    const slot = sectionSlotId(index);
    const componentName = sectionComponentName(section.type, index);
    const filePath = sectionFilePath(allowlistBase, componentName);

    const systemPrompt = buildSectionAgentSystemPrompt(
      { ...section, mode: "ai-required", frameId: null },
      {
        request,
        guide: guideData,
        filePath,
        componentName,
        verifyReport,
        importExamples,
        previewLeadSinkUrl,
        typescriptFragment,
        images: campaignImages,
      }
    );

    const isRepair = isTargetedRepair && retryFailedPaths.has(filePath);
    const taskPrompt = isRepair
      ? `Your previous attempt at ${componentName} is ALREADY WRITTEN at ${filePath}, and the build FAILED on it with the error shown above.\n\nFirst call read_file on ${filePath} to see exactly what you wrote. Then fix the specific reported error — most build failures here are a single typo, a mismatched name, or one bad import, so change as little as possible and keep everything that already works. Write the corrected COMPLETE file back to ${filePath}, then call finish_coding.`
      : asFallbackFromStatic
        ? `The reusable layout for this "${section.type}" section cannot be filled with campaign-specific copy (either content generation failed, or the layout hardcodes another campaign's body). Implement ${componentName} at ${filePath} from scratch for THIS campaign — do not import a frame that ships cybersecurity / Aspire Tech training defaults. Call finish_coding when done.`
        : `Explore the repository, then implement ${componentName} at ${filePath}. Call finish_coding when done.`;
    if (isRepair) logger(`generate_sections: [${section.type}] repairing ${filePath} (the build blamed this file)`);
    if (asFallbackFromStatic) logger(`generate_sections: [${section.type}] falling back to ai-required — refusing to ship the layout's canned defaults`);

    const runAgent = (task) =>
      runCodingAgent({
        workdir,
        allowedPrefixes: allowlist,
        pristineFiles,
        manifestPaths: new Set([filePath]),
        systemPrompt,
        taskPrompt: task,
        maxIterations,
        logger: (msg) => logger(`generate_sections: [${section.type}] ${msg}`),
      });

    let agentResult = await runAgent(taskPrompt);

    /* Fast local gate before this file is ever composed into the page or
     * handed to the build. A real run burned three full ~60s npm-ci-plus-
     * Next-build cycles discovering a bad import, an untyped prop and a
     * stray quote — all detectable here in milliseconds. Repairing in this
     * inner loop keeps the expensive outer verify for integration problems
     * that genuinely need a build. */
    for (let attempt = 1; attempt <= precheckAttempts; attempt++) {
      const written = await readFile(path.join(workdir, filePath), "utf8").catch(() => null);
      if (written === null) break; // agent wrote nothing; the finish check below handles it

      const precheck = await precheckSectionFile({ content: written, filePath, workdir, strictTypes, declaredPackages });
      if (precheck.ok) break;

      logger(`generate_sections: [${section.type}] precheck found ${precheck.problems.length} problem(s) in ${filePath}, repairing locally (attempt ${attempt}/${precheckAttempts}) — ${precheck.problems[0].message}`);
      agentResult = await runAgent(
        `The file you just wrote at ${filePath} has problems that WILL fail the build. They were found by a fast local check, so fix them now rather than waiting for a full build:\n\n${precheck.report}\n\nCall read_file on ${filePath}, make the smallest change that fixes every problem listed above, write the corrected COMPLETE file back, then call finish_coding.`
      );
    }

    return {
      type: section.type,
      mode: "ai-required",
      path: filePath,
      componentName,
      slot,
      finished: agentResult.finished,
      summary: agentResult.summary,
      iterations: agentResult.iterations,
    };
  }

  const results = await Promise.all(
    classifiedSections.map(async (section, index) => {
      const slot = sectionSlotId(index);
      const componentName = sectionComponentName(section.type, index);
      const filePath = sectionFilePath(allowlistBase, componentName);

      // Untouched by this failure -> keep exactly what compiled last time.
      // Rewriting a section that already worked is how a retry turns one
      // broken file into a different broken file.
      if (isTargetedRepair && !retryFailedPaths.has(filePath)) {
        const previous = previousSectionResults.find((r) => r.slot === slot);
        if (previous) {
          logger(`generate_sections: [${section.type}] unchanged — not implicated in the build failure, keeping the previous attempt`);
          return previous;
        }
      }

      if (section.mode === "static") {
        const candidate = getFrameCandidate(section.type, section.frameId);
        const overrides = authorStaticContent
          ? await generateStaticSectionContent({
              candidate,
              section,
              request,
              guide: guideData,
              images: campaignImages,
              logger: (msg) => logger(`generate_sections: [${section.type}] ${msg}`),
            })
          : {};

        // With authorStaticContent on, empty/incomplete overrides would ship the
        // frame's canned cybersecurity defaults — the exact photography-course
        // bug. Fall back to a coding-agent section instead.
        if (authorStaticContent && !staticOverridesAreUsable(candidate, overrides)) {
          return generateAiRequiredSection(section, index, { asFallbackFromStatic: true });
        }

        const built = buildStaticSectionFile(section, { allowlistBase, index, overrides, images: campaignImages, colorScheme });
        const relPath = await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles, relPath: built.path, content: built.content });
        logger(`generate_sections: [${section.type}] static — wrote ${relPath}`);
        return {
          type: section.type,
          mode: "static",
          path: relPath,
          componentName: built.componentName,
          slot,
          frameId: section.frameId,
          data: built.dataUsed,
          finished: true,
        };
      }

      return generateAiRequiredSection(section, index);
    })
  );

  const orderedForPage = results.map((r) => ({ componentName: r.componentName }));
  const pageFile = composePage(orderedForPage, { allowlistBase, colorScheme, request });
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
