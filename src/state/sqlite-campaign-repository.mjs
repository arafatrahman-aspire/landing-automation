import { getDb } from "./database-connection.mjs";

/* SQLite-backed replacement for the old flat-JSON run-store — same function
 * names/signatures as before (createRun, getRun, updateRun, heartbeat,
 * appendLog, getFullLog, listRuns, isTerminal, deleteRun,
 * reconcileCrashedRuns), so every call site elsewhere in the app only had
 * to change its import path, not its usage. state/campaign-repository.mjs re-exports
 * this module — that's the one indirection point a future backend swap
 * (e.g. Supabase) would need to change. */

// "staged_for_review" is deliberately NOT terminal — the run is paused
// awaiting a human decision (Phase 7), not finished; DELETE stays a 409
// until it's explicitly approved or abandoned.
const TERMINAL_STATUSES = new Set(["completed", "failed", "failed_clone", "failed_verification", "failed_push", "failed_push_incomplete", "abandoned"]);

// camelCase patch key -> runs column (JSON_COLUMNS get JSON.stringify'd on
// write and JSON.parse'd back on read; everything else is a plain scalar).
const COLUMN_MAP = {
  status: "status",
  stage: "stage",
  heartbeatAt: "heartbeat_at",
  codeAttempts: "code_attempts",
  verifyAttempts: "verify_attempts",
  branchName: "branch_name",
  prUrl: "pr_url",
  prNumber: "pr_number",
  error: "error",
  // Populated by clone() from Phase 4 onward — preview/preview-server.mjs needs it
  // to reconstruct a run's worktree path from the DB alone (its sweep runs
  // independently of any in-process LangGraph state).
  workdir: "workdir",
  agentSummary: "agent_summary",
  // Set when a draft was staged despite a failing build (CONTINUE_ON_VERIFY_FAILURE).
  verifyBypassed: "verify_bypassed",
};
const JSON_COLUMNS = {
  guide: "guide_json",
  sectionReferences: "section_references_json",
  verifyChecks: "verify_checks_json",
  // Phase 7 — see state/database-schema.mjs's comment on these columns.
  sectionResults: "section_results_json",
  // Crash resume: lets a resumed run skip the research LLM call it already paid for.
  researchNotes: "research_notes_json",
};

function rowToRun(campaignRow, runRow, logTail) {
  if (!campaignRow || !runRow) return null;
  return {
    runId: runRow.run_id,
    slug: campaignRow.slug,
    campaignName: campaignRow.campaign_name,
    request: campaignRow.brief_json ? JSON.parse(campaignRow.brief_json) : null,
    status: runRow.status,
    stage: runRow.stage,
    createdAt: runRow.created_at,
    updatedAt: runRow.updated_at,
    heartbeatAt: runRow.heartbeat_at,
    codeAttempts: runRow.code_attempts,
    verifyAttempts: runRow.verify_attempts,
    branchName: runRow.branch_name,
    prUrl: runRow.pr_url,
    prNumber: runRow.pr_number,
    error: runRow.error,
    workdir: runRow.workdir,
    guide: runRow.guide_json ? JSON.parse(runRow.guide_json) : null,
    researchNotes: runRow.research_notes_json ? JSON.parse(runRow.research_notes_json) : null,
    sectionReferences: runRow.section_references_json ? JSON.parse(runRow.section_references_json) : null,
    verifyChecks: runRow.verify_checks_json ? JSON.parse(runRow.verify_checks_json) : null,
    agentSummary: runRow.agent_summary,
    verifyBypassed: Boolean(runRow.verify_bypassed),
    sectionResults: runRow.section_results_json ? JSON.parse(runRow.section_results_json) : null,
    logTail: logTail ?? [],
  };
}

export async function createRun({ runId, slug, campaignName, request }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO campaigns (run_id, slug, campaign_name, brief_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
    runId,
    slug,
    campaignName ?? null,
    request ? JSON.stringify(request) : null,
    now
  );
  db.prepare(
    `INSERT INTO runs (run_id, status, stage, created_at, updated_at, heartbeat_at, code_attempts, verify_attempts)
     VALUES (?, 'queued', 'intake', ?, ?, ?, 0, 0)`
  ).run(runId, now, now, now);
  db.prepare("INSERT INTO run_logs (run_id, ts, level, message) VALUES (?, ?, 'info', ?)").run(
    runId,
    now,
    `run created (slug=${slug})`
  );
  return getRun(runId);
}

export async function getRun(runId) {
  const db = getDb();
  const campaignRow = db.prepare("SELECT * FROM campaigns WHERE run_id = ?").get(runId);
  const runRow = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
  if (!campaignRow || !runRow) return null;
  const logTail = db
    .prepare("SELECT ts, level, message FROM run_logs WHERE run_id = ? ORDER BY id DESC LIMIT 50")
    .all(runId)
    .reverse();
  return rowToRun(campaignRow, runRow, logTail);
}

export async function updateRun(runId, patch) {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId);
  if (!exists) throw new Error(`updateRun: no such run "${runId}"`);

  const sets = ["updated_at = ?"];
  const params = [new Date().toISOString()];
  for (const [key, value] of Object.entries(patch)) {
    if (key in COLUMN_MAP) {
      sets.push(`${COLUMN_MAP[key]} = ?`);
      // node:sqlite refuses to bind a JS boolean ("Provided value cannot be
      // bound to SQLite parameter"), and SQLite has no boolean type anyway —
      // store the 0/1 integer it actually uses.
      params.push(typeof value === "boolean" ? Number(value) : value);
    } else if (key in JSON_COLUMNS) {
      sets.push(`${JSON_COLUMNS[key]} = ?`);
      params.push(value == null ? null : JSON.stringify(value));
    }
  }
  params.push(runId);
  db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = ?`).run(...params);
  return getRun(runId);
}

/** Per-attempt verify history. A failing run never reaches stage_draft and its
 *  scratch worktree is disposable, so this is the only durable record of WHY a
 *  given attempt failed — and unlike runs.error it keeps every attempt, not
 *  just the last one. */
export async function recordVerifyReport({ runId, attempt, ok, report, checks }) {
  const db = getDb();
  db.prepare("INSERT INTO verify_reports (run_id, attempt, ok, report, checks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    runId,
    attempt,
    ok ? 1 : 0,
    report ?? null,
    checks ? JSON.stringify(checks) : null,
    new Date().toISOString()
  );
}

/** Every verify attempt for a run, oldest first. */
export async function listVerifyReports(runId) {
  const db = getDb();
  return db
    .prepare("SELECT attempt, ok, report, checks_json, created_at FROM verify_reports WHERE run_id = ? ORDER BY attempt")
    .all(runId)
    .map((r) => ({
      attempt: r.attempt,
      ok: Boolean(r.ok),
      report: r.report,
      checks: r.checks_json ? JSON.parse(r.checks_json) : null,
      createdAt: r.created_at,
    }));
}

export async function heartbeat(runId, stage) {
  return updateRun(runId, { heartbeatAt: new Date().toISOString(), ...(stage ? { stage } : {}) });
}

export async function appendLog(runId, level, message) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO run_logs (run_id, ts, level, message) VALUES (?, ?, ?, ?)").run(runId, now, level, message);
  db.prepare("UPDATE runs SET updated_at = ? WHERE run_id = ?").run(now, runId);
  return getRun(runId);
}

export async function getFullLog(runId) {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId);
  if (!exists) return null;
  const rows = db.prepare("SELECT ts, level, message FROM run_logs WHERE run_id = ? ORDER BY id").all(runId);
  return rows.map((r) => `[${r.ts}] [${r.level}] ${r.message}`).join("\n") + (rows.length ? "\n" : "");
}

export async function listRuns() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.run_id, c.slug, c.campaign_name, r.*
       FROM campaigns c JOIN runs r ON r.run_id = c.run_id`
    )
    .all();
  return rows.map((row) => rowToRun(row, row, []));
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

/** Deletes a run's local record (campaign brief, run state, logs, staged
 *  draft files) — only once terminal, same guarantee as before: pulling the
 *  row out from under an in-flight graph.invoke() would make its next
 *  updateRun/heartbeat throw ("no such run"). Never touches anything
 *  already pushed to git/GitHub. */
export async function deleteRun(runId) {
  const db = getDb();
  const current = await getRun(runId);
  if (!current) return { ok: false, reason: "not_found" };
  if (!isTerminal(current.status)) return { ok: false, reason: "not_terminal", status: current.status };

  db.exec("BEGIN");
  try {
    // Every table with a foreign key to runs must be cleared first — with
    // PRAGMA foreign_keys=ON, leaving any child row behind makes the DELETE
    // fail outright. (This previously only covered draft_files/run_logs, so a
    // run that had ever started a preview could not be deleted at all.)
    for (const table of CHILD_TABLES_OF_RUNS) {
      db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
    }
    db.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM campaigns WHERE run_id = ?").run(runId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { ok: true };
}

/** Startup crash recovery: any run still non-terminal from a previous
 *  process lifetime cannot be resumed (no checkpointing in v1) — mark it
 *  failed, distinguishing "a branch was already pushed" so a human can open
 *  the PR manually instead of losing the work silently. */
/* A run awaiting a human decision is NOT a crashed run — the generation work
 * is finished and its draft is safely in draft_files. Restarting the service
 * used to mark these "failed", throwing away a completed (and paid-for) run
 * just because the process bounced. They're left completely untouched. */
// Every table holding a foreign key to runs(run_id) — kept in one place so
// deleteRun can't silently miss one as the schema grows.
const CHILD_TABLES_OF_RUNS = ["run_logs", "draft_files", "verify_reports", "validation_reports", "previews", "review_decisions", "token_usage"];

const AWAITING_HUMAN_STATUSES = new Set(["staged_for_review"]);

/* Statuses where the run was somewhere inside the approve -> commit -> push
 * -> open-PR sequence. These must NEVER be auto-resumed: re-running them
 * could double-commit or re-push, and we can't tell from here how far the
 * git side actually got. A human looks at these. */
const GIT_PHASE_STATUSES = new Set(["approved", "committing", "pushing", "opening_pr"]);

/**
 * Boot-time triage of runs left behind by a previous process lifetime.
 *
 * @returns {Promise<{failed: number, resumable: string[]}>}
 *   `failed` — git-phase runs marked for manual attention.
 *   `resumable` — mid-generation runs safe to re-run (see pipeline/resume-interrupted-runs.mjs).
 */
export async function reconcileCrashedRuns() {
  const db = getDb();
  const rows = db.prepare(`SELECT run_id, status, stage, branch_name FROM runs WHERE status NOT IN (${[...TERMINAL_STATUSES].map(() => "?").join(",")})`).all(
    ...TERMINAL_STATUSES
  );

  let failed = 0;
  const resumable = [];

  for (const row of rows) {
    if (AWAITING_HUMAN_STATUSES.has(row.status)) continue;

    if (GIT_PHASE_STATUSES.has(row.status) || GIT_PHASE_STATUSES.has(row.stage)) {
      const pushed = (row.status === "pushing" || row.status === "opening_pr" || row.stage === "pushing" || row.stage === "opening_pr") && row.branch_name;
      await updateRun(row.run_id, {
        status: pushed ? "failed_push_incomplete" : "failed",
        error: pushed
          ? `Process restarted after pushing branch "${row.branch_name}" but before confirming the PR — check GitHub, a PR may need to be opened manually.`
          : "Process restarted while this run was being committed; it was not auto-resumed because git state can't be safely re-driven.",
      });
      failed++;
      continue;
    }

    // Everything else (queued/running, anywhere from intake to preview_build)
    // touched nothing outside this service's own scratch directory, so it can
    // be re-driven from the start safely.
    resumable.push(row.run_id);
  }

  return { failed, resumable };
}
