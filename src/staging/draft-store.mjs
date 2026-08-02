import { getDb } from "../state/db.mjs";

/* Versioned record of exactly what was generated for a run — populated once
 * per successful `verify`, by the `stageDraft` graph node
 * (orchestrator/steps.mjs), before commit/push/open_pr. This is what a
 * future review UI reads/diffs instead of re-reading the scratch worktree,
 * and what `GET /campaigns/:runId/draft` serves today.
 *
 * `sectionSlot` (new_plan.md §9.6/module.md Module 3) ties each file to the
 * section it belongs to (e.g. "section-0"), so a future per-section refine
 * (Module 4) can stage a new version scoped to just one slot without
 * bumping/losing history for the rest. It's optional/nullable — the
 * composed page.tsx has no single slot, and callers that don't care about
 * per-section granularity (e.g. existing tests) can omit it entirely. */

export async function stageNewVersion({ runId, files }) {
  const db = getDb();
  const { v: prevVersion } = db.prepare("SELECT MAX(version) AS v FROM draft_files WHERE run_id = ?").get(runId);
  const version = (prevVersion ?? 0) + 1;
  const now = new Date().toISOString();

  const insert = db.prepare("INSERT INTO draft_files (run_id, version, path, content, section_slot, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const file of files) {
    insert.run(runId, version, file.path, file.content, file.sectionSlot ?? null, now);
  }
  db.prepare("UPDATE runs SET current_draft_version = ? WHERE run_id = ?").run(version, runId);

  return { version, fileCount: files.length };
}

export async function getLatestVersion(runId) {
  const db = getDb();
  const { v: version } = db.prepare("SELECT MAX(version) AS v FROM draft_files WHERE run_id = ?").get(runId);
  if (!version) return null;
  const files = db
    .prepare("SELECT path, content, section_slot AS sectionSlot FROM draft_files WHERE run_id = ? AND version = ? ORDER BY path")
    .all(runId, version);
  return { version, files };
}

/** The latest staged file(s) for one section slot only — what Module 4's
 *  per-section refine UI reads before offering a swap/modify action, and
 *  what a scoped refine will stage a new version on top of. Returns [] if
 *  nothing has ever been staged for that slot (including a run that predates
 *  section-slot tagging entirely). */
export async function getLatestVersionForSlot(runId, sectionSlot) {
  const db = getDb();
  const { v: version } = db
    .prepare("SELECT MAX(version) AS v FROM draft_files WHERE run_id = ? AND section_slot = ?")
    .get(runId, sectionSlot);
  if (!version) return { version: null, files: [] };
  const files = db
    .prepare("SELECT path, content, section_slot AS sectionSlot FROM draft_files WHERE run_id = ? AND section_slot = ? AND version = ? ORDER BY path")
    .all(runId, sectionSlot, version);
  return { version, files };
}

/** Compares the two most recent staged versions for a run. Returns null if
 *  there's only one version (nothing to diff against yet) — meaningful once
 *  a run has been regenerated at least once (Phase 6's reject/edit cycle). */
export async function diffFromPrevious(runId) {
  const db = getDb();
  const versions = db
    .prepare("SELECT DISTINCT version FROM draft_files WHERE run_id = ? ORDER BY version DESC LIMIT 2")
    .all(runId)
    .map((r) => r.version);
  if (versions.length < 2) return null;
  const [toVersion, fromVersion] = versions;

  const readVersion = (version) =>
    new Map(
      db
        .prepare("SELECT path, content FROM draft_files WHERE run_id = ? AND version = ?")
        .all(runId, version)
        .map((f) => [f.path, f.content])
    );
  const latest = readVersion(toVersion);
  const previous = readVersion(fromVersion);

  const added = [...latest.keys()].filter((p) => !previous.has(p));
  const removed = [...previous.keys()].filter((p) => !latest.has(p));
  const modified = [...latest.keys()].filter((p) => previous.has(p) && previous.get(p) !== latest.get(p));

  return { fromVersion, toVersion, added, removed, modified };
}
