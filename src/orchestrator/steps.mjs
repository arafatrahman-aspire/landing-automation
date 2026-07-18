import path from "node:path";
import { rm, mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { config, resolveAllowlist } from "../config.mjs";
import * as runStore from "../state/run-store.mjs";
import { generateText, extractJson } from "../ai/text.mjs";
import { runCodingAgent } from "../ai/coding-agent.mjs";
import {
  cloneShallow,
  listTrackedFiles,
  createLocalBranch,
  setRemoteAuth,
  commitPaths,
  push as gitPush,
} from "../git/ops.mjs";
import { runFullVerifySuite } from "../verify/index.mjs";
import { createPullRequest } from "../github/api.mjs";
import { validateFileManifest } from "../schemas/file-manifest-schema.mjs";
import { validateGuide, truncateGuideFields } from "../schemas/guide-schema.mjs";
import { SECTION_TYPES } from "../design/schema.mjs";
import { resolveSectionReferences, formatReferencesForPrompt } from "../design/resolve.mjs";

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

export async function fileManifest(state, { attempt = 1 } = {}) {
  await runStore.heartbeat(state.runId, "file_manifest");
  await log(state.runId, `file_manifest: generating (attempt ${attempt})`);
  const { request, guide: guideData } = state;
  const allowlist = resolveAllowlist(config.writePathAllowlistTemplates, request.slug);
  const repoConventions = await detectRepoConventions(state.workdir);
  const chosenSections = guideData.sections.map((s) => s.type);
  const resolved = await resolveSectionReferences({ workdir: state.workdir, sectionTypes: chosenSections });

  if (attempt === 1) {
    // Persisted (not just in-process LangGraph state) so GET /campaigns/:runId
    // can show a human which reference files actually grounded this plan.
    await runStore.updateRun(state.runId, {
      sectionReferences: resolved.map((r) => ({
        sectionType: r.sectionType,
        note: r.note,
        files: r.files.map((f) => ({ path: f.path, found: f.content !== null })),
      })),
    });
  }

  const text = await generateText({
    system: "You plan file structures for a coding agent. Return ONLY a fenced ```json block, no prose outside it.",
    prompt: `Given this content/section plan, declare which NEW frontend files should be created for this campaign's self-contained landing page.

Plan:
${JSON.stringify(guideData, null, 2)}

Target repo:
${repoConventions}

Section reference examples (real code from this repo, where available):
${formatReferencesForPrompt(resolved)}

Rules:
- Every path MUST start with one of these allowed prefixes: ${allowlist.join(" or ")}
- File types/extensions MUST match whatever this specific target repo actually uses — do not assume a framework. It could be React/Next.js (.tsx/.jsx), Vue (.vue), a Laravel app (.blade.php templates, PHP is only used for markup/logic that stays inside the new files), or plain HTML/CSS. Look at the target repo notes and reference examples above.
- Propose 2-8 files (a page/route entry plus its section components/partials). Do NOT reference or modify any existing file.
- Output ONLY this JSON shape in a \`\`\`json fence:
{"slug": "${request.slug}", "summary": "...", "designNotes": "...", "filesToCreate": [{"path": "...", "purpose": "..."}]}`,
  });

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (err) {
    if (attempt < 2) {
      await log(state.runId, `file_manifest: JSON parse failed, retrying — ${err.message}`);
      return fileManifest(state, { attempt: attempt + 1 });
    }
    throw new Error(`file_manifest: could not parse JSON after retry — ${err.message}`);
  }

  const result = validateFileManifest(parsed);
  if (!result.ok) {
    if (attempt < 2) {
      await log(state.runId, `file_manifest: schema invalid, retrying — ${result.errors}`);
      return fileManifest(state, { attempt: attempt + 1 });
    }
    throw new Error(`file_manifest: schema invalid after retry —\n${result.errors}`);
  }

  const outsideAllowlist = result.value.filesToCreate.filter(
    (f) => !allowlist.some((p) => f.path.startsWith(p))
  );
  if (outsideAllowlist.length > 0) {
    if (attempt < 2) {
      await log(state.runId, `file_manifest: ${outsideAllowlist.length} path(s) outside allowlist, retrying`);
      return fileManifest(state, { attempt: attempt + 1 });
    }
    throw new Error(
      `file_manifest: paths outside allowlist after retry: ${outsideAllowlist.map((f) => f.path).join(", ")}`
    );
  }

  await log(state.runId, `file_manifest: ${result.value.filesToCreate.length} file(s) planned`);
  return { fileManifest: result.value };
}

export async function clone(state) {
  await runStore.heartbeat(state.runId, "clone");
  const workdir = path.join(path.resolve(config.workdirRoot), state.runId);
  await mkdir(path.dirname(workdir), { recursive: true });
  const remoteUrl = config.github.cloneUrl;
  const isHttp = remoteUrl.startsWith("http");
  const token = isHttp ? config.github.token : undefined;
  await log(state.runId, `clone: ${remoteUrl}@${config.github.baseBranch} -> ${workdir}`);

  await cloneShallow({
    remoteUrl,
    branch: config.github.baseBranch,
    dir: workdir,
    token,
    timeoutMs: 120_000,
  });
  if (token) {
    await setRemoteAuth({ dir: workdir, remoteUrl, token });
  }
  const pristineFiles = await listTrackedFiles({ dir: workdir });
  await log(state.runId, `clone: snapshot done, ${pristineFiles.size} tracked files`);
  const branchName = `codegen/${state.request.slug}-${state.runId.slice(0, 8)}`;
  await createLocalBranch({ dir: workdir, branchName, baseBranch: config.github.baseBranch });

  await runStore.updateRun(state.runId, { branchName });
  await log(state.runId, `clone: done, branch "${branchName}" created locally`);
  return { workdir, pristineFiles, branchName };
}

export async function code(state) {
  const attempt = state.codeAttempts + 1;
  await runStore.heartbeat(state.runId, "code");
  await runStore.updateRun(state.runId, { codeAttempts: attempt });
  await log(state.runId, `code: agentic loop starting (attempt ${attempt})`);

  const allowlist = resolveAllowlist(config.writePathAllowlistTemplates, state.request.slug);
  const manifestPaths = new Set(state.fileManifest.filesToCreate.map((f) => f.path));

  const systemPrompt = `You are a coding agent adding a new campaign landing page to an existing frontend repository, matching its existing design system and shared component library.

GUARDRAILS (enforced in code, not just instructions):
- You may ONLY create files under: ${allowlist.join(", ")}
- You may ONLY create files declared in the plan below — nothing else.
- You can NEVER modify or overwrite a file that already existed in this repository.
- You have no shell access. Explore with list_files/read_file, write with write_file, and call finish_coding when done.

Explore the repository first — this could be a Next.js/React repo, a Laravel/PHP repo (Blade templates), a Vue repo, or something else entirely. Check for package.json vs. composer.json, the routing/page convention, an existing page or component similar to a landing page, and the styling approach (Tailwind config, CSS modules, Blade + plain CSS, whatever it actually uses), so your new code matches its REAL conventions (framework, component/template patterns, import style, design tokens/colors, spacing), THEN create the planned files.

HERO REQUIREMENT (above the fold, no scrolling, at BOTH desktop and mobile widths): one block containing the shortened campaign title, a video-or-details block, and the lead-capture form (name, phone, email, CTA button). Video-or-details and the form sit side by side on desktop, stacked vertically on mobile. Use responsive sizing (e.g. CSS clamp() or the repo's existing type scale) so the title shrinks gracefully rather than overflowing. Mark these three elements with these EXACT attributes (an automated check looks for them to verify placement — plain HTML attributes, not classes): \`data-hero-title\` on the title element, \`data-hero-media\` on the video-or-details block, \`data-hero-form\` on the lead form. These attributes are invisible to visitors and don't affect styling.

The page MUST be self-contained: import/include ONLY from packages or PHP classes already declared in package.json/composer.json, the target repo's own existing shared components/partials (read them first, don't guess), and files you create in this same page. Do NOT modify any existing file — if the repo needs an existing routes file edited to make this page reachable (e.g. Laravel's routes/web.php), do NOT do it; leave the page unwired and say so in your finish_coding summary so the PR can flag it for a human to wire up. Every file must be valid and clean per the repo's own conventions.

FILE PLAN:
${JSON.stringify(state.fileManifest, null, 2)}

CONTENT/SECTION PLAN:
${JSON.stringify(state.guide, null, 2)}
${state.verifyReport ? `\nPREVIOUS ATTEMPT FAILED VERIFICATION — fix this before finishing:\n${state.verifyReport}\n` : ""}`;

  const result = await runCodingAgent({
    workdir: state.workdir,
    allowedPrefixes: allowlist,
    pristineFiles: state.pristineFiles,
    manifestPaths,
    systemPrompt,
    taskPrompt: "Explore the repository, then implement the file plan. Call finish_coding when done.",
    logger: (msg) => log(state.runId, `code: ${msg}`),
  });

  if (result.finished) {
    await log(state.runId, `code: finished after ${result.iterations} iteration(s) — ${result.writtenFiles.size} file(s) written`);
  } else {
    await log(state.runId, "code: hit max iterations without finish_coding");
  }

  return {
    agentSummary: result.summary,
    agentIterations: result.iterations,
    writtenByAgent: result.writtenFiles,
    codeAttempts: attempt,
    codeFinished: result.finished,
    // An unfinished loop must never reach verify as if it were buildable —
    // route straight to the retry/halt decision with a clear reason.
    ...(result.finished ? {} : { verifyPassed: false, verifyReport: "Coding agent hit max iterations without calling finish_coding." }),
  };
}

export async function verify(state) {
  if (!state.codeFinished) {
    // code() already recorded why; nothing to build.
    return {};
  }
  await runStore.heartbeat(state.runId, "verify");
  await log(state.runId, "verify: validating the new files (build/lint + hero-fit/seo/a11y, ecosystem-aware)");
  const changedPaths =
    state.writtenByAgent && state.writtenByAgent.size > 0
      ? [...state.writtenByAgent]
      : state.fileManifest.filesToCreate.map((f) => f.path);
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
  });
  const verifyAttempts = state.verifyAttempts + 1;
  await runStore.updateRun(state.runId, { verifyAttempts, verifyChecks: result.checks });
  await log(state.runId, `verify: ${result.ok ? "PASSED" : "FAILED"} — ${result.report.slice(0, 500)}`);
  return { verifyPassed: result.ok, verifyReport: result.ok ? null : result.report, verifyAttempts };
}

export async function commit(state) {
  await runStore.heartbeat(state.runId, "committing");
  const manifestPaths = state.fileManifest.filesToCreate.map((f) => f.path);
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
    if (!config.keepWorkdirOnFailure) {
      await rm(state.workdir, { recursive: true, force: true }).catch(() => {});
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
  if (!config.keepWorkdirOnFailure) {
    await rm(state.workdir, { recursive: true, force: true }).catch(() => {});
  }
  return { prUrl: pr.html_url, prNumber: pr.number, status: "completed" };
}

function buildPrBody(state) {
  const files = state.fileManifest.filesToCreate.map((f) => `- \`${f.path}\` — ${f.purpose}`).join("\n");
  return `## Summary
${state.fileManifest.summary}

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

## File plan
${JSON.stringify(state.fileManifest, null, 2)}

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
