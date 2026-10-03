import dns from "node:dns";
import express from "express";
import { createSessionAuth, readAuthConfig } from "./auth/session.mjs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import { config } from "./config.mjs";
import { ensureOmnirouteQueueWait } from "./llm/omniroute.mjs";
import { validateBrief } from "./schemas/campaign-brief-schema.mjs";
import * as runStore from "./state/campaign-repository.mjs";
import { runEventsSseHandler } from "./state/run-events-sse.mjs";
import * as draftStore from "./staging/draft-versions.mjs";
import * as preview from "./preview/preview-server.mjs";
import { startPreviewGateway } from "./preview/preview-gateway.mjs";
import { runCodegen } from "./pipeline/run-campaign-pipeline.mjs";
import { resumeInterruptedRuns } from "./pipeline/resume-interrupted-runs.mjs";
import { approveRun, abandonRun, ReviewActionError } from "./pipeline/approve-or-abandon-run.mjs";
import { getPlan, savePlan, approvePlan, abandonAtPlan, PlanActionError } from "./pipeline/approve-or-edit-plan.mjs";
import { listSections, refineSection, refinePage, recolorDraft, RefineActionError } from "./pipeline/refine-section.mjs";
import { removeWorktree } from "./git/clone-and-commit.mjs";
import { HONEYPOT_FIELD_NAME, PREVIEW_LEAD_SINK_PATH } from "./leadform/contract.mjs";
import { uploadManualImage, IMAGE_SLOTS, extFromContentType } from "./assets/campaign-images.mjs";

try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* Node < 16 */
}

const baseDir = path.join(path.resolve(config.workdirRoot), "_base");

const app = express();
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

const authConfig = readAuthConfig();
// Share the validated, isolated preview hostname with preview subprocess helpers.
process.env.PREVIEW_PUBLIC_HOST = authConfig.previewHost;
const auth = createSessionAuth(authConfig);
app.use("/auth", auth.router);
// All campaign routes are centrally protected, including future additions.
app.use("/campaigns", auth.requireSession, (req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    res.on("finish", () => console.log(JSON.stringify({ event: "campaign_action", userId: req.user.id, method: req.method, path: req.baseUrl + req.path, status: res.statusCode })));
  }
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/campaigns", async (_req, res) => {
  const runs = await runStore.listRuns();
  runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(runs);
});

app.post("/campaigns", async (req, res) => {
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

app.get("/campaigns/:runId/log", async (req, res) => {
  const log = await runStore.getFullLog(req.params.runId);
  if (log === null) return res.status(404).json({ error: "not_found" });
  res.type("text/plain").send(log);
});

// Real-time alternative to polling GET /campaigns/:runId + .../log — see
// state/run-events-sse.mjs for the event contract.
app.get("/campaigns/:runId/events", runEventsSseHandler);

app.get("/campaigns/:runId", async (req, res) => {
  const run = await runStore.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "not_found" });
  res.json(run);
});

/* The brief a run was created from, so the UI can pre-fill a new campaign
 * from an old one. Marketing runs variations of the same campaign constantly,
 * and retyping every field was the sharpest daily friction in the old flow.
 * Deliberately returns the brief ALONE rather than reusing GET /campaigns/:runId
 * — duplicating pulls in nothing about the previous run's outcome. */
app.get("/campaigns/:runId/brief", async (req, res) => {
  const run = await runStore.getRun(req.params.runId);
  if (!run?.request) return res.status(404).json({ error: "not_found" });
  // The slug is unique per campaign page: handing back the old one would
  // guarantee a collision, so the caller is made to choose a new one.
  const { slug: _slug, ...reusable } = run.request;
  res.json(reusable);
});

app.get("/campaigns/:runId/draft", async (req, res) => {
  const draft = await draftStore.getLatestVersion(req.params.runId);
  if (!draft && !(await runStore.getRun(req.params.runId))) return res.status(404).json({ error: "not_found" });
  // An existing run can legitimately have no draft yet.
  res.json(draft ?? null);
});

/* Manual campaign-image upload (review UI).
 * Content-Type: image/jpeg | image/png | image/webp  (raw binary body).
 * Replaces the Pexels/SerpAPI image for the given slot, updates
 * researchNotes, and patches all staged draft files so the new URL is
 * immediately reflected in the preview without a full regeneration. */
app.post(
  "/campaigns/:runId/images/:slot",
  express.raw({ type: ["image/jpeg", "image/jpg", "image/png", "image/webp"], limit: "10mb" }),
  async (req, res) => {
    const { runId, slot } = req.params;
    if (!IMAGE_SLOTS.includes(slot)) {
      return res.status(400).json({ error: "invalid_slot", message: `Slot must be one of: ${IMAGE_SLOTS.join(", ")}` });
    }

    const run = await runStore.getRun(runId);
    if (!run) return res.status(404).json({ error: "not_found" });

    const mime = req.headers["content-type"]?.split(";")[0].trim() ?? "";
    const mimeInfo = extFromContentType(mime);
    if (!mimeInfo) {
      return res.status(400).json({ error: "unsupported_type", message: "Supported types: image/jpeg, image/png, image/webp" });
    }

    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      return res.status(503).json({ error: "no_storage", message: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured." });
    }

    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length < 100) {
      return res.status(400).json({ error: "empty_body", message: "Request body must be raw image bytes." });
    }

    let publicUrl;
    try {
      publicUrl = await uploadManualImage({
        bytes,
        mime: mimeInfo.mime,
        slug: run.slug ?? runId,
        slot,
        supabaseUrl: config.supabaseUrl,
        supabaseServiceRoleKey: config.supabaseServiceRoleKey,
        supabaseStorageBucket: config.supabaseStorageBucket,
      });
    } catch (err) {
      console.error(`POST /campaigns/${runId}/images/${slot} — upload error:`, err.message);
      return res.status(502).json({ error: "upload_failed", message: err.message });
    }

    // Build the updated image record for this slot.
    const newImage = {
      slot,
      query: "manual-upload",
      source: "manual",
      publicUrl,
      width: 1200,
      height: 800,
      alt: `${slot} image`,
    };

    // Update researchNotes.images — replace existing slot entry or append.
    const notes = run.researchNotes ?? {};
    const existingImages = Array.isArray(notes.images) ? notes.images : [];
    const oldEntry = existingImages.find((img) => img?.slot === slot);
    const oldUrl = oldEntry?.publicUrl ?? null;
    const updatedImages = [...existingImages.filter((img) => img?.slot !== slot), newImage];
    await runStore.updateRun(runId, { researchNotes: { ...notes, images: updatedImages } });

    // Patch staged draft files: replace old URL with new one so the preview
    // updates without a full regeneration.
    if (oldUrl && oldUrl !== publicUrl) {
      try {
        const draft = await draftStore.getLatestVersion(runId);
        if (draft) {
          const patched = draft.files.map((f) => ({
            ...f,
            content: f.content.includes(oldUrl) ? f.content.split(oldUrl).join(publicUrl) : f.content,
          }));
          const changed = patched.filter((f, i) => f.content !== draft.files[i].content);
          if (changed.length > 0) {
            await draftStore.stageNewVersion({ runId, files: patched });
            console.log(`POST /campaigns/${runId}/images/${slot} — patched ${changed.length} draft file(s) with new URL`);
          }
        }
      } catch (patchErr) {
        console.warn(`POST /campaigns/${runId}/images/${slot} — draft patch failed (non-fatal): ${patchErr.message}`);
      }
    }

    console.log(`POST /campaigns/${runId}/images/${slot} — uploaded ${bytes.length} bytes → ${publicUrl}`);
    res.json({ ok: true, slot, publicUrl, image: newImage });
  }
);

app.get("/campaigns/:runId/preview", async (req, res) => {
  const p = await preview.getPreview(req.params.runId);
  if (!p && !(await runStore.getRun(req.params.runId))) return res.status(404).json({ error: "not_found" });
  // Absent/expired previews are normal, rather than missing campaigns.
  res.json(p ?? null);
});

// Phase 8 (new_plan.md §4.8/§6) — where every generated hero's lead form
// POSTs in preview mode (leadform/contract.mjs's prompt fragment tells the
// coding agent to target this exact URL). Deliberately NO auth — it's
// called from a browser rendering the previewed page, which has no access
// to the application session — and deliberately a no-op: logs the submission and
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

app.post("/campaigns/:runId/preview/stop", async (req, res) => {
  const result = await preview.stopPreview({ runId: req.params.runId, baseDir });
  if (!result.ok) return res.status(404).json({ error: "not_found" });
  res.status(204).send();
});

/* Restart a preview after it expired or was stopped. Available once a draft
 * has been staged and the scratch worktree is still on disk (approve/abandon
 * remove it). Auto-start at the end of a run is unchanged. */
app.post("/campaigns/:runId/preview/start", async (req, res) => {
  const run = await runStore.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "not_found" });
  if (run.status !== "staged_for_review") {
    return res.status(409).json({
      error: "wrong_status",
      message: `Preview can only be (re)started while the draft is staged for review (status is "${run.status}").`,
    });
  }
  if (!run.workdir) {
    return res.status(409).json({ error: "no_workdir", message: "This run has no scratch worktree left to serve a preview from." });
  }
  const draft = await draftStore.getLatestVersion(req.params.runId);
  if (!draft) {
    return res.status(409).json({ error: "no_draft", message: "No staged draft to preview yet." });
  }

  const pageUrlPath = config.pageUrlPathTemplate
    ? config.pageUrlPathTemplate.replaceAll("{slug}", run.slug)
    : null;
  const result = await preview.restartPreview({
    runId: req.params.runId,
    workdir: run.workdir,
    pageUrlPath,
    ttlMs: config.previewTtlMs,
    maxConcurrent: config.maxConcurrentPreviews,
    disableDocker: config.verifyDisableDocker,
    baseDir,
  });
  if (!result.ok) {
    return res.status(500).json({ error: "preview_start_failed", message: result.report });
  }
  const live = await preview.getPreview(req.params.runId);
  res.json(live ?? {
    kind: result.kind,
    url: result.url,
    status: "running",
    expiresAt: result.expiresAt,
    embedUrl: result.embedUrl ?? null,
  });
});

// Phase 9 / module.md Module 4 (new_plan.md §9.7) — per-section refinement
// IS the review step: no separate raw-file editor, just these two routes.
app.get("/campaigns/:runId/sections", async (req, res) => {
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

app.post("/campaigns/:runId/sections/:slot/refine", async (req, res) => {
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

// Page-level AI edit — one plain-language request can rewrite several sections,
// then verify / stage / refresh preview once (marketing review loop).
app.post("/campaigns/:runId/refine-page", async (req, res) => {
  const instructions = req.body?.instructions;
  console.log(`POST /campaigns/${req.params.runId}/refine-page — ${(instructions ?? "").slice(0, 80)}`);
  try {
    const result = await refinePage(req.params.runId, { instructions });
    res.json(result);
  } catch (err) {
    if (err instanceof RefineActionError) {
      const status = err.reason === "not_found" ? 404 : err.reason === "wrong_status" ? 409 : err.reason === "verify_failed" ? 422 : 400;
      return res.status(status).json({ error: err.reason, message: err.message });
    }
    res.status(500).json({ error: "refine_failed", message: err.message });
  }
});

app.post("/campaigns/:runId/color-scheme", async (req, res) => {
  console.log(`POST /campaigns/${req.params.runId}/color-scheme`);
  try {
    const result = await recolorDraft(req.params.runId, req.body?.colorScheme);
    res.json(result);
  } catch (err) {
    if (err instanceof RefineActionError) {
      const status = err.reason === "not_found" ? 404 : err.reason === "wrong_status" ? 409 : err.reason === "verify_failed" ? 422 : 400;
      return res.status(status).json({ error: err.reason, message: err.message });
    }
    res.status(500).json({ error: "recolor_failed", message: err.message });
  }
});

/* The plan gate (v0.37) — the human step BEFORE generation, as opposed to
 * approve/abandon below, which is the human step before git. GET is allowed at
 * any status (the plan stays worth reading after the fact); PATCH/approve/
 * abandon require `awaiting_plan_approval` and 409 otherwise, matching the
 * approve/abandon guards. See pipeline/approve-or-edit-plan.mjs. */
function handlePlanError(err, res, fallback) {
  if (err instanceof PlanActionError) {
    const status = err.reason === "not_found" ? 404 : err.reason === "invalid_plan" ? 400 : 409;
    return res.status(status).json({ error: err.reason, message: err.message, issues: err.message });
  }
  res.status(500).json({ error: fallback, message: err.message });
}

app.get("/campaigns/:runId/plan", async (req, res) => {
  try {
    res.json(await getPlan(req.params.runId));
  } catch (err) {
    handlePlanError(err, res, "plan_read_failed");
  }
});

app.patch("/campaigns/:runId/plan", async (req, res) => {
  console.log(`PATCH /campaigns/${req.params.runId}/plan`);
  try {
    res.json({ ok: true, guide: await savePlan(req.params.runId, req.body) });
  } catch (err) {
    handlePlanError(err, res, "plan_save_failed");
  }
});

app.post("/campaigns/:runId/plan/approve", async (req, res) => {
  console.log(`POST /campaigns/${req.params.runId}/plan/approve`);
  try {
    // An edited plan may ride along, so "save then approve" is one atomic
    // action rather than two requests that could half-apply.
    res.json(await approvePlan(req.params.runId, { guide: req.body?.guide ?? null }));
  } catch (err) {
    handlePlanError(err, res, "plan_approve_failed");
  }
});

app.post("/campaigns/:runId/plan/abandon", async (req, res) => {
  console.log(`POST /campaigns/${req.params.runId}/plan/abandon`);
  try {
    res.json(await abandonAtPlan(req.params.runId));
  } catch (err) {
    handlePlanError(err, res, "plan_abandon_failed");
  }
});

// Phase 7 (new_plan.md §6/§9.9) — the human approval gate. Nothing this
// service generates reaches git before one of these two is called.
app.post("/campaigns/:runId/approve", async (req, res) => {
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

app.post("/campaigns/:runId/abandon", async (req, res) => {
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

app.delete("/campaigns/:runId", async (req, res) => {
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

if (config.previewGatewayPort) {
  // Fails startup loudly if the port is taken — a gateway that silently
  // didn't start would leave every preview unreachable with no clue why.
  await startPreviewGateway({ port: config.previewGatewayPort, host: config.previewGatewayHost, domain: authConfig.previewHost });
  console.log(`Preview gateway listening on ${config.previewGatewayHost}:${config.previewGatewayPort} (http://<token>.${authConfig.previewHost}:${config.previewGatewayPort})`);
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

// `npm run dev` runs node with --watch, which restarts this process whenever
// ANY file under src/ changes. A campaign run takes minutes (clone -> LLM ->
// npm ci -> next build), so editing a source file mid-run kills that run —
// almost always during verify, the longest stage. Runs then come back as
// "restarted while at stage verify" in the log, which looks like a build
// failure but is really this. Loud, because it is not obvious from the symptom.
// In watch mode Node runs the script in a CHILD process, so --watch never
// appears in that child's execArgv; it marks the child with
// WATCH_REPORT_DEPENDENCIES instead. Both signals are checked so this keeps
// working if either changes.
const isWatchMode = process.execArgv.some((arg) => arg.startsWith("--watch")) || Boolean(process.env.WATCH_REPORT_DEPENDENCIES);
if (isWatchMode) {
  console.warn(
    "\n⚠  Running with --watch (npm run dev).\n" +
      "   Editing any file under src/ RESTARTS this process and kills any campaign\n" +
      "   run in flight — typically mid-verify, which looks like a build failure.\n" +
      "   Use `npm start` when running real campaigns.\n" +
      "   (--watch also sets WATCH_REPORT_DEPENDENCIES, which used to break every\n" +
      "    `next build` we spawned. That is now stripped from child processes —\n" +
      "    see src/spawn-env.mjs — but the restart problem above is still real.)\n"
  );
}

app.listen(config.port, () => {
  console.log(`campaign-codegen-pr-service listening on :${config.port}`);
  console.log(`Target repo: ${config.github.owner}/${config.github.repo}@${config.github.baseBranch}`);
  console.log(`AI providers: research=${config.aiProvider}  coding-agent=${config.codingAgentProvider}`);
  if (config.aiProvider === "omniroute" || config.codingAgentProvider === "omniroute") {
    ensureOmnirouteQueueWait().catch(() => {});
  }
});
