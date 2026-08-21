import { spawn } from "node:child_process";
import path from "node:path";
import { access, rm, stat } from "node:fs/promises";

function runGit(args, { cwd, timeoutMs = 120_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(sanitize(`git ${args.join(" ")} failed (${code}): ${stderr || stdout}`)));
    });
  });
}

function sanitize(str) {
  return str.replace(/(ghp_[A-Za-z0-9_-]{34,})|(github_pat_[A-Za-z0-9_-]{50,})|(Bearer\s+\S+)/g, "***REDACTED***");
}

function repoUrlWithAuth(remoteUrl, token) {
  if (!remoteUrl.startsWith("http") || !token) return remoteUrl;
  const u = new URL(remoteUrl);
  u.username = "x-access-token";
  u.password = token;
  return u.toString();
}

export async function cloneShallow({ remoteUrl, branch, dir, token, timeoutMs }) {
  const url = repoUrlWithAuth(remoteUrl, token);
  await runGit(["clone", "--depth", "1", "--branch", branch, url, dir], { timeoutMs });
}

/** Brings an existing persistent base clone's local base-branch ref up to
 *  date with origin, without re-cloning. Safe to call every run — worktrees
 *  already checked out on their own per-run branches are untouched by this. */
/* Lock files git leaves in .git when an operation is interrupted. A real run
 * died with "Unable to create '.git/shallow.lock': File exists" after the
 * service was killed mid-fetch (see the --watch restart problem), and every
 * later run then failed at clone until the file was removed by hand. */
const GIT_LOCK_FILES = ["shallow.lock", "index.lock", "HEAD.lock", "config.lock", "packed-refs.lock"];

// Only a lock older than this is treated as abandoned. A genuinely concurrent
// fetch refreshes its lock well inside this window, so a second service
// instance is never robbed of a lock it is actively using.
const STALE_LOCK_AGE_MS = 90_000;

/**
 * Clears abandoned git lock files, leaving fresh ones (someone else is working)
 * alone.
 * @returns {Promise<{removed: string[], active: string[]}>}
 */
export async function clearStaleGitLocks(dir) {
  const removed = [];
  const active = [];
  for (const name of GIT_LOCK_FILES) {
    const lockPath = path.join(dir, ".git", name);
    let info;
    try {
      info = await stat(lockPath);
    } catch {
      continue; // not present
    }
    if (Date.now() - info.mtimeMs >= STALE_LOCK_AGE_MS) {
      await rm(lockPath, { force: true });
      removed.push(name);
    } else {
      active.push(name);
    }
  }
  return { removed, active };
}

export async function syncBaseToLatest({ dir, branch, timeoutMs = 180_000, logger = () => {} }) {
  const { removed, active } = await clearStaleGitLocks(dir);
  if (removed.length > 0) {
    logger(`cleared abandoned git lock(s) in the base clone: ${removed.join(", ")} — a previous process was interrupted mid-operation`);
  }
  if (active.length > 0) {
    // Deliberately not removed: a fresh lock means another process is very
    // likely mid-fetch on this shared base clone. Deleting it could corrupt
    // that operation, so say what is happening instead of racing it.
    throw new Error(
      `git lock(s) held in ${dir}/.git (${active.join(", ")}) and modified in the last ${Math.round(STALE_LOCK_AGE_MS / 1000)}s — ` +
        `another instance of this service is probably running against the same base clone. Run only ONE instance, then retry.`
    );
  }

  await runGit(["-C", dir, "fetch", "--depth", "1", "origin", branch], { cwd: dir, timeoutMs });
  await runGit(["-C", dir, "checkout", branch], { cwd: dir });
  await runGit(["-C", dir, "reset", "--hard", `origin/${branch}`], { cwd: dir });
}

/** Creates a new per-run working directory as a git worktree off the shared
 *  base clone's object store — no network clone, just a new branch + checkout.
 *  This is what lets repeated runs reuse an already-cloned repo instead of
 *  cloning it fresh every time. */
export async function addWorktree({ baseDir, workdir, branchName, baseBranch }) {
  if (branchName === baseBranch) {
    throw new Error(`Refusing to create a branch named the same as the base branch ("${baseBranch}")`);
  }
  await runGit(["-C", baseDir, "worktree", "add", "-b", branchName, workdir, baseBranch], { cwd: baseDir });
}

/** Tears down a per-run worktree + its local branch. Best-effort by design —
 *  called during cleanup paths where a half-removed workdir shouldn't block
 *  the rest of the flow. */
/* A run's scratch directory can end up ORPHANED: present on disk with the
 * repo's files but no `.git` file, so git has no record of it. A real run hit
 * this after the process was interrupted — `git worktree remove` then fails
 * with "is not a working tree", and the leftover directory makes the next
 * `git worktree add` fail with "already exists", killing the run at clone.
 *
 * So the git commands are best-effort, and the filesystem is the fallback:
 * what actually matters is that the path is GONE when this returns.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>} whether the path is now clear
 */
export async function removeWorktree({ baseDir, workdir, branchName }) {
  await runGit(["-C", baseDir, "worktree", "remove", "--force", workdir], { cwd: baseDir }).catch(() => {});
  await runGit(["-C", baseDir, "worktree", "prune"], { cwd: baseDir }).catch(() => {});
  if (branchName) {
    // The branch must go too: `worktree add -b <branch>` refuses to reuse an
    // existing branch name, so leaving it behind just moves the failure.
    await runGit(["-C", baseDir, "branch", "-D", branchName], { cwd: baseDir }).catch(() => {});
  }

  const stillThere = await access(workdir).then(() => true, () => false);
  if (!stillThere) return { ok: true };

  // Filesystem fallback. Guarded: only ever delete a sibling of the base clone
  // inside the scratch root, never the base clone itself and never anything
  // outside it. A recursive delete driven by a variable needs to be provably
  // unable to point somewhere else.
  const scratchRoot = path.dirname(path.resolve(baseDir));
  const target = path.resolve(workdir);
  const rel = path.relative(scratchRoot, target);
  const containedInScratch = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (!containedInScratch || target === path.resolve(baseDir)) {
    return { ok: false, reason: `refusing to delete "${target}": it is not a scratch worktree inside ${scratchRoot}` };
  }

  // Retried: removing a worktree's node_modules (hundreds of packages, tens of
  // thousands of files) races with anything still flushing writes into it —
  // notably a Docker build whose bind-mounted container outlived the process
  // that started it. A real resume failed here with
  // "ENOTEMPTY: directory not empty, rmdir '…/node_modules/@tsparticles/…'",
  // and the same delete succeeded moments later.
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    const gone = await access(target).then(() => false, () => true);
    if (gone) return { ok: true };
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }

  return { ok: false, reason: `"${target}" could not be removed${lastError ? ` (${lastError.code ?? lastError.message})` : ""}` };
}

export async function listTrackedFiles({ dir }) {
  const { stdout } = await runGit(["-C", dir, "ls-files"], { cwd: dir });
  return new Set(stdout.split("\n").map((l) => l.trim()).filter(Boolean));
}

export async function createLocalBranch({ dir, branchName, baseBranch }) {
  if (branchName === baseBranch) {
    throw new Error(`Refusing to create a branch named the same as the base branch ("${baseBranch}")`);
  }
  await runGit(["-C", dir, "checkout", "-b", branchName], { cwd: dir });
}

export async function setRemoteAuth({ dir, remoteUrl, token }) {
  if (!token) return;
  const url = repoUrlWithAuth(remoteUrl, token);
  await runGit(["-C", dir, "remote", "set-url", "origin", url], { cwd: dir });
}

export async function commitPaths({ dir, paths, message, authorName, authorEmail }) {
  if (paths.length === 0) throw new Error("commitPaths: no paths given");
  await runGit(["-C", dir, "add", "--", ...paths], { cwd: dir });
  await runGit(
    ["-C", dir, "-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "commit", "-m", message],
    { cwd: dir }
  );
}

export async function push({ dir, branchName, baseBranch, attempts = 3, timeoutMs }) {
  if (branchName === baseBranch) {
    throw new Error(`Refusing to push a branch named the same as the base branch ("${baseBranch}")`);
  }
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runGit(["-C", dir, "push", "-u", "origin", branchName], { cwd: dir, timeoutMs });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}
