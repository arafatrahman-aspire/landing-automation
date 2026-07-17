import express from "express";
import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { validateBrief } from "./schemas/brief-schema.mjs";
import * as runStore from "./state/run-store.mjs";
import { runCodegen } from "./orchestrator/graph.mjs";

const app = express();
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

app.post("/campaigns", isAuthorized, async (req, res) => {
  const result = validateBrief(req.body);
  if (!result.ok) {
    console.log(`POST /campaigns — validation failed: ${result.errors}`);
    return res.status(400).json({ error: "invalid_request", issues: result.errors });
  }

  const runId = randomUUID();
  const { slug, campaignName } = result.value;
  console.log(`POST /campaigns — run ${runId}  slug=${slug}  name="${campaignName}"`);
  await runStore.createRun({ runId, slug });

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
