import path from "node:path";
import { readFile } from "node:fs/promises";
import { config, resolveAllowlist } from "../config.mjs";
import * as runStore from "../state/campaign-repository.mjs";
import * as draftStore from "../staging/draft-versions.mjs";
import * as preview from "../preview/preview-server.mjs";
import { runFullVerifySuite } from "../verify/run-full-verify-suite.mjs";
import { runCodingAgent } from "../llm/coding-agent.mjs";
import { getFrameCandidate, listFrameCandidates } from "../design-catalog/static-frame-catalog.mjs";
import { populateFrame } from "../sections/fill-static-frame.mjs";
import { resolveSectionMode } from "../sections/classify-sections.mjs";
import { sectionComponentName, sectionFilePath, composePage } from "../sections/compose-page.mjs";
import { buildSectionAgentSystemPrompt } from "../sections/section-agent-prompt.mjs";
import { writeGuardedFile } from "../sections/write-guarded-file.mjs";
import { PREVIEW_LEAD_SINK_PATH } from "../leadform/contract.mjs";
import { detectTypeScriptStrictness, buildTypeScriptPromptFragment } from "./steps/detect-typescript-strictness.mjs";

/* Per-section refinement (new_plan.md §9.7, module.md Module 4) — THIS is
 * the review step, not a separate approve/edit/reject workflow. Every
 * action here writes a NEW draft version for the refined slot only, never
 * touching the original frame file or any other section's rows, then
 * re-runs the FULL-PAGE verify suite (a section swap can affect page-wide
 * checks like hero-fit/SEO/a11y) before refreshing the live preview.
 *
 * Nothing here is destructive on failure: verify runs against files
 * already written to the live scratch worktree, but `draft_files` (not the
 * worktree) is what commit() actually reads from — a failed refine leaves
 * bad content sitting in the worktree, harmless, never staged, never
 * committed. The next successful refine (or approval) simply overwrites it. */

export const REFINE_ACTIONS = ["use-different-frame", "modify", "redesign", "new"];

export class RefineActionError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason; // "not_found" | "wrong_status" | "invalid_action" | "verify_failed"
  }
}

/** GET /campaigns/:runId/sections — the gallery's data source: every slot's
 *  current type/mode/frame, plus which other static candidates exist for
 *  that section type (for the "use a different frame" action). */
export async function listSections(runId) {
  const run = await runStore.getRun(runId);
  if (!run) throw new RefineActionError("not_found", `no such run "${runId}"`);
  const sections = run.sectionResults ?? [];
  return sections.map((s) => ({
    ...s,
    candidates: listFrameCandidates(s.type).map((c) => ({ id: c.id, description: c.description })),
  }));
}

function previewLeadSinkUrl() {
  return `${config.servicePublicBaseUrl}${PREVIEW_LEAD_SINK_PATH}`;
}

/** Shared by "redesign", "modify", and "new" (when the new type resolves
 *  to ai-required) — one independent coding-agent run scoped to exactly
 *  one file, same shape as generate-sections.mjs's original fan-out, plus
 *  optional human instructions layered on top. */
async function runSectionAgent({ runId, run, workdir, allowlist, sectionType, summary, filePath, componentName, instructions }) {
  const typescriptFragment = buildTypeScriptPromptFragment(await detectTypeScriptStrictness(workdir));
  const systemPrompt =
    buildSectionAgentSystemPrompt(
      { type: sectionType, summary },
      { request: run.request, guide: run.guide, filePath, componentName, previewLeadSinkUrl: previewLeadSinkUrl(), typescriptFragment }
    ) + (instructions ? `\n\nHUMAN REFINEMENT INSTRUCTIONS — apply these on top of everything above, this is a direct request from the reviewer:\n${instructions}` : "");

  const result = await runCodingAgent({
    workdir,
    allowedPrefixes: allowlist,
    pristineFiles: new Set(), // every generated path postdates clone() — never pristine, regardless of which request writes it
    manifestPaths: new Set([filePath]),
    systemPrompt,
    taskPrompt: `Update ${componentName} at ${filePath} per the instructions above. Call finish_coding when done.`,
    maxIterations: config.maxAgentIterations,
    logger: (msg) => runStore.appendLog(runId, "info", `refine: ${msg}`),
  });
  if (!result.finished) {
    throw new Error(`refine: coding agent hit max iterations without finish_coding for "${filePath}"`);
  }
}

/**
 * @param {string} runId
 * @param {string} slot - e.g. "section-0"
 * @param {"use-different-frame"|"modify"|"redesign"|"new"} action
 * @param {object} [params] - {frameId} for use-different-frame, {instructions} for modify/redesign, {sectionType, instructions?} for new
 */
export async function refineSection(runId, slot, action, params = {}) {
  if (!REFINE_ACTIONS.includes(action)) {
    throw new RefineActionError("invalid_action", `unknown action "${action}" — must be one of: ${REFINE_ACTIONS.join(", ")}`);
  }

  const run = await runStore.getRun(runId);
  if (!run) throw new RefineActionError("not_found", `no such run "${runId}"`);
  if (run.status !== "staged_for_review") {
    throw new RefineActionError("wrong_status", `cannot refine run "${runId}" — status is "${run.status}", not "staged_for_review"`);
  }

  const sections = run.sectionResults ?? [];
  const index = sections.findIndex((s) => s.slot === slot);
  if (index === -1) throw new RefineActionError("not_found", `no such slot "${slot}" on run "${runId}"`);
  const current = sections[index];

  const allowlist = resolveAllowlist(config.writePathAllowlistTemplates, run.slug);
  const allowlistBase = allowlist[0];
  const workdir = run.workdir;

  let updated;

  if (action === "use-different-frame") {
    if (current.mode !== "static") {
      throw new RefineActionError("invalid_action", `slot "${slot}" is ai-required, not static — use "redesign" instead`);
    }
    const candidate = getFrameCandidate(current.type, params.frameId);
    if (!candidate) {
      throw new RefineActionError("invalid_action", `"${params.frameId}" is not a valid static candidate for section type "${current.type}"`);
    }
    const { fileContent } = populateFrame({ candidate, componentName: current.componentName });
    await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles: new Set(), relPath: current.path, content: fileContent });
    updated = { ...current, frameId: candidate.id };
  } else if (action === "modify" || action === "redesign") {
    if (action === "modify" && current.mode !== "ai-required") {
      throw new RefineActionError("invalid_action", `slot "${slot}" is static — use "use-different-frame" or "redesign" instead`);
    }
    await runSectionAgent({
      runId,
      run,
      workdir,
      allowlist,
      sectionType: current.type,
      summary: params.instructions ? `${current.type} section — ${params.instructions}` : `${current.type} section`,
      filePath: current.path,
      componentName: current.componentName,
      instructions: params.instructions,
    });
    updated = { type: current.type, mode: "ai-required", path: current.path, componentName: current.componentName, slot, finished: true };
  } else {
    // action === "new" — a different section TYPE for this slot.
    const newType = params.sectionType;
    if (!newType) throw new RefineActionError("invalid_action", `"new" requires a "sectionType"`);
    const positionalIndex = Number(slot.replace("section-", ""));
    const mode = resolveSectionMode(newType, run.request?.aiRequiredSections ?? []);
    const componentName = sectionComponentName(newType, positionalIndex);
    const newPath = sectionFilePath(allowlistBase, componentName);

    if (mode === "static") {
      const [candidate] = listFrameCandidates(newType);
      const { fileContent } = populateFrame({ candidate, componentName });
      await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles: new Set(), relPath: newPath, content: fileContent });
      updated = { type: newType, mode, path: newPath, componentName, slot, frameId: candidate.id, finished: true };
    } else {
      await runSectionAgent({
        runId,
        run,
        workdir,
        allowlist,
        sectionType: newType,
        summary: params.instructions ? `${newType} section — ${params.instructions}` : `${newType} section`,
        filePath: newPath,
        componentName,
        instructions: params.instructions,
      });
      updated = { type: newType, mode, path: newPath, componentName, slot, finished: true };
    }
    // The old path (different type = different component) is simply
    // retired from the draft's manifest below — left on disk, unreferenced,
    // harmless (see the file header: draft_files, not the worktree, is
    // what commit() reads from).
  }

  const newSections = [...sections];
  newSections[index] = updated;
  const pageFile = composePage(
    newSections.map((s) => ({ componentName: s.componentName })),
    { allowlistBase }
  );
  await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles: new Set(), relPath: pageFile.path, content: pageFile.content });

  const pageUrlPath = config.pageUrlPathTemplate ? config.pageUrlPathTemplate.replaceAll("{slug}", run.slug) : null;
  const verifyResult = await runFullVerifySuite({
    workdir,
    installTimeoutMs: config.verifyInstallTimeoutMs,
    buildTimeoutMs: config.verifyBuildTimeoutMs,
    changedPaths: [...newSections.map((s) => s.path), pageFile.path],
    pageUrlPath,
    serverTimeoutMs: config.verifyServerTimeoutMs,
    packageManagerOverride: config.packageManagerOverride,
    disableDocker: config.verifyDisableDocker,
  });
  await runStore.appendLog(runId, "info", `refine[${slot}]: verify ${verifyResult.ok ? "PASSED" : "FAILED"} — ${verifyResult.report.slice(0, 500)}`);
  if (!verifyResult.ok) {
    throw new RefineActionError("verify_failed", verifyResult.report);
  }

  // Stage a new draft version: the previous version's files, with just the
  // refined slot's file (+ recomposed page.tsx) replaced. If the section
  // type changed, the OLD path is dropped from this version's manifest —
  // its content stays on disk (see above) but is no longer part of what
  // ships.
  const previousDraft = await draftStore.getLatestVersion(runId);
  const fileMap = new Map((previousDraft?.files ?? []).map((f) => [f.path, { path: f.path, content: f.content, sectionSlot: f.sectionSlot }]));
  if (current.path !== updated.path) fileMap.delete(current.path);
  const updatedContent = await readFile(path.join(workdir, updated.path), "utf8");
  fileMap.set(updated.path, { path: updated.path, content: updatedContent, sectionSlot: slot });
  fileMap.set(pageFile.path, { path: pageFile.path, content: pageFile.content, sectionSlot: null });

  const { version } = await draftStore.stageNewVersion({ runId, files: [...fileMap.values()] });
  await runStore.updateRun(runId, { sectionResults: newSections });
  await runStore.appendLog(runId, "info", `refine[${slot}]: action="${action}" succeeded, staged version ${version}`);

  // Refresh the live preview so a reviewer sees the change immediately —
  // stop-then-start rather than trust an in-place reload, since the serve
  // script may be a production build that doesn't hot-reload source changes.
  const baseDir = path.join(path.resolve(config.workdirRoot), "_base");
  await preview.stopPreview({ runId, baseDir }).catch(() => {});
  const previewResult = await preview.startPreview({
    runId,
    workdir,
    pageUrlPath,
    ttlMs: config.previewTtlMs,
    maxConcurrent: config.maxConcurrentPreviews,
    disableDocker: config.verifyDisableDocker,
  });

  return { ok: true, version, previewStarted: previewResult.ok, previewReport: previewResult.ok ? null : previewResult.report };
}
