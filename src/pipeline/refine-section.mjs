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
import { generateStaticSectionContent, staticOverridesAreUsable } from "../sections/generate-static-content.mjs";
import { describeFillableFields, initialFieldValues } from "../sections/describe-fillable-fields.mjs";
import { resolveSectionMode } from "../sections/classify-sections.mjs";
import { sectionComponentName, sectionFilePath, composePage } from "../sections/compose-page.mjs";
import { buildSectionAgentSystemPrompt } from "../sections/section-agent-prompt.mjs";
import { writeGuardedFile } from "../sections/write-guarded-file.mjs";
import { PREVIEW_LEAD_SINK_PATH } from "../leadform/contract.mjs";
import { detectTypeScriptStrictness, buildTypeScriptPromptFragment } from "./steps/detect-typescript-strictness.mjs";
import { generateText, extractJson } from "../llm/generate-text.mjs";

/* Per-section refinement (new_plan.md §9.7, module.md Module 4) — THIS is
 * the review step, not a separate approve/edit/reject workflow. Every
 * action here writes a NEW draft version for the refined slot only, never
 * touching the original frame file or any other section's rows, then
 * re-runs the FULL-PAGE verify suite (a section swap can affect page-wide
 * checks like hero-fit/SEO/a11y) before refreshing the live preview.
 *
 * refinePage() is the multi-section cousin: the reviewer describes a change
 * in plain language ("make the FAQ about photography", "soften the whole
 * page"), we pick which slots that touches, rewrite those with the coding
 * agent, then verify / stage / preview once.
 *
 * Nothing here is destructive on failure: verify runs against files
 * already written to the live scratch worktree, but `draft_files` (not the
 * worktree) is what commit() actually reads from — a failed refine leaves
 * bad content sitting in the worktree, harmless, never staged, never
 * committed. The next successful refine (or approval) simply overwrites it. */

/* "edit-copy" is the odd one out and the most useful: it is the only refine
 * action that makes NO LLM call. A static section's content is a plain object
 * that fill-static-frame.mjs merges over the frame's defaults, so changing a
 * word is a data edit — instant, free, and impossible to make structurally
 * invalid, because populateFrame parses the overrides against the same
 * fillableFields schema the form was derived from.
 *
 * Everything else here regenerates a file with an AI. Correcting a typo used
 * to mean doing that: minutes of waiting, a fresh chance to break the build,
 * and a bill, to fix one character. */
export const REFINE_ACTIONS = ["edit-copy", "use-different-frame", "modify", "redesign", "new"];

/** Marketing-facing aliases used to match a reviewer's free-text request to
 *  section slots without an LLM round-trip when the intent is obvious. */
export const SECTION_ALIASES = {
  hero: ["hero", "headline", "top of the page", "sign-up", "signup", "lead form"],
  details: ["details", "what's included", "whats included", "benefits", "features"],
  timeline: ["timeline", "how it works", "steps", "process"],
  testimonials: ["testimonials", "reviews", "quotes", "social proof"],
  faq: ["faq", "faqs", "frequently asked", "questions"],
  curriculum: ["curriculum", "syllabus", "modules", "roadmap", "agenda"],
  pricing: ["pricing", "packages", "price", "cost", "tiers"],
  instructor: ["instructor", "instructors", "teacher", "teachers", "trainer", "trainers"],
  "footer-cta": ["footer", "closing", "final cta", "bottom cta", "call to action at the bottom"],
};

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
  return sections.map((s) => {
    const candidate = s.mode === "static" ? getFrameCandidate(s.type, s.frameId) : null;
    return {
      ...s,
      candidates: listFrameCandidates(s.type).map((c) => ({ id: c.id, description: c.description })),
      fields: candidate ? describeFillableFields(candidate.fillableFields) : [],
      data: candidate ? initialFieldValues(candidate, s.data ?? null) : null,
    };
  });
}

function pickAcceptedFields(candidate, data) {
  if (!data || typeof data !== "object") return {};
  const accepted = {};
  for (const [key, value] of Object.entries(data)) {
    if (candidate.fillableFields.safeParse({ [key]: value }).success) accepted[key] = value;
  }
  return accepted;
}

function previewLeadSinkUrl() {
  return `${config.servicePublicBaseUrl}${PREVIEW_LEAD_SINK_PATH}`;
}

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
    pristineFiles: new Set(),
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
 * Pick which slots a free-text page request clearly names, without an LLM.
 * @param {string} instructions
 * @param {Array<{slot: string, type: string}>} sections
 * @returns {string[]}
 */
export function matchSlotsFromInstructions(instructions, sections) {
  if (typeof instructions !== "string" || !instructions.trim()) return [];
  const text = instructions.toLowerCase();

  if (/\b(whole page|entire page|everything|all sections|the whole thing)\b/.test(text)) {
    return sections.map((s) => s.slot);
  }

  const matched = [];
  for (const section of sections) {
    const aliases = SECTION_ALIASES[section.type] ?? [section.type];
    if (aliases.some((alias) => text.includes(alias.toLowerCase()))) {
      matched.push(section.slot);
    }
  }
  return matched;
}

/**
 * @returns {Promise<{slots: string[], source: "keywords"|"llm"|"all"}>}
 */
export async function planPageRefineSlots({ instructions, sections, request, logger = () => {} }) {
  const fromKeywords = matchSlotsFromInstructions(instructions, sections);
  if (fromKeywords.length > 0) {
    return { slots: fromKeywords, source: "keywords" };
  }

  const choosable = sections.filter((s) => s.type !== "hero" || /\bhero\b/i.test(instructions));

  try {
    const text = await generateText({
      system:
        'You route a marketer\'s page-edit request to the landing-page sections it should change. Return ONLY a JSON object: {"slots":["section-N",...]}',
      prompt: `Campaign: ${request?.campaignName ?? "(unknown)"}
Offer: ${request?.offer ?? ""}
Audience: ${request?.audience ?? ""}

Sections on the page:
${JSON.stringify(
  choosable.map((s) => ({ slot: s.slot, type: s.type })),
  null,
  2
)}

Marketer's request:
${instructions}

Return JSON: { "slots": ["section-N", ...] } — only slots that need to change to satisfy the request. Prefer the smallest set. If the request is about tone/branding for the whole page, include every listed slot.`,
      maxTokens: 2048,
      json: true,
    });
    const parsed = extractJson(text);
    const wanted = new Set(Array.isArray(parsed?.slots) ? parsed.slots.filter((s) => typeof s === "string") : []);
    const slots = choosable.map((s) => s.slot).filter((slot) => wanted.has(slot));
    if (slots.length > 0) return { slots, source: "llm" };
    logger("page refine planner returned no usable slots — applying to every non-hero section");
  } catch (err) {
    logger(`page refine planner failed (${err.message}) — applying to every non-hero section`);
  }

  return {
    slots: sections.filter((s) => s.type !== "hero").map((s) => s.slot),
    source: "all",
  };
}

async function finalizeRefine({ runId, run, workdir, allowlistBase, allowlist, newSections, logLabel, removedPaths = [] }) {
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
  await runStore.appendLog(runId, "info", `${logLabel}: verify ${verifyResult.ok ? "PASSED" : "FAILED"} — ${verifyResult.report.slice(0, 500)}`);
  if (!verifyResult.ok) {
    throw new RefineActionError("verify_failed", verifyResult.report);
  }

  const previousDraft = await draftStore.getLatestVersion(runId);
  const fileMap = new Map((previousDraft?.files ?? []).map((f) => [f.path, { path: f.path, content: f.content, sectionSlot: f.sectionSlot }]));
  for (const p of removedPaths) fileMap.delete(p);
  for (const section of newSections) {
    const content = await readFile(path.join(workdir, section.path), "utf8");
    fileMap.set(section.path, { path: section.path, content, sectionSlot: section.slot });
  }
  fileMap.set(pageFile.path, { path: pageFile.path, content: pageFile.content, sectionSlot: null });

  const { version } = await draftStore.stageNewVersion({ runId, files: [...fileMap.values()] });
  await runStore.updateRun(runId, { sectionResults: newSections });
  await runStore.appendLog(runId, "info", `${logLabel}: staged version ${version}`);

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

/**
 * @param {string} runId
 * @param {string} slot
 * @param {"edit-copy"|"use-different-frame"|"modify"|"redesign"|"new"} action
 * @param {object} [params]
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

  if (action === "edit-copy") {
    if (current.mode !== "static") {
      throw new RefineActionError(
        "invalid_action",
        `slot "${slot}" was written by AI, so its copy lives in the code rather than in a data object — use "modify" to change it`
      );
    }
    const candidate = getFrameCandidate(current.type, current.frameId);
    if (!candidate?.fillableFields) {
      throw new RefineActionError(
        "invalid_action",
        `the "${current.frameId}" layout has no editable copy — its content comes from real photos and fixed defaults`
      );
    }

    let built;
    try {
      built = populateFrame({ candidate, overrides: params.data ?? {}, componentName: current.componentName });
    } catch (err) {
      throw new RefineActionError("invalid_action", `the submitted copy doesn't fit this layout — ${err.message}`);
    }

    await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles: new Set(), relPath: current.path, content: built.fileContent });
    updated = { ...current, data: built.dataUsed };
  } else if (action === "use-different-frame") {
    if (current.mode !== "static") {
      throw new RefineActionError("invalid_action", `slot "${slot}" is ai-required, not static — use "redesign" instead`);
    }
    const candidate = getFrameCandidate(current.type, params.frameId);
    if (!candidate) {
      throw new RefineActionError("invalid_action", `"${params.frameId}" is not a valid static candidate for section type "${current.type}"`);
    }
    const carried = candidate.fillableFields ? pickAcceptedFields(candidate, current.data) : {};
    const { fileContent, dataUsed } = populateFrame({ candidate, overrides: carried, componentName: current.componentName });
    await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles: new Set(), relPath: current.path, content: fileContent });
    updated = { ...current, frameId: candidate.id, data: dataUsed };
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
    const newType = params.sectionType;
    if (!newType) throw new RefineActionError("invalid_action", `"new" requires a "sectionType"`);
    const positionalIndex = Number(slot.replace("section-", ""));
    const mode = resolveSectionMode(newType, run.request?.aiRequiredSections ?? []);
    const componentName = sectionComponentName(newType, positionalIndex);
    const newPath = sectionFilePath(allowlistBase, componentName);

    if (mode === "static") {
      const [candidate] = listFrameCandidates(newType);
      const summary = params.instructions ? `${newType} section — ${params.instructions}` : `${newType} section`;
      const overrides = await generateStaticSectionContent({
        candidate,
        section: { type: newType, summary },
        request: run.request,
        guide: run.guide,
        logger: (msg) => runStore.appendLog(runId, "info", `refine: ${msg}`),
      });
      if (!staticOverridesAreUsable(candidate, overrides)) {
        await runSectionAgent({
          runId,
          run,
          workdir,
          allowlist,
          sectionType: newType,
          summary,
          filePath: newPath,
          componentName,
          instructions: params.instructions,
        });
        updated = { type: newType, mode: "ai-required", path: newPath, componentName, slot, finished: true };
      } else {
        const { fileContent, dataUsed } = populateFrame({ candidate, overrides, componentName });
        await writeGuardedFile({ workdir, allowedPrefixes: allowlist, pristineFiles: new Set(), relPath: newPath, content: fileContent });
        updated = { type: newType, mode, path: newPath, componentName, slot, frameId: candidate.id, data: dataUsed, finished: true };
      }
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
  }

  const newSections = [...sections];
  newSections[index] = updated;
  const removedPaths = current.path !== updated.path ? [current.path] : [];

  const result = await finalizeRefine({
    runId,
    run,
    workdir,
    allowlistBase,
    allowlist,
    newSections,
    logLabel: `refine[${slot}]`,
    removedPaths,
  });
  await runStore.appendLog(runId, "info", `refine[${slot}]: action="${action}" succeeded, staged version ${result.version}`);
  return result;
}

/**
 * Page-level AI refine: plain-language instructions → rewrite one or more
 * sections → one verify / stage / preview cycle.
 *
 * @param {string} runId
 * @param {{instructions: string}} p
 * @param {object} [deps]
 */
export async function refinePage(runId, { instructions } = {}, deps = {}) {
  const planSlots = deps.planSlots ?? planPageRefineSlots;
  const runAgent = deps.runAgent ?? runSectionAgent;

  if (typeof instructions !== "string" || instructions.trim().length < 3) {
    throw new RefineActionError("invalid_action", "Tell the AI what to change — a short sentence is enough.");
  }

  const run = await runStore.getRun(runId);
  if (!run) throw new RefineActionError("not_found", `no such run "${runId}"`);
  if (run.status !== "staged_for_review") {
    throw new RefineActionError("wrong_status", `cannot refine run "${runId}" — status is "${run.status}", not "staged_for_review"`);
  }

  const sections = run.sectionResults ?? [];
  if (sections.length === 0) {
    throw new RefineActionError("invalid_action", "this page has no sections to change yet");
  }

  const allowlist = resolveAllowlist(config.writePathAllowlistTemplates, run.slug);
  const allowlistBase = allowlist[0];
  const workdir = run.workdir;

  const plan = await planSlots({
    instructions: instructions.trim(),
    sections,
    request: run.request,
    logger: (msg) => runStore.appendLog(runId, "info", `refine[page]: ${msg}`),
  });

  const targets = sections.filter((s) => plan.slots.includes(s.slot));
  if (targets.length === 0) {
    throw new RefineActionError(
      "invalid_action",
      "could not tell which sections to change — name a section (FAQ, testimonials, …) or say “whole page”"
    );
  }

  await runStore.appendLog(
    runId,
    "info",
    `refine[page]: rewriting ${targets.length} section(s) (${targets.map((t) => t.type).join(", ")}) via ${plan.source} — "${instructions.trim().slice(0, 120)}"`
  );

  await Promise.all(
    targets.map((section) =>
      runAgent({
        runId,
        run,
        workdir,
        allowlist,
        sectionType: section.type,
        summary: `${section.type} section — ${instructions.trim()}`,
        filePath: section.path,
        componentName: section.componentName,
        instructions: instructions.trim(),
      })
    )
  );

  const newSections = sections.map((s) =>
    plan.slots.includes(s.slot) ? { type: s.type, mode: "ai-required", path: s.path, componentName: s.componentName, slot: s.slot, finished: true } : s
  );

  const result = await finalizeRefine({
    runId,
    run,
    workdir,
    allowlistBase,
    allowlist,
    newSections,
    logLabel: "refine[page]",
  });
  return { ...result, slots: plan.slots, planSource: plan.source };
}
