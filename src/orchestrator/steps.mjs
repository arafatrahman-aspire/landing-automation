import path from "node:path";
import { mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { config, resolveAllowlist } from "../config.mjs";
import * as runStore from "../state/repository.mjs";
import * as draftStore from "../staging/draft-store.mjs";
import { generateText, extractJson } from "../ai/text.mjs";
import { runCodingAgent } from "../ai/coding-agent.mjs";
import {
  cloneShallow,
  syncBaseToLatest,
  addWorktree,
  removeWorktree,
  listTrackedFiles,
  setRemoteAuth,
  commitPaths,
  push as gitPush,
} from "../git/ops.mjs";
import { runFullVerifySuite } from "../verify/index.mjs";
import { startPreview } from "../preview/sandbox.mjs";
import { createPullRequest } from "../github/api.mjs";
import { validateGuide, truncateGuideFields } from "../schemas/guide-schema.mjs";
import { SECTION_TYPES } from "../design/schema.mjs";
import { resolveSectionReferences, formatReferencesForPrompt } from "../design/resolve.mjs";
import { classifySections } from "../sections/classify.mjs";
import { generateSections } from "../sections/generate-sections.mjs";
import { PREVIEW_LEAD_SINK_PATH } from "../leadform/contract.mjs";

/* Pure-ish stage functions the LangGraph nodes call (orchestrator/graph.mjs).
 * Each takes/returns a partial CodegenState for LangGraph's internal flow
 * (what the NEXT node needs). Anything the HTTP API surface needs (branch
 * name, attempt counts, PR url) is ALSO explicitly written to run-store here
 * — LangGraph's state lives only in-process during graph.invoke(); the
 * filesystem record is the only thing GET /campaigns/:id can see. */

function log(runId, message) {
  return runStore.appendLog(runId, "info", message);
}

/* The target repo's stack isn't fixed (Next.js today, Laravel or something
 * else tomorrow) — a lightweight scan right after clone, BEFORE guide/
 * file_manifest lock in any file paths, so those stages describe the plan
 * in terms of what this repo actually is instead of assuming React. This is
 * deliberately shallow (no full dependency-tree walk): just enough signal
 * for the LLM to stop guessing. */
async function detectRepoConventions(workdir) {
  const notes = [];

  try {
    const pkg = JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = deps.next ? "Next.js" : deps.react ? "React" : deps.vue ? "Vue" : "a Node-based frontend";
    notes.push(`package.json found (${framework} — key deps: ${Object.keys(deps).slice(0, 15).join(", ") || "none"}).`);
  } catch {
    /* no package.json at root — fine, could be PHP or a monorepo subfolder */
  }

  const hasComposer = await access(path.join(workdir, "composer.json")).then(() => true, () => false);
  if (hasComposer) {
    notes.push(
      "composer.json found — likely a PHP/Laravel repo. New pages are probably Blade templates " +
        "(.blade.php); routing is normally registered in an existing routes file, which must NOT be " +
        "modified (pristine-file guard) — leave the new page unwired and note in the PR that a human " +
        "needs to add the route manually."
    );
  }

  try {
    const entries = await readdir(workdir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !["node_modules", ".git", "vendor", "dist", "build", ".next"].includes(e.name))
      .map((e) => e.name);
    notes.push(`Top-level directories: ${dirs.join(", ") || "(none)"}`);
  } catch {
    /* ignore — best-effort signal only */
  }

  return notes.join("\n") || "(repo structure could not be inspected — explore it directly once coding starts)";
}

export async function intake(state) {
  await runStore.heartbeat(state.runId, "intake");
  await log(state.runId, `intake: campaign "${state.request.campaignName}" (${state.request.slug})`);
  return {};
}

export async function research(state) {
  await runStore.heartbeat(state.runId, "research");
  if (config.skipResearch) {
    await log(state.runId, "research: skipped (SKIP_RESEARCH=true)");
    return { researchNotes: null };
  }
  await log(state.runId, "research: querying LLM (web search)");
  const { request } = state;
  const text = await generateText({
    system: "You are a research assistant for a marketing landing page. Return ONLY valid JSON, no prose.",
    prompt: `Research this marketing campaign so a copywriter/designer can build a high-converting landing page for it. Return JSON: {"keywords": string[], "painPoints": string[], "faqQuestions": string[], "notes": string}.

Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
Brief notes: ${request.brief}`,
    webSearch: true,
  });
  const researchNotes = extractJson(text);
  await log(
    state.runId,
    `research: done (${researchNotes.keywords?.length ?? 0} keywords, ${researchNotes.faqQuestions?.length ?? 0} FAQ questions)`
  );
  return { researchNotes };
}

export async function guide(state, { attempt = 1 } = {}) {
  await runStore.heartbeat(state.runId, "guide");
  await log(state.runId, `guide: generating a structured content/section plan (attempt ${attempt})`);
  const { request, researchNotes } = state;
  const repoConventions = await detectRepoConventions(state.workdir);
  // Resolve examples for EVERY catalog section type (not just chosen ones yet —
  // sections haven't been chosen until this very call returns) so the model
  // picks its section list having actually seen real code, not a blank page.
  const catalogExamples = await resolveSectionReferences({ workdir: state.workdir, sectionTypes: SECTION_TYPES });

  const text = await generateText({
    system:
      "You plan content and section composition for a marketing landing page, for a coding agent to implement inside an existing frontend repository. Return ONLY a fenced ```json block, no prose outside it.",
    prompt: `Plan a new, self-contained campaign landing page.

Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
CTA: ${request.cta}
Video URL: ${request.videoUrl ?? "(none provided)"}
Brief notes: ${request.brief}
${researchNotes ? `Research: ${JSON.stringify(researchNotes)}` : ""}

TARGET REPO (just cloned):
${repoConventions}

AVAILABLE SECTION TYPES (choose ONLY from this fixed list — you cannot invent a new one), with real examples from this repo's design catalog where available:
${formatReferencesForPrompt(catalogExamples)}

Rules — STRICT length limits, every field is required, do not exceed them:
- heroTitle: 40-60 characters MAX.
- seoTitle: 70 characters MAX.
- seoMetaDescription: 200 characters MAX.
- "sections" is an ordered array drawn ONLY from: ${SECTION_TYPES.join(", ")}. Always include exactly one "hero", first. Only include other sections that genuinely make sense for this campaign (2-5 sections total is typical, not all 9).
- EVERY section object MUST have BOTH a "type" and a "summary" key — never omit "summary". Each summary is ONE short sentence, 100 characters MAX.
- heroHasVideo: true only because a Video URL was provided above; false means the hero shows a compact "what / when / who" details summary instead.
- seoTitle/seoMetaDescription: concise and accurate, not generic or keyword-stuffed.
- Output ONLY this exact JSON shape in a \`\`\`json fence, nothing else, no comments, no trailing text:
{"heroTitle": "...", "heroHasVideo": ${Boolean(request.videoUrl)}, "seoTitle": "...", "seoMetaDescription": "...", "sections": [{"type": "hero", "summary": "..."}, {"type": "faq", "summary": "..."}]}`,
  });

  let parsed;
  try {
    parsed = truncateGuideFields(extractJson(text));
  } catch (err) {
    if (attempt < 2) {
      await log(state.runId, `guide: JSON parse failed, retrying — ${err.message}`);
      return guide(state, { attempt: attempt + 1 });
    }
    throw new Error(`guide: could not parse JSON after retry — ${err.message}`);
  }

  const result = validateGuide(parsed);
  if (!result.ok) {
    if (attempt < 2) {
      await log(state.runId, `guide: schema invalid, retrying — ${result.errors}`);
      return guide(state, { attempt: attempt + 1 });
    }
    throw new Error(`guide: schema invalid after retry —\n${result.errors}`);
  }

  await runStore.updateRun(state.runId, { guide: result.value });
  await log(
    state.runId,
    `guide: done — ${result.value.sections.length} section(s): ${result.value.sections.map((s) => s.type).join(", ")}`
  );
  return { guide: result.value };
}

/* Section classification (new_plan.md §9.2, module.md Module 2). Pure
 * decision over the guide's already-chosen section list — no LLM call.
 * Runs once; a verify-failure retry re-runs generateSectionsStep, not this
 * (mode/frameId don't change because a build broke). Replaces the old
 * file_manifest LLM-planning step: every file's path is now deterministic
 * (sections/classify.mjs + sections/generate-sections.mjs's path
 * convention) instead of guessed by an LLM call. */
export async function classifySectionsStep(state) {
  await runStore.heartbeat(state.runId, "classify_sections");
  const classified = classifySections(state.guide.sections, { aiRequiredSections: state.request.aiRequiredSections ?? [] });
  const staticCount = classified.filter((s) => s.mode === "static").length;
  const aiCount = classified.length - staticCount;
  await log(state.runId, `classify_sections: ${staticCount} static, ${aiCount} ai-required — ${classified.map((s) => `${s.type}:${s.mode}`).join(", ")}`);

  // Persisted (not just in-process LangGraph state) so GET /campaigns/:runId
  // can show a human which reference files actually grounded the guide's
  // section choices — same behavior the old file_manifest step used to
  // provide, just moved here since this is now its natural successor.
  const chosenSections = state.guide.sections.map((s) => s.type);
  const resolved = await resolveSectionReferences({ workdir: state.workdir, sectionTypes: chosenSections });
  await runStore.updateRun(state.runId, {
    sectionReferences: resolved.map((r) => ({
      sectionType: r.sectionType,
      note: r.note,
      files: r.files.map((f) => ({ path: f.path, found: f.content !== null })),
    })),
  });

  return { classifiedSections: classified };
}

/* A fresh network clone every run is slow and wasteful — instead, a single
 * persistent "base" clone lives at WORKDIR_ROOT/_base (created once), kept up
 * to date with a cheap shallow fetch+reset before each run, and each run gets
 * its own isolated working directory via `git worktree add` — a new branch
 * checked out into its own folder, sharing the base clone's object store
 * instead of re-downloading the whole repo. Cleanup removes the worktree
 * (and its local branch) but never touches the base clone itself.
 *
 * All runs share one `_base` checkout now (they didn't when each run got its
 * own fresh clone), so two campaigns starting close together would otherwise
 * race on `_base`'s own fetch/reset/checkout — serialized via baseCloneLock
 * below so only one run touches `_base` at a time; `git worktree add` itself
 * is safe to run concurrently against a settled `_base`, so only the
 * ensure/sync step needs to be inside the lock. */
let baseCloneLock = Promise.resolve();
function withBaseCloneLock(fn) {
  const next = baseCloneLock.then(fn, fn);
  baseCloneLock = next.catch(() => {});
  return next;
}

export async function clone(state) {
  await runStore.heartbeat(state.runId, "clone");
  const workdirRoot = path.resolve(config.workdirRoot);
  const baseDir = path.join(workdirRoot, "_base");
  const workdir = path.join(workdirRoot, state.runId);
  await mkdir(workdirRoot, { recursive: true });

  const remoteUrl = config.github.cloneUrl;
  const isHttp = remoteUrl.startsWith("http");
  const token = isHttp ? config.github.token : undefined;

  await withBaseCloneLock(async () => {
    const baseExists = await access(path.join(baseDir, ".git")).then(() => true, () => false);
    if (!baseExists) {
      await log(state.runId, `clone: no cached base clone yet — cloning ${remoteUrl}@${config.github.baseBranch} once into ${baseDir}`);
      await cloneShallow({ remoteUrl, branch: config.github.baseBranch, dir: baseDir, token, timeoutMs: 120_000 });
      if (token) await setRemoteAuth({ dir: baseDir, remoteUrl, token });
    } else {
      await log(state.runId, `clone: reusing cached base clone at ${baseDir} — syncing to latest ${config.github.baseBranch} (no full re-clone)`);
      if (token) await setRemoteAuth({ dir: baseDir, remoteUrl, token });
      await syncBaseToLatest({ dir: baseDir, branch: config.github.baseBranch });
    }
  });

  const branchName = `codegen/${state.request.slug}-${state.runId.slice(0, 8)}`;
  await addWorktree({ baseDir, workdir, branchName, baseBranch: config.github.baseBranch });

  const pristineFiles = await listTrackedFiles({ dir: workdir });
  await log(state.runId, `clone: snapshot done, ${pristineFiles.size} tracked files`);

  await runStore.updateRun(state.runId, { branchName, workdir });
  await log(state.runId, `clone: done, branch "${branchName}" checked out into its own worktree`);
  return { workdir, pristineFiles, branchName, baseDir };
}

const SOURCE_FILE_RE = /\.(jsx?|tsx?|vue)$/;
const IMPORT_SCAN_EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "vendor"]);
const IMPORT_SCAN_MAX_FILES = 3000;
const IMPORT_SCAN_MAX_EXAMPLES = 8;

/** A prompt instruction alone ("go check how the repo does this") isn't
 *  reliable — a real run repeated the identical `react-icons/fa6` mistake
 *  on retry instead of looking, even after being told to. So instead of
 *  only asking the model to explore, the orchestrator itself greps the
 *  cloned repo for real, working import lines of whatever package the
 *  previous verify failure named unresolvable, and hands them over as
 *  ground truth. Bounded scan (file-count cap, common extensions only) —
 *  this only runs once per retry, not per request. */
export async function findExistingImportExamples({ workdir, verifyReport }) {
  if (!verifyReport) return "";
  const unresolved = [...verifyReport.matchAll(/Can't resolve '([^']+)'/g)].map((m) => m[1]);
  if (unresolved.length === 0) return "";

  const basePackages = new Set(
    unresolved.map((mod) => {
      const parts = mod.split("/");
      return mod.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    })
  );

  const examples = [];
  let scanned = 0;

  async function walk(dir) {
    if (examples.length >= IMPORT_SCAN_MAX_EXAMPLES || scanned >= IMPORT_SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (examples.length >= IMPORT_SCAN_MAX_EXAMPLES || scanned >= IMPORT_SCAN_MAX_FILES) return;
      if (IMPORT_SCAN_EXCLUDED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!SOURCE_FILE_RE.test(entry.name)) continue;
      scanned++;
      let content;
      try {
        content = await readFile(full, "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!/\b(from|require)\s*\(?['"]/.test(line)) continue;
        for (const pkg of basePackages) {
          if (line.includes(pkg)) {
            examples.push(`${path.relative(workdir, full)}: ${line.trim()}`);
            break;
          }
        }
      }
    }
  }
  await walk(workdir);

  if (examples.length === 0) return "";
  return `\nREAL EXISTING IMPORTS OF THE SAME PACKAGE(S), FOUND ELSEWHERE IN THIS REPO — copy the exact path used here, do not invent a different one:\n${examples.slice(0, IMPORT_SCAN_MAX_EXAMPLES).join("\n")}\n`;
}

/* Fan-out section generation (new_plan.md §9.5/§9.6, module.md Module 2).
 * Replaces the old single whole-page coding-agent loop: static sections are
 * templated directly (no LLM), each ai-required section gets its own
 * independent coding-agent run scoped to exactly one file, all concurrent —
 * see sections/generate-sections.mjs for the actual dispatcher. */
export async function generateSectionsStep(state) {
  const attempt = state.codeAttempts + 1;
  await runStore.heartbeat(state.runId, "generate_sections");
  await runStore.updateRun(state.runId, { codeAttempts: attempt });
  await log(state.runId, `generate_sections: fan-out starting (attempt ${attempt}, ${state.classifiedSections.length} section(s))`);

  const allowlist = resolveAllowlist(config.writePathAllowlistTemplates, state.request.slug);
  const importExamples = await findExistingImportExamples({ workdir: state.workdir, verifyReport: state.verifyReport });

  const result = await generateSections({
    classifiedSections: state.classifiedSections,
    workdir: state.workdir,
    allowlist,
    pristineFiles: state.pristineFiles,
    request: state.request,
    guide: state.guide,
    verifyReport: state.verifyReport,
    importExamples,
    maxIterations: config.maxAgentIterations,
    previewLeadSinkUrl: `${config.servicePublicBaseUrl}${PREVIEW_LEAD_SINK_PATH}`,
    logger: (msg) => log(state.runId, `generate_sections: ${msg}`),
  });

  if (result.codeFinished) {
    await log(state.runId, `generate_sections: all ${result.sectionResults.length} section(s) finished — ${result.writtenByAgent.size} file(s) written`);
  } else {
    await log(state.runId, "generate_sections: one or more ai-required sections hit max iterations without finish_coding");
  }

  // Persisted (not just in-process LangGraph state) so Phase 7's
  // approveRun() — invoked from a LATER, separate request, long after this
  // graph.invoke() call has returned — can rebuild what commit()/openPr()
  // need without a LangGraph checkpointer.
  await runStore.updateRun(state.runId, { agentSummary: result.agentSummary, sectionResults: result.sectionResults });

  return {
    agentSummary: result.agentSummary,
    writtenByAgent: result.writtenByAgent,
    sectionResults: result.sectionResults,
    codeAttempts: attempt,
    codeFinished: result.codeFinished,
    // An unfinished section must never reach verify as if the page were
    // buildable — route straight to the retry/halt decision with a clear reason.
    ...(result.codeFinished ? {} : { verifyPassed: false, verifyReport: "One or more ai-required sections hit max iterations without calling finish_coding." }),
  };
}

export async function verify(state) {
  if (!state.codeFinished) {
    // code() already recorded why; nothing to build.
    return {};
  }
  await runStore.heartbeat(state.runId, "verify");
  await log(state.runId, "verify: validating the new files (build/lint + hero-fit/seo/a11y, ecosystem-aware)");
  const changedPaths = [...state.writtenByAgent];
  const pageUrlPath = config.pageUrlPathTemplate
    ? config.pageUrlPathTemplate.replaceAll("{slug}", state.request.slug)
    : null;
  const result = await runFullVerifySuite({
    workdir: state.workdir,
    installTimeoutMs: config.verifyInstallTimeoutMs,
    buildTimeoutMs: config.verifyBuildTimeoutMs,
    changedPaths,
    pageUrlPath,
    serverTimeoutMs: config.verifyServerTimeoutMs,
    packageManagerOverride: config.packageManagerOverride,
    disableDocker: config.verifyDisableDocker,
  });
  const verifyAttempts = state.verifyAttempts + 1;
  await runStore.updateRun(state.runId, { verifyAttempts, verifyChecks: result.checks });
  await log(state.runId, `verify: ${result.ok ? "PASSED" : "FAILED"} — ${result.report.slice(0, 500)}`);
  return { verifyPassed: result.ok, verifyReport: result.ok ? null : result.report, verifyAttempts };
}

/* Records exactly what the agent wrote for this run in the database
 * (staging/draft-store.mjs), before anything touches git — a durable,
 * queryable copy of the generated files that a future review UI (Phase 6)
 * can read/diff without needing the scratch worktree to still exist. */
export async function stageDraft(state) {
  await runStore.heartbeat(state.runId, "stage_draft");
  const paths = [...state.writtenByAgent];
  // Every section file gets tagged with its slot (new_plan.md §9.6/module.md
  // Module 3) so a future per-section refine can version just one slot
  // without touching the rest. The composed page.tsx isn't in sectionResults
  // (it's the one extra path generate_sections writes) — it has no single
  // slot, so it's tagged null, same convention as the schema's own comment.
  const slotByPath = new Map(state.sectionResults.map((r) => [r.path, r.slot]));
  const files = await Promise.all(
    paths.map(async (p) => ({
      path: p,
      content: await readFile(path.join(state.workdir, p), "utf8"),
      sectionSlot: slotByPath.get(p) ?? null,
    }))
  );
  const { version } = await draftStore.stageNewVersion({ runId: state.runId, files });
  await log(state.runId, `stage_draft: staged version ${version} (${files.length} file(s), ${slotByPath.size} section slot(s))`);
  return {};
}

/* Starts a longer-lived preview server for a human to actually look at
 * (Phase 4) — non-fatal by design: the graph still auto-continues to
 * commit/push/open_pr whether or not this succeeds (Phase 6 is what adds a
 * real human gate; until then, preview is a convenience, not a blocker).
 * When it DOES succeed, openPr() below skips its own worktree cleanup —
 * the preview is still bind-mounting/reading from that directory, so
 * deleting it out from under a live preview would break the very thing
 * this step just started. Cleanup happens later, from the preview's own
 * lifecycle (idle sweep, explicit stop, or boot reconciliation — see
 * preview/sandbox.mjs). */
export async function previewBuild(state) {
  await runStore.heartbeat(state.runId, "preview_build");
  const pageUrlPath = config.pageUrlPathTemplate
    ? config.pageUrlPathTemplate.replaceAll("{slug}", state.request.slug)
    : null;
  const result = await startPreview({
    runId: state.runId,
    workdir: state.workdir,
    pageUrlPath,
    ttlMs: config.previewTtlMs,
    maxConcurrent: config.maxConcurrentPreviews,
    disableDocker: config.verifyDisableDocker,
  });
  if (!result.ok) {
    await log(state.runId, `preview_build: skipped — ${result.report}`);
    return { previewStarted: false };
  }
  await log(state.runId, `preview_build: started (${result.kind}) — ${result.url}, expires ${result.expiresAt}`);
  return { previewStarted: true };
}

export async function commit(state) {
  await runStore.heartbeat(state.runId, "committing");
  const manifestPaths = [...state.writtenByAgent];
  const logRelPath = "CODEGEN_LOG.md";
  await writeCodegenLog(state, path.join(state.workdir, logRelPath));
  await commitPaths({
    dir: state.workdir,
    paths: [...manifestPaths, logRelPath],
    message: `feat(campaign): add ${state.request.slug} landing page (AI-generated, run ${state.runId})`,
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
  });
  await log(state.runId, `commit: ${manifestPaths.length + 1} file(s) committed`);
  return {};
}

export async function push(state) {
  await runStore.heartbeat(state.runId, "pushing");
  await log(state.runId, `push: branch "${state.branchName}"`);
  await gitPush({
    dir: state.workdir,
    branchName: state.branchName,
    baseBranch: config.github.baseBranch,
  });
  await log(state.runId, "push: done");
  return {};
}

export async function openPr(state) {
  await runStore.heartbeat(state.runId, "opening_pr");

  if (config.dryRunNoPr) {
    await log(state.runId, "open_pr: DRY RUN — skipping the real GitHub API call (DRY_RUN_NO_PR=true)");
    await runStore.updateRun(state.runId, {
      prUrl: "(dry-run: no real PR opened — branch was pushed for real, see branchName)",
      status: "completed",
    });
    if (!config.keepWorkdirOnFailure && !state.previewStarted) {
      await removeWorktree({ baseDir: state.baseDir, workdir: state.workdir, branchName: state.branchName });
    }
    return { prUrl: null, prNumber: null, status: "completed" };
  }

  const pr = await createPullRequest({
    apiUrl: config.github.apiUrl,
    owner: config.github.owner,
    repo: config.github.repo,
    token: config.github.token,
    title: `[AI] ${state.request.campaignName} campaign module`,
    head: state.branchName,
    base: config.github.baseBranch,
    body: buildPrBody(state),
  });
  await runStore.updateRun(state.runId, { prUrl: pr.html_url, prNumber: pr.number, status: "completed" });
  await log(state.runId, `open_pr: ${pr.html_url}`);
  if (!config.keepWorkdirOnFailure && !state.previewStarted) {
    await removeWorktree({ baseDir: state.baseDir, workdir: state.workdir, branchName: state.branchName });
  }
  return { prUrl: pr.html_url, prNumber: pr.number, status: "completed" };
}

function buildPrBody(state) {
  const files = state.sectionResults
    .map((r) => `- \`${r.path}\` — "${r.type}" section (${r.mode})`)
    .concat([...state.writtenByAgent].filter((p) => p.endsWith("/page.tsx")).map((p) => `- \`${p}\` — composed page, imports every section above in order`))
    .join("\n");
  return `## Summary
${state.guide.sections.length} section(s) generated for "${state.request.campaignName}": ${state.sectionResults.map((r) => `${r.type} (${r.mode})`).join(", ")}.

**This PR was generated by an AI coding agent** (run \`${state.runId}\`) from a campaign brief. It only adds new, isolated files — no existing file was modified.

## Files added
${files}

## Agent notes
${state.agentSummary ?? "(none)"}

## Reviewer checklist
- [ ] Diff touches ONLY the files listed above (no unexpected changes)
- [ ] Page is self-contained (imports only declared deps / the repo's own shared components / its own files)
- [ ] Hero (title + video-or-details + lead form) is visible without scrolling, on both desktop and mobile
- [ ] Copy/claims are accurate
- [ ] If this repo needs an explicit route registered to make the page reachable (e.g. Laravel's \`routes/web.php\`), add that manually — the agent never edits existing files, so it isn't wired in yet
`;
}

async function writeCodegenLog(state, filePath) {
  const fullLog = await runStore.getFullLog(state.runId);
  const content = `# Codegen run ${state.runId}

## Content/section plan
${JSON.stringify(state.guide, null, 2)}

## Section classification & results
${JSON.stringify(state.sectionResults, null, 2)}

## Agent summary
${state.agentSummary ?? "(none)"}

## Verification
${state.verifyReport ?? "passed"}

## Full run log
\`\`\`
${fullLog ?? "(unavailable)"}
\`\`\`
`;
  await writeFile(filePath, content);
}
