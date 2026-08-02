import { spawn } from "node:child_process";

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
export async function syncBaseToLatest({ dir, branch, timeoutMs = 60_000 }) {
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
export async function removeWorktree({ baseDir, workdir, branchName }) {
  await runGit(["-C", baseDir, "worktree", "remove", "--force", workdir], { cwd: baseDir }).catch(() => {});
  await runGit(["-C", baseDir, "worktree", "prune"], { cwd: baseDir }).catch(() => {});
  if (branchName) {
    await runGit(["-C", baseDir, "branch", "-D", branchName], { cwd: baseDir }).catch(() => {});
  }
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
