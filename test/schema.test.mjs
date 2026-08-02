import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "../src/state/schema.mjs";

test("initSchema creates every expected table", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [
    "campaigns",
    "draft_files",
    "previews",
    "review_decisions",
    "run_logs",
    "runs",
    "token_usage",
    "validation_reports",
    "verify_reports",
  ]);
});

test("initSchema is idempotent — calling it twice on the same db doesn't throw", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  assert.doesNotThrow(() => initSchema(db));
});

test("initSchema adds section_slot to a pre-existing draft_files table that predates it (real migration path, not just a fresh DB)", () => {
  const db = new DatabaseSync(":memory:");
  // Simulate a database created before Module 3 added section_slot —
  // old-shape draft_files, no section_slot column, no run/runs FK target
  // needed since this test only exercises the ALTER TABLE + index path.
  db.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY);
    CREATE TABLE draft_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  assert.doesNotThrow(() => initSchema(db));
  const columns = db.prepare("PRAGMA table_info(draft_files)").all().map((c) => c.name);
  assert.ok(columns.includes("section_slot"), "section_slot should be added to a pre-existing draft_files table");
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='draft_files'").all().map((r) => r.name);
  assert.ok(indexes.includes("idx_draft_files_run_slot"), "idx_draft_files_run_slot should be created on a migrated table");
});
