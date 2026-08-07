import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "../state/database-connection.mjs";
import { findPackageJsonDir, detectPackageManager, RUN_SCRIPT_CMD } from "../verify/detect-package-manager.mjs";
import { getFreePort, waitForReady, SERVE_SCRIPT_PREFERENCE } from "../verify/ephemeral-server.mjs";
import { hasDocker, parseDockerBuildStage } from "../verify/docker-build.mjs";
import { removeWorktree } from "../git/clone-and-commit.mjs";
import { isTerminal } from "../state/campaign-repository.mjs";

/* Longer-lived preview sandbox (new_plan.md Phase 4) — unlike
 * verify/ephemeral-server.mjs's ephemeral, request-scoped server (started and
 * torn down within one verify() call), a preview outlives the request that
 * started it: DB-tracked (previews table), reachable by a human clicking a
 * link in the UI, and torn down later by idle-timeout sweep, an explicit
 * stop, or boot-time reconciliation — never by an in-memory closure, since
 * nothing here can assume the process that started it is still the one
 * that stops it.
 *
 * Docker vs. process-based, per run: when the target repo has a usable
 * Dockerfile (see verify/docker-build.mjs) and Docker is reachable, the
 * preview server runs inside a container using that repo's own declared
 * Node image — the same reasoning as verify's build step (v0.14): once
 * node_modules gets installed under a specific Node ABI (via Docker),
 * running the server under a *different* Node version on the bare host
 * risks native-module mismatches, so the serve step needs to match the
 * install step's environment, not this service's host. Falls back to
 * spawning the repo's own serve script directly on the host otherwise. */

function runCommand(cmd, args, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, stdout, stderr });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function readServeScript(pkgDir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
    const scripts = pkg.scripts ?? {};
    return SERVE_SCRIPT_PREFERENCE.find((s) => scripts[s]) ?? null;
  } catch {
    return null;
  }
}

function insertPreviewRow(db, { runId, kind, port, pid, containerName, url, expiresAt }) {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO previews (run_id, kind, port, pid, container_name, url, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`
    )
    .run(runId, kind, port ?? null, pid ?? null, containerName ?? null, url, expiresAt, now);
  return info.lastInsertRowid;
}

function getActivePreviewRow(db, runId) {
  return db.prepare(`SELECT * FROM previews WHERE run_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`).get(runId);
}

function countRunningPreviews(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM previews WHERE status = 'running'`).get().n;
}

function oldestRunningPreview(db) {
  return db.prepare(`SELECT * FROM previews WHERE status = 'running' ORDER BY created_at ASC LIMIT 1`).get();
}

function killGroupOrPid(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
  }
}

/** Stops one preview (process or docker), marks it 'stopped', and — since
 *  Phase 4 also changed openPr() to stop deleting a run's worktree itself
 *  when a preview was started for it — removes that worktree too, so
 *  cleanup that used to happen immediately after push now happens here
 *  instead, whenever the preview's lifecycle actually ends. Best-effort
 *  throughout: a stop path failing shouldn't block the sweep/boot-reconcile
 *  loop calling it from moving on to the next row. */
async function stopPreviewRow(db, row, { baseDir } = {}) {
  if (row.kind === "docker" && row.container_name) {
    await runCommand("docker", ["kill", row.container_name], { timeoutMs: 10_000 }).catch(() => {});
  } else if (row.kind === "process" && row.pid) {
    killGroupOrPid(row.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    killGroupOrPid(row.pid, "SIGKILL");
  }
  db.prepare(`UPDATE previews SET status = 'stopped' WHERE id = ?`).run(row.id);

  if (baseDir) {
    const run = db.prepare(`SELECT workdir, branch_name, status FROM runs WHERE run_id = ?`).get(row.run_id);
    // The worktree is only disposable once the RUN itself is finished with
    // it. A run still awaiting review (or still in flight) needs it alive:
    // approve's commit() runs git inside that directory, and refine rewrites
    // section files there. Removing it here used to silently break both — an
    // idle-timeout sweep or a service restart could strand a reviewable run
    // with no working directory left to approve from.
    if (run?.workdir && run.status && isTerminal(run.status)) {
      await removeWorktree({ baseDir, workdir: run.workdir, branchName: run.branch_name }).catch(() => {});
    }
  }
}

/**
 * @param {object} p
 * @param {string} p.runId
 * @param {string} p.workdir - the run's scratch worktree (still alive — this must run before openPr() would have removed it)
 * @param {string|null} [p.pageUrlPath] - e.g. "/campaigns/spring-sale"
 * @param {number} p.ttlMs
 * @param {number} p.maxConcurrent
 * @param {boolean} [p.disableDocker]
 * @returns {Promise<{ok: boolean, report?: string, previewId?: number, url?: string, kind?: string, expiresAt?: string}>}
 */
export async function startPreview({ runId, workdir, pageUrlPath = null, ttlMs, maxConcurrent, disableDocker = false }) {
  const db = getDb();

  // Soft cap: evict the oldest running preview to make room rather than
  // refusing outright — a preview is a convenience, not a resource anyone
  // explicitly reserved, so LRU eviction is the friendlier default.
  while (countRunningPreviews(db) >= maxConcurrent) {
    const oldest = oldestRunningPreview(db);
    if (!oldest) break;
    await stopPreviewRow(db, oldest);
  }

  const pkgDir = await findPackageJsonDir(workdir);
  if (!pkgDir) {
    return { ok: false, report: "Not a Node-servable repo — cannot start a preview." };
  }
  const scriptName = await readServeScript(pkgDir);
  if (!scriptName) {
    return { ok: false, report: `No "${SERVE_SCRIPT_PREFERENCE.join('"/"')}" script found in package.json.` };
  }

  const dockerStage = disableDocker ? null : await parseDockerBuildStage(pkgDir);
  const dockerUsable = Boolean(dockerStage) && (await hasDocker());

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const url = pageUrlPath ? `${baseUrl}${pageUrlPath}` : baseUrl;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  if (dockerUsable) {
    const containerName = `codegen-preview-${runId.slice(0, 8)}-${Date.now()}`;
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const gid = typeof process.getgid === "function" ? process.getgid() : null;
    const userArgs = uid != null && gid != null ? ["--user", `${uid}:${gid}`] : [];

    const child = spawn("docker", [
      "run",
      "--rm",
      "--name",
      containerName,
      ...userArgs,
      "-v",
      `${path.resolve(pkgDir)}:/app`,
      "-w",
      "/app",
      "-p",
      `${port}:${port}`,
      "-e",
      `PORT=${port}`,
      "-e",
      "HOST=0.0.0.0",
      dockerStage.nodeImage,
      "sh",
      "-c",
      `npm run ${scriptName}`,
    ]);

    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d));
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });

    const ready = await waitForReady(baseUrl, 60_000);
    if (!ready || exited) {
      await runCommand("docker", ["kill", containerName], { timeoutMs: 10_000 }).catch(() => {});
      return { ok: false, report: `docker preview server did not respond at ${baseUrl} within 60s:\n${stderr.slice(-1500)}` };
    }

    const previewId = insertPreviewRow(db, { runId, kind: "docker", port, pid: null, containerName, url, expiresAt });
    return { ok: true, previewId, url, kind: "docker", expiresAt };
  }

  // Process-based fallback — same detached/process-group pattern as
  // verify/ephemeral-server.mjs's ephemeral server, but the pid (not a
  // closure) is what's persisted, since this preview needs to be
  // stoppable from a completely different process invocation later.
  const pm = await detectPackageManager(pkgDir);
  const [cmd, args] = RUN_SCRIPT_CMD[pm](scriptName);
  const child = spawn(cmd, args, {
    cwd: pkgDir,
    env: { ...process.env, PORT: String(port), HOST: "0.0.0.0" },
    detached: true,
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const ready = await waitForReady(baseUrl, 60_000);
  if (!ready || exited) {
    if (child.pid) killGroupOrPid(child.pid, "SIGKILL");
    return { ok: false, report: `preview server did not respond at ${baseUrl} within 60s (tried "${pm} run ${scriptName}"):\n${stderr.slice(-1500)}` };
  }

  const previewId = insertPreviewRow(db, { runId, kind: "process", port, pid: child.pid, containerName: null, url, expiresAt });
  return { ok: true, previewId, url, kind: "process", expiresAt };
}

/** Looks up the current preview for a run, if any — for GET /campaigns/:runId/preview. */
export async function getPreview(runId) {
  const db = getDb();
  const row = getActivePreviewRow(db, runId);
  if (!row) return null;
  return { kind: row.kind, port: row.port, url: row.url, status: row.status, expiresAt: row.expires_at };
}

/** Explicit stop — POST /campaigns/:runId/preview/stop. */
export async function stopPreview({ runId, baseDir }) {
  const db = getDb();
  const row = getActivePreviewRow(db, runId);
  if (!row) return { ok: false, reason: "not_found" };
  await stopPreviewRow(db, row, { baseDir });
  return { ok: true };
}

/** Called on a timer (server.mjs) — stops any preview past its expires_at. */
export async function sweepIdlePreviews({ baseDir }) {
  const db = getDb();
  const now = new Date().toISOString();
  const expired = db.prepare(`SELECT * FROM previews WHERE status = 'running' AND expires_at < ?`).all(now);
  for (const row of expired) {
    await stopPreviewRow(db, row, { baseDir });
  }
  return expired.length;
}

/** Called once at server startup — any 'running' preview row is from a
 *  previous process lifetime and cannot be trusted (this service doesn't
 *  resume across restarts, matching reconcileCrashedRuns's philosophy for
 *  runs); best-effort stop each and clean up its worktree. */
export async function reconcilePreviewsOnBoot({ baseDir }) {
  const db = getDb();
  const running = db.prepare(`SELECT * FROM previews WHERE status = 'running'`).all();
  for (const row of running) {
    await stopPreviewRow(db, row, { baseDir }).catch(() => {});
  }
  return running.length;
}
