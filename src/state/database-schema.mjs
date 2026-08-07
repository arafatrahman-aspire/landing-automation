/* Idempotent schema — every statement is CREATE TABLE/INDEX IF NOT EXISTS,
 * run on every process start (see state/database-connection.mjs). No migration framework:
 * the whole shape is declared once, up front, including columns/tables
 * later phases will use but nothing writes to yet (called out below) —
 * additive schema changes are cheap in SQLite even without one, so this
 * isn't locking in a bad decision, just avoiding an ALTER TABLE per phase.
 *
 * `campaigns` holds the immutable, human-submitted brief; `runs` holds the
 * pipeline's mutable execution state for that campaign. They're 1:1 today
 * (one POST /campaigns = one row in each), split apart because they change
 * for different reasons and at different rates. */
/** `CREATE TABLE IF NOT EXISTS` doesn't retroactively add columns to a
 *  table that already exists from an earlier phase (e.g. this service's
 *  own real `data/campaigns.db`, which already had an empty `previews`
 *  table from Phase 3 before Phase 4 needed two more columns on it) — this
 *  is the "additive changes are cheap" claim from the comment above,
 *  actually made good on: check via `PRAGMA table_info`, `ALTER TABLE ADD
 *  COLUMN` only if missing. Still no real migration framework (no ordered
 *  migration files, no version tracking) — just enough to keep existing
 *  databases in sync with schema.mjs as new columns get added over time. */
function addColumnIfMissing(db, table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      run_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      campaign_name TEXT,
      brief_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY REFERENCES campaigns(run_id),
      status TEXT NOT NULL,
      stage TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      heartbeat_at TEXT,
      code_attempts INTEGER NOT NULL DEFAULT 0,
      verify_attempts INTEGER NOT NULL DEFAULT 0,
      branch_name TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      error TEXT,
      guide_json TEXT,
      section_references_json TEXT,
      verify_checks_json TEXT,
      current_draft_version INTEGER,
      -- Phase 7 (new_plan.md §6/§9.9): persisted so a run can be approved
      -- from a LATER, separate request than the one that generated it —
      -- the in-process LangGraph state from generate_sections is gone the
      -- moment graph.invoke() returns, so approveRun() (orchestrator/
      -- review-actions.mjs) reconstructs what commit()/push()/openPr() need
      -- from these columns + draft_files instead.
      agent_summary TEXT,
      section_results_json TEXT,
      -- Resume-state columns for the reject/regenerate review cycle
      -- (Phase 6). Nothing populates these yet — a second graph.invoke()
      -- call needs to rebuild its starting state without a LangGraph
      -- checkpointer, which is what these exist for.
      workdir TEXT,
      research_notes_json TEXT,
      file_manifest_json TEXT,
      pristine_files_json TEXT,
      allowlist_json TEXT
    );

    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id, id);

    CREATE TABLE IF NOT EXISTS draft_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      version INTEGER NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      -- new_plan.md §9.6/module.md Module 3: which section this file belongs
      -- to (e.g. "section-0"), so a future per-section refine (Module 4) can
      -- version just one slot without bumping/losing history for the rest.
      -- NULL for the composed page.tsx row itself, which has no single slot.
      section_slot TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_draft_files_run_version ON draft_files(run_id, version);

    -- Everything below is schema-only scaffolding for later phases (named in
    -- new_plan.md's data-layer reference) — declared now, since additive
    -- SQLite tables cost nothing, but unused until the phase that needs them
    -- lands: verify_reports (Phase 5/6 per-attempt history, vs. runs.verify_checks_json's
    -- latest-only snapshot), validation_reports (Phase 5), previews (Phase 4),
    -- review_decisions (Phase 6), token_usage (Phase 8).
    CREATE TABLE IF NOT EXISTS verify_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      attempt INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      report TEXT,
      checks_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS validation_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      kind TEXT NOT NULL,
      ok INTEGER,
      findings_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS previews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      kind TEXT,
      port INTEGER,
      pid INTEGER,
      container_name TEXT,
      url TEXT,
      status TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      decision TEXT NOT NULL,
      feedback TEXT,
      cycle INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      stage TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at TEXT NOT NULL
    );
  `);

  // Additive columns for tables that may already exist from an earlier
  // phase's schema (see addColumnIfMissing above).
  addColumnIfMissing(db, "previews", "kind", "TEXT");
  addColumnIfMissing(db, "previews", "container_name", "TEXT");
  addColumnIfMissing(db, "previews", "url", "TEXT");
  addColumnIfMissing(db, "draft_files", "section_slot", "TEXT");
  addColumnIfMissing(db, "runs", "agent_summary", "TEXT");
  addColumnIfMissing(db, "runs", "section_results_json", "TEXT");
  // Crash resume: research notes are persisted so a resumed run can skip the
  // research LLM call it already paid for. Declared in the CREATE TABLE above
  // since Phase 3, but only actually written to from the resume work onward —
  // databases created before then still need it added here.
  addColumnIfMissing(db, "runs", "research_notes_json", "TEXT");
  // Marks a draft staged despite a failing build (CONTINUE_ON_VERIFY_FAILURE).
  addColumnIfMissing(db, "runs", "verify_bypassed", "INTEGER");

  // Must run AFTER addColumnIfMissing above, not inside the CREATE TABLE
  // block: on an existing database where draft_files predates this column,
  // creating this index before the column exists would throw ("no such
  // column: section_slot"). CREATE INDEX IF NOT EXISTS is itself idempotent
  // either way (fresh DB or existing).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_draft_files_run_slot ON draft_files(run_id, section_slot);`);
}
