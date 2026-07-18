import { mkdir, readFile, writeFile, appendFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.mjs";

/* Filesystem-only run tracking — no database (deliberate: GitHub itself, via
 * the resulting PR, is the durable record; this is just in-flight status for
 * the HTTP API). One JSON file per run (bounded log tail) + one plain-text
 * .log file (unbounded, for GET /campaigns/:id/log). Reads/writes to the same
 * run are serialized through a per-runId promise chain — sufficient
 * correctness for a single always-on process with no external DB. */

const LOG_TAIL_LIMIT = 50;
const TERMINAL_STATUSES = new Set(["completed", "failed", "failed_clone", "failed_verification", "failed_push", "failed_push_incomplete"]);

const writeChains = new Map(); // runId -> Promise, serializes read-modify-write

function jsonPath(runId) {
  return path.join(config.runStateDir, `${runId}.json`);
}
function logPath(runId) {
  return path.join(config.runStateDir, `${runId}.log`);
}

async function withRunLock(runId, fn) {
  const prior = writeChains.get(runId) ?? Promise.resolve();
  const next = prior.then(fn, fn); // run fn regardless of prior outcome
  writeChains.set(runId, next.catch(() => {})); // don't let one failure poison the chain
  return next;
}

export async function createRun({ runId, slug, campaignName }) {
  await mkdir(config.runStateDir, { recursive: true });
  const now = new Date().toISOString();
  const record = {
    runId,
    slug,
    campaignName: campaignName ?? null,
    status: "queued",
    stage: "intake",
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    codeAttempts: 0,
    verifyAttempts: 0,
    branchName: null,
    prUrl: null,
    prNumber: null,
    logTail: [],
    error: null,
  };
  await writeFile(jsonPath(runId), JSON.stringify(record, null, 2));
  await writeFile(logPath(runId), `[${now}] run created (slug=${slug})\n`);
  return record;
}

export async function getRun(runId) {
  try {
    const raw = await readFile(jsonPath(runId), "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function updateRun(runId, patch) {
  return withRunLock(runId, async () => {
    const current = await getRun(runId);
    if (!current) throw new Error(`updateRun: no such run "${runId}"`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await writeFile(jsonPath(runId), JSON.stringify(next, null, 2));
    return next;
  });
}

export async function heartbeat(runId, stage) {
  return updateRun(runId, { heartbeatAt: new Date().toISOString(), ...(stage ? { stage } : {}) });
}

export async function appendLog(runId, level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  await appendFile(logPath(runId), line + "\n").catch(() => {});
  return withRunLock(runId, async () => {
    const current = await getRun(runId);
    if (!current) return null;
    const logTail = [...current.logTail, { ts: new Date().toISOString(), level, message }].slice(-LOG_TAIL_LIMIT);
    const next = { ...current, logTail, updatedAt: new Date().toISOString() };
    await writeFile(jsonPath(runId), JSON.stringify(next, null, 2));
    return next;
  });
}

export async function getFullLog(runId) {
  try {
    return await readFile(logPath(runId), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function listRuns() {
  await mkdir(config.runStateDir, { recursive: true });
  const files = (await readdir(config.runStateDir)).filter((f) => f.endsWith(".json"));
  return Promise.all(files.map((f) => readFile(path.join(config.runStateDir, f), "utf8").then(JSON.parse)));
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

/** Deletes a run's record + log. Only permitted once the run has reached a
 *  terminal status — deleting mid-run would pull the JSON file out from
 *  under the in-flight graph.invoke(), which calls updateRun/heartbeat
 *  throughout and would throw ("no such run") the moment it did. This never
 *  touches anything already pushed to git/GitHub — it only removes this
 *  service's own local bookkeeping for the run. */
export async function deleteRun(runId) {
  const current = await getRun(runId);
  if (!current) return { ok: false, reason: "not_found" };
  if (!isTerminal(current.status)) return { ok: false, reason: "not_terminal", status: current.status };
  await Promise.all([unlink(jsonPath(runId)).catch(() => {}), unlink(logPath(runId)).catch(() => {})]);
  writeChains.delete(runId);
  return { ok: true };
}

/** Startup crash recovery (§8): any run still non-terminal from a previous
 *  process lifetime cannot be resumed (no checkpointing in v1) — mark it
 *  failed. If it had already pushed a branch, surface that distinctly so a
 *  human can open the PR manually instead of losing the work silently. */
export async function reconcileCrashedRuns() {
  const runs = await listRuns();
  let reconciled = 0;
  for (const run of runs) {
    if (isTerminal(run.status)) continue;
    const wasPushing = run.status === "pushing" || run.status === "opening_pr";
    await updateRun(run.runId, {
      status: wasPushing && run.branchName ? "failed_push_incomplete" : "failed",
      error: wasPushing && run.branchName
        ? `Process restarted after pushing branch "${run.branchName}" but before confirming the PR — check GitHub, a PR may need to be opened manually.`
        : "Process restarted while this run was in progress; it was not resumed.",
    });
    reconciled++;
  }
  return reconciled;
}
