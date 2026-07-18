import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import { config } from "./config.mjs";
import { validateBrief } from "./schemas/brief-schema.mjs";
import * as runStore from "./state/run-store.mjs";
import { runCodegen } from "./orchestrator/graph.mjs";

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
  await runStore.createRun({ runId, slug, campaignName });

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

app.delete("/campaigns/:runId", isAuthorized, async (req, res) => {
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
  // Best-effort: the scratch workdir is normally already removed by the time
  // a run reaches completed/failed*, but KEEP_WORKDIR_ON_FAILURE=true (or a
  // crash mid-cleanup) can leave it behind — clear it out on delete too.
  const workdir = path.join(path.resolve(config.workdirRoot), req.params.runId);
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
  console.log(`DELETE /campaigns/${req.params.runId} — removed`);
  res.status(204).send();
});

app.use((err, _req, res, _next) => {
  console.error(`${new Date().toISOString()} ERROR:`, err.message);
  res.status(500).json({ error: "internal_error", message: err.message });
});

const reconciled = await runStore.reconcileCrashedRuns();
if (reconciled > 0) {
  console.log(`Startup: marked ${reconciled} run(s) from previous lifetime as failed (no resume in v1).`);
}

app.listen(config.port, () => {
  console.log(`campaign-codegen-pr-service listening on :${config.port}`);
  console.log(`Target repo: ${config.github.owner}/${config.github.repo}@${config.github.baseBranch}`);
  console.log(`AI providers: research=${config.aiProvider}  coding-agent=${config.codingAgentProvider}`);
});
