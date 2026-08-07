import { getFrameCandidate } from "../design-catalog/static-frame-catalog.mjs";
import { populateFrame } from "./fill-static-frame.mjs";
import { runCodingAgent } from "../llm/coding-agent.mjs";
import { sectionComponentName, sectionFilePath, sectionSlotId, composePage } from "./compose-page.mjs";
import { buildSectionAgentSystemPrompt } from "./section-agent-prompt.mjs";
import { writeGuardedFile } from "./write-guarded-file.mjs";

// The fan-out dispatcher for Hybrid Section Assembly (new_plan.md §9.5/§9.6).
// Every classified section (sections/classify-sections.mjs) is generated
// independently: static sections via pure templating (fill-static-frame.mjs,
// no LLM), ai-required sections via their OWN scoped coding-agent run — all
// concurrently — then composed into one page file (compose-page.mjs).

// Pure: builds the file content for one STATIC section. Throws if the
// classified section has no matching catalog candidate — classify-sections.mjs
// only ever sets mode:"static" when one exists, so this indicates a caller
// bug, not a runtime/data condition to handle gracefully.
export function buildStaticSectionFile(section, { allowlistBase, index }) {
  const candidate = getFrameCandidate(section.type, section.frameId);
  if (!candidate) {
    throw new Error(`buildStaticSectionFile: no candidate "${section.frameId}" for section type "${section.type}"`);
  }
  const componentName = sectionComponentName(section.type, index);
  const { fileContent } = populateFrame({ candidate, componentName });
  return { path: sectionFilePath(allowlistBase, componentName), content: fileContent, componentName };
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
}) {
  const allowlistBase = allowlist[0];

  // A targeted repair only happens when the failure named specific files of
  // ours AND we still have last attempt's results to carry forward for the
  // sections we're leaving alone. Otherwise fall back to regenerating
  // everything, which is the only safe option when the blame is unclear.
  const isTargetedRepair = Boolean(retryFailedPaths?.size) && Boolean(previousSectionResults?.length);

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
        const built = buildStaticSectionFile(section, { allowlistBase, index });
        const relPath = await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles, relPath: built.path, content: built.content });
        logger(`generate_sections: [${section.type}] static — wrote ${relPath}`);
        return { type: section.type, mode: "static", path: relPath, componentName: built.componentName, slot, frameId: section.frameId, finished: true };
      }

      const systemPrompt = buildSectionAgentSystemPrompt(section, {
        request,
        guide: guideData,
        filePath,
        componentName,
        verifyReport,
        importExamples,
        previewLeadSinkUrl,
        typescriptFragment,
      });

      // Repairing beats rewriting: the previous attempt is still on disk and
      // is usually one small mistake away from correct (a real run failed on a
      // `toggleFqa`/`toggleFaq` typo). Telling the agent to start over throws
      // away a nearly-good file and re-rolls every other decision in it.
      const isRepair = isTargetedRepair && retryFailedPaths.has(filePath);
      const taskPrompt = isRepair
        ? `Your previous attempt at ${componentName} is ALREADY WRITTEN at ${filePath}, and the build FAILED on it with the error shown above.\n\nFirst call read_file on ${filePath} to see exactly what you wrote. Then fix the specific reported error — most build failures here are a single typo, a mismatched name, or one bad import, so change as little as possible and keep everything that already works. Write the corrected COMPLETE file back to ${filePath}, then call finish_coding.`
        : `Explore the repository, then implement ${componentName} at ${filePath}. Call finish_coding when done.`;
      if (isRepair) logger(`generate_sections: [${section.type}] repairing ${filePath} (the build blamed this file)`);

      const agentResult = await runCodingAgent({
        workdir,
        allowedPrefixes: allowlist,
        pristineFiles,
        manifestPaths: new Set([filePath]),
        systemPrompt,
        taskPrompt,
        maxIterations,
        logger: (msg) => logger(`generate_sections: [${section.type}] ${msg}`),
      });

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
