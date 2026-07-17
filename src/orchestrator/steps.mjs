import path from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";
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
import { verifyBuild } from "../verify/build.mjs";
import { createPullRequest } from "../github/api.mjs";
import { validateFileManifest } from "../schemas/file-manifest-schema.mjs";

/* Pure-ish stage functions the LangGraph nodes call (orchestrator/graph.mjs).
 * Each takes/returns a partial CodegenState for LangGraph's internal flow
 * (what the NEXT node needs). Anything the HTTP API surface needs (branch
 * name, attempt counts, PR url) is ALSO explicitly written to run-store here
 * — LangGraph's state lives only in-process during graph.invoke(); the
 * filesystem record is the only thing GET /campaigns/:id can see. */

function log(runId, message) {
  return runStore.appendLog(runId, "info", message);
}

/* Python package directories must be valid import identifiers, so a kebab-case
 * slug (enforced by the brief schema, e.g. "spring-security-sale") can't be a
 * dashed directory the agent would import from. Resolve the write-path
 * allowlist with an underscored form so the plan, the coding-agent guardrail,
 * and what the model naturally writes all agree. (For a dash-free slug this is
 * a no-op, so it's harmless for non-Python targets too.) */
function packageSlug(slug) {
  return slug.replaceAll("-", "_");
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
    system: "You are a research assistant for a software feature. Return ONLY valid JSON, no prose.",
    prompt: `Research this marketing campaign so a backend engineer can model it as a small API feature. Return JSON: {"keywords": string[], "painPoints": string[], "faqQuestions": string[], "notes": string}.

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

export async function guide(state) {
  await runStore.heartbeat(state.runId, "guide");
  await log(state.runId, "guide: generating a technical spec for the feature module");
  const { request, researchNotes } = state;
  const guideText = await generateText({
    system:
      "You write concise technical specs for a coding agent to implement a small, self-contained backend feature in an existing FastAPI (Python) service. Plain text, no code.",
    prompt: `Write a short technical spec for a new, self-contained FastAPI feature module that represents this marketing campaign as a backend feature.

Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
CTA: ${request.cta}
Brief notes: ${request.brief}
${researchNotes ? `Research: ${JSON.stringify(researchNotes)}` : ""}

The module is ADDITIVE and ISOLATED — it must not modify any existing file and nothing else in the repo imports it yet. Cover:
- an APIRouter with 2-3 endpoints (e.g. GET campaign details/offer, POST a lead-capture matching the CTA),
- Pydantic request/response schemas,
- a small service/logic layer (in-memory or clearly stubbed persistence — do NOT assume access to the app's existing DB session),
- the campaign copy (headline, offer summary, ${request.cta}) surfaced via the endpoints.
List the Python files the module needs. Keep it under 400 words.`,
  });
  await log(state.runId, "guide: done");
  return { guide: guideText };
}

export async function fileManifest(state, { attempt = 1 } = {}) {
  await runStore.heartbeat(state.runId, "file_manifest");
  await log(state.runId, `file_manifest: generating (attempt ${attempt})`);
  const { request, guide: guideText } = state;
  const allowlist = resolveAllowlist(config.writePathAllowlistTemplates, packageSlug(request.slug));

  const text = await generateText({
    system: "You plan file structures for a coding agent. Return ONLY a fenced ```json block, no prose outside it.",
    prompt: `Given this technical spec, declare which NEW Python files should be created for this campaign's self-contained FastAPI feature module.

Spec:
${guideText}

Rules:
- Every path MUST start with one of these allowed prefixes: ${allowlist.join(" or ")}
- All files must be Python (.py). Include an "__init__.py" for the package, plus files such as router.py, schemas.py, service.py as needed.
- Propose 2-6 files. Do NOT reference or modify any existing file.
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

  const allowlist = resolveAllowlist(config.writePathAllowlistTemplates, packageSlug(state.request.slug));
  const manifestPaths = new Set(state.fileManifest.filesToCreate.map((f) => f.path));

  const systemPrompt = `You are a coding agent adding a new, self-contained feature module to an existing FastAPI (Python) backend repository.

GUARDRAILS (enforced in code, not just instructions):
- You may ONLY create files under: ${allowlist.join(", ")}
- You may ONLY create files declared in the plan below — nothing else.
- You can NEVER modify or overwrite a file that already existed in this repository.
- You have no shell access. Explore with list_files/read_file, write with write_file, and call finish_coding when done.

Explore the repository first (pyproject.toml, app/main.py, an existing router under app/api, app/schemas, app/services) so your new code matches its real conventions (FastAPI APIRouter, Pydantic v2 models, import style), THEN create the planned files.

The module MUST be self-contained: it must import ONLY from the Python standard library, third-party packages already declared in pyproject.toml, and files you create in this same module. Do NOT import the app's existing DB session/config or modify any existing file — nothing else imports your module yet. Every file must be valid, ruff-clean Python (the repo's ruff config gates the PR: sorted imports, no unused imports/names).

FILE PLAN:
${JSON.stringify(state.fileManifest, null, 2)}

TECHNICAL SPEC:
${state.guide}
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
  await log(state.runId, "verify: validating the new files (build/lint, ecosystem-aware)");
  const changedPaths =
    state.writtenByAgent && state.writtenByAgent.size > 0
      ? [...state.writtenByAgent]
      : state.fileManifest.filesToCreate.map((f) => f.path);
  const result = await verifyBuild({
    workdir: state.workdir,
    installTimeoutMs: config.verifyInstallTimeoutMs,
    buildTimeoutMs: config.verifyBuildTimeoutMs,
    changedPaths,
  });
  const verifyAttempts = state.verifyAttempts + 1;
  await runStore.updateRun(state.runId, { verifyAttempts });
  await log(state.runId, `verify: ${result.ok ? "PASSED" : "FAILED"} — ${result.report.slice(0, 300)}`);
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
- [ ] Module is self-contained (imports only stdlib / declared deps / its own files)
- [ ] Endpoints + schemas behave as expected once wired into the app router
- [ ] Copy/claims are accurate
`;
}

async function writeCodegenLog(state, filePath) {
  const fullLog = await runStore.getFullLog(state.runId);
  const content = `# Codegen run ${state.runId}

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
