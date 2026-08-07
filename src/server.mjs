import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import { config } from "./config.mjs";
import { validateBrief } from "./schemas/campaign-brief-schema.mjs";
import * as runStore from "./state/campaign-repository.mjs";
import * as draftStore from "./staging/draft-versions.mjs";
import * as preview from "./preview/preview-server.mjs";
import { runCodegen } from "./pipeline/run-campaign-pipeline.mjs";
import { resumeInterruptedRuns } from "./pipeline/resume-interrupted-runs.mjs";
import { approveRun, abandonRun, ReviewActionError } from "./pipeline/approve-or-abandon-run.mjs";
import { listSections, refineSection, RefineActionError } from "./pipeline/refine-section.mjs";
import { removeWorktree } from "./git/clone-and-commit.mjs";
import { HONEYPOT_FIELD_NAME, PREVIEW_LEAD_SINK_PATH } from "./leadform/contract.mjs";

const baseDir = path.join(path.resolve(config.workdirRoot), "_base");

const app = express();
// The UI (Vite dev server on a different origin) needs to send the
// Authorization header cross-origin — reflect the origin, allow that header.
app.use(cors({ origin: true, allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

function isAuthorized(req, res, next) {
  const header = req.headers.authorization ?? "";
  if (header !== `Bearer ${config.apiSharedSecret}`) {
    console.warn(`${new Date().toISOString()} AUTH FAILED from ${req.ip}`);
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/campaigns", isAuthorized, async (_req, res) => {
  const runs = await runStore.listRuns();
  runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(runs);
});

app.post("/campaigns", isAuthorized, async (req, res) => {
  const result = validateBrief(req.body);
  if (!result.ok) {
    console.log(`POST /campaigns — validation failed: ${result.errors}`);
    return res.status(400).json({ error: "invalid_request", issues: result.errors });
  }

  const runId = randomUUID();
  const { slug, campaignName } = result.value;
  console.log(`POST /campaigns — run ${runId}  slug=${slug}  name="${campaignName}"`);
  await runStore.createRun({ runId, slug, campaignName, request: result.value });

  runCodegen({ runId, request: result.value }).catch((err) => {
    console.error(`[run ${runId}] unhandled failure:`, err.message);
  });

  res.status(202).json({ runId, status: "queued", statusUrl: `/campaigns/${runId}` });
});

app.get("/campaigns/:runId/log", isAuthorized, async (req, res) => {
  const log = await runStore.getFullLog(req.params.runId);
  if (log === null) return res.status(404).json({ error: "not_found" });
  res.type("text/plain").send(log);
});

app.get("/campaigns/:runId", isAuthorized, async (req, res) => {
  const run = await runStore.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "not_found" });
  res.json(run);
});

app.get("/campaigns/:runId/draft", isAuthorized, async (req, res) => {
  const draft = await draftStore.getLatestVersion(req.params.runId);
  if (!draft) return res.status(404).json({ error: "not_found" });
  res.json(draft);
});

app.get("/campaigns/:runId/preview", isAuthorized, async (req, res) => {
  const p = await preview.getPreview(req.params.runId);
  if (!p) return res.status(404).json({ error: "not_found" });
  res.json(p);
});

// Phase 8 (new_plan.md §4.8/§6) — where every generated hero's lead form
// POSTs in preview mode (leadform/contract.mjs's prompt fragment tells the
// coding agent to target this exact URL). Deliberately NO auth — it's
// called from a browser rendering the previewed page, which has no access
// to API_SHARED_SECRET — and deliberately a no-op: logs the submission and
// returns success, never delivers anywhere. Real delivery to the parent
// platform's lead-intake pipeline is a separate, external dependency, not
// built here (new_plan.md §4.8).
app.post(PREVIEW_LEAD_SINK_PATH, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "invalid_body" });
  }
  const isHoneypotTripped = typeof body[HONEYPOT_FIELD_NAME] === "string" && body[HONEYPOT_FIELD_NAME].trim() !== "";
  if (isHoneypotTripped) {
    // Never reveal detection to the caller — still 200, just don't
    // "process" it. Logged distinctly so a human can tell the difference.
    console.log(`POST ${PREVIEW_LEAD_SINK_PATH} — honeypot tripped, discarding:`, JSON.stringify(body));
    return res.json({ ok: true });
  }
  const { [HONEYPOT_FIELD_NAME]: _honeypot, ...fields } = body;
  console.log(`POST ${PREVIEW_LEAD_SINK_PATH} — preview lead captured (no-op, not delivered anywhere):`, JSON.stringify(fields));
  res.json({ ok: true });
});

app.post("/campaigns/:runId/preview/stop", isAuthorized, async (req, res) => {
  const result = await preview.stopPreview({ runId: req.params.runId, baseDir });
  if (!result.ok) return res.status(404).json({ error: "not_found" });
  res.status(204).send();
});

// Phase 9 / module.md Module 4 (new_plan.md §9.7) — per-section refinement
// IS the review step: no separate raw-file editor, just these two routes.
app.get("/campaigns/:runId/sections", isAuthorized, async (req, res) => {
  try {
    const sections = await listSections(req.params.runId);
    res.json(sections);
  } catch (err) {
    if (err instanceof RefineActionError && err.reason === "not_found") {
      return res.status(404).json({ error: "not_found" });
    }
    res.status(500).json({ error: "internal_error", message: err.message });
  }
});

app.post("/campaigns/:runId/sections/:slot/refine", isAuthorized, async (req, res) => {
  const { action, ...params } = req.body ?? {};
  console.log(`POST /campaigns/${req.params.runId}/sections/${req.params.slot}/refine — action=${action}`);
  try {
    const result = await refineSection(req.params.runId, req.params.slot, action, params);
    res.json(result);
  } catch (err) {
    if (err instanceof RefineActionError) {
      const status = err.reason === "not_found" ? 404 : err.reason === "wrong_status" ? 409 : err.reason === "verify_failed" ? 422 : 400;
      return res.status(status).json({ error: err.reason, message: err.message });
    }
    res.status(500).json({ error: "refine_failed", message: err.message });
  }
});

// Phase 7 (new_plan.md §6/§9.9) — the human approval gate. Nothing this
// service generates reaches git before one of these two is called.
app.post("/campaigns/:runId/approve", isAuthorized, async (req, res) => {
  console.log(`POST /campaigns/${req.params.runId}/approve`);
  try {
    const result = await approveRun(req.params.runId);
    res.json(result);
  } catch (err) {
    if (err instanceof ReviewActionError) {
      const status = err.reason === "not_found" ? 404 : 409;
      return res.status(status).json({ error: err.reason, message: err.message });
    }
    res.status(500).json({ error: "approve_failed", message: err.message });
  }
});

app.post("/campaigns/:runId/abandon", isAuthorized, async (req, res) => {
  console.log(`POST /campaigns/${req.params.runId}/abandon`);
  try {
    const result = await abandonRun(req.params.runId);
    res.json(result);
  } catch (err) {
    if (err instanceof ReviewActionError) {
      const status = err.reason === "not_found" ? 404 : 409;
      return res.status(status).json({ error: err.reason, message: err.message });
    }
    res.status(500).json({ error: "abandon_failed", message: err.message });
  }
});

app.delete("/campaigns/:runId", isAuthorized, async (req, res) => {
  const existing = await runStore.getRun(req.params.runId);
  const result = await runStore.deleteRun(req.params.runId);
  if (!result.ok && result.reason === "not_found") {
    return res.status(404).json({ error: "not_found" });
  }
  if (!result.ok && result.reason === "not_terminal") {
    return res.status(409).json({
      error: "not_terminal",
      status: result.status,
      message: "Only a completed or failed run can be deleted — this one is still in progress.",
    });
  }
  // A still-running preview bind-mounts/reads from this exact workdir — stop
  // it (proper process/container teardown) before removing the worktree out
  // from under it, rather than just deleting the directory and orphaning a
  // live process/container.
  await preview.stopPreview({ runId: req.params.runId, baseDir }).catch(() => {});
  // Best-effort: the scratch workdir is normally already removed by the time
  // a run reaches completed/failed*, but KEEP_WORKDIR_ON_FAILURE=true, an
  // active preview deferring cleanup, or a crash mid-cleanup can leave it
  // behind — clear it out on delete too. It's a git worktree off the shared
  // base clone (data/.scratch/_base), so it must be removed via `git
  // worktree remove`, not a raw rm, or the base clone is left with stale
  // worktree metadata.
  const workdir = path.join(path.resolve(config.workdirRoot), req.params.runId);
  await removeWorktree({ baseDir, workdir, branchName: existing?.branchName }).catch(() => {});
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
  console.log(`DELETE /campaigns/${req.params.runId} — removed`);
  res.status(204).send();
});

app.use((err, _req, res, _next) => {
  console.error(`${new Date().toISOString()} ERROR:`, err.message);
  res.status(500).json({ error: "internal_error", message: err.message });
});

// Boot-time triage of runs a previous process lifetime left behind. Runs
// awaiting review are deliberately untouched (their work is done and staged);
// runs mid-commit/push are marked for manual attention; everything else
// mid-generation is safe to re-drive.
const { failed, resumable } = await runStore.reconcileCrashedRuns();
if (failed > 0) {
  console.log(`Startup: marked ${failed} run(s) from a previous lifetime as failed (they were mid-commit/push and can't be safely re-driven).`);
}
if (resumable.length > 0) {
  if (config.resumeInterruptedRuns) {
    const { resumed, skipped } = await resumeInterruptedRuns({
      runIds: resumable,
      logger: (msg) => console.log(`Startup: ${msg}`),
    });
    console.log(`Startup: resumed ${resumed} interrupted run(s)${skipped > 0 ? `, skipped ${skipped}` : ""}.`);
  } else {
    for (const runId of resumable) {
      await runStore.updateRun(runId, {
        status: "failed",
        error: "Process restarted while this run was in progress; automatic resume is disabled (RESUME_INTERRUPTED_RUNS=false).",
      });
    }
    console.log(`Startup: marked ${resumable.length} interrupted run(s) failed (RESUME_INTERRUPTED_RUNS=false).`);
  }
}

// Any preview still 'running' in the DB is from a previous process
// lifetime and can't be trusted (this service doesn't resume across
// restarts) — same reasoning as reconcileCrashedRuns above, applied to
// previews instead of runs.
const reconciledPreviews = await preview.reconcilePreviewsOnBoot({ baseDir });
if (reconciledPreviews > 0) {
  console.log(`Startup: stopped ${reconciledPreviews} preview(s) left running from a previous process lifetime.`);
}

setInterval(() => {
  preview.sweepIdlePreviews({ baseDir }).catch((err) => {
    console.error("preview sweep failed:", err.message);
  });
}, config.previewSweepIntervalMs).unref();

app.listen(config.port, () => {
  console.log(`campaign-codegen-pr-service listening on :${config.port}`);
  console.log(`Target repo: ${config.github.owner}/${config.github.repo}@${config.github.baseBranch}`);
  console.log(`AI providers: research=${config.aiProvider}  coding-agent=${config.codingAgentProvider}`);
});
