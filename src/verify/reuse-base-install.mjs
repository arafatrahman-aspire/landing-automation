import { access, mkdir, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { detectPackageManager, INSTALL_CMD } from "./detect-package-manager.mjs";
import { cleanEnvForChildProcess } from "../spawn-env.mjs";

/** Sibling of a run worktree: WORKDIR_ROOT/{runId} → WORKDIR_ROOT/_base */
export function baseDirNextToWorktree(workdir) {
  if (!workdir) return null;
  return path.join(path.dirname(workdir), "_base");
}

async function exists(p) {
  return access(p).then(() => true, () => false);
}

function runCommand(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: cleanEnvForChildProcess() });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr + `\n${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr, timedOut });
    });
  });
}

/**
 * One shared `npm install` on `_base` so every worktree can symlink it.
 * Safe to call inside the clone lock. No-op when node_modules already exists.
 */
export async function ensureSharedNodeModules(baseDir, { timeoutMs = 300_000, packageManagerOverride = null, logger = () => {} } = {}) {
  if (!baseDir || !(await exists(path.join(baseDir, "package.json")))) {
    return { installed: false, reason: "no-base" };
  }
  const dest = path.join(baseDir, "node_modules");
  if (await exists(dest)) return { installed: false, reason: "already-present" };

  const pm = await detectPackageManager(baseDir, packageManagerOverride);
  const [cmd, args] = INSTALL_CMD[pm];
  logger(`clone: installing ${pm} dependencies once into ${dest} (shared by later worktrees)`);
  const result = await runCommand(cmd, args, { cwd: baseDir, timeoutMs });
  if (!result.ok) {
    return {
      installed: false,
      reason: result.timedOut ? "timed-out" : "failed",
      report: `${result.stdout}\n${result.stderr}`,
    };
  }
  return { installed: true, reason: "ok" };
}

async function linkDir(fromAbs, toAbs) {
  if (!(await exists(fromAbs))) return false;
  if (await exists(toAbs)) return false;
  await mkdir(path.dirname(toAbs), { recursive: true });
  const rel = path.relative(path.dirname(toAbs), fromAbs);
  await symlink(rel, toAbs);
  return true;
}

/**
 * Point this worktree at `_base/node_modules` (and `.next/cache` if present)
 * so verify can skip a second install and reuse the SWC/webpack cache.
 *
 * @returns {Promise<{nodeModules: boolean, nextCache: boolean, baseDir: string|null}>}
 */
export async function linkSharedInstall(workdir, { baseDir = baseDirNextToWorktree(workdir) } = {}) {
  if (!workdir || !baseDir) return { nodeModules: false, nextCache: false, baseDir: baseDir ?? null };
  if (!(await exists(baseDir))) return { nodeModules: false, nextCache: false, baseDir };

  const nodeModules = await linkDir(path.join(baseDir, "node_modules"), path.join(workdir, "node_modules"));
  const nextCache = await linkDir(path.join(baseDir, ".next", "cache"), path.join(workdir, ".next", "cache"));
  return { nodeModules, nextCache, baseDir };
}
