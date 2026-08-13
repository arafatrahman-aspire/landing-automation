import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, access, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cloneShallow,
  listTrackedFiles,
  createLocalBranch,
  commitPaths,
  push,
  removeWorktree,
  clearStaleGitLocks,
  syncBaseToLatest,
} from "../src/git/clone-and-commit.mjs";

/* Exercises the full clone -> branch -> commit -> push sequence against a
 * local `git init --bare` fixture — proves git/clone-and-commit.mjs's sequencing and
 * guardrails without any network access or GitHub token. */

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function seedBareRepo(root) {
  const bareDir = path.join(root, "remote.git");
  const seedDir = path.join(root, "seed");
  git(["init", "--bare", "-b", "main", bareDir]);
  git(["init", "-b", "main", seedDir]);
  await writeFile(path.join(seedDir, "existing-file.txt"), "pristine content\n");
  git(["-c", "user.name=seed", "-c", "user.email=seed@test.local", "add", "."], seedDir);
  git(["-c", "user.name=seed", "-c", "user.email=seed@test.local", "commit", "-m", "initial commit"], seedDir);
  git(["remote", "add", "origin", bareDir], seedDir);
  git(["push", "origin", "main"], seedDir);
  return bareDir;
}

test("clone -> branch -> commit -> push against a local bare repo", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gitops-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bareDir = await seedBareRepo(root);
  const cloneDir = path.join(root, "clone");

  await cloneShallow({ remoteUrl: bareDir, branch: "main", dir: cloneDir });

  const pristine = await listTrackedFiles({ dir: cloneDir });
  assert.ok(pristine.has("existing-file.txt"));

  await createLocalBranch({ dir: cloneDir, branchName: "codegen/test-1", baseBranch: "main" });

  await writeFile(path.join(cloneDir, "new-file.txt"), "agent-written content\n");
  await commitPaths({
    dir: cloneDir,
    paths: ["new-file.txt"],
    message: "feat: test commit",
    authorName: "Test Bot",
    authorEmail: "bot@test.local",
  });

  await push({ dir: cloneDir, branchName: "codegen/test-1", baseBranch: "main" });

  // Verify the branch landed on the "remote" by listing its refs directly.
  const refs = execFileSync("git", ["-C", bareDir, "branch", "--list", "codegen/test-1"]).toString();
  assert.match(refs, /codegen\/test-1/);
});

test("createLocalBranch refuses a branch name equal to the base branch", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gitops-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bareDir = await seedBareRepo(root);
  const cloneDir = path.join(root, "clone2");
  await cloneShallow({ remoteUrl: bareDir, branch: "main", dir: cloneDir });

  await assert.rejects(() => createLocalBranch({ dir: cloneDir, branchName: "main", baseBranch: "main" }));
});

test("commitPaths refuses an empty path list (no blind `git add -A`)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gitops-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bareDir = await seedBareRepo(root);
  const cloneDir = path.join(root, "clone3");
  await cloneShallow({ remoteUrl: bareDir, branch: "main", dir: cloneDir });

  await assert.rejects(() =>
    commitPaths({ dir: cloneDir, paths: [], message: "x", authorName: "a", authorEmail: "a@b.c" })
  );
});

/* Real failure: a run's scratch directory survived as an ORPHAN — repo files
 * present, no `.git` file, so git had no record of it. `git worktree remove`
 * failed with "is not a working tree", the error was swallowed, and the next
 * `git worktree add` died with "already exists", failing the run at clone. */

test("removeWorktree clears an ORPHANED directory that git has no record of", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orphan-wt-"));
  const baseDir = path.join(root, "_base");
  const workdir = path.join(root, "run-abc");
  try {
    await mkdir(baseDir, { recursive: true });
    git(["init", "-b", "main", "."], baseDir);

    // An orphan: real files, deliberately NO .git — exactly what was on disk.
    await mkdir(path.join(workdir, "src"), { recursive: true });
    await writeFile(path.join(workdir, "package.json"), "{}\n");
    await writeFile(path.join(workdir, "src/page.tsx"), "export default () => null;\n");

    const result = await removeWorktree({ baseDir, workdir, branchName: "codegen/abc" });

    assert.equal(result.ok, true, `should have cleared the orphan: ${result.reason ?? ""}`);
    assert.equal(await access(workdir).then(() => true, () => false), false, "directory must be gone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeWorktree refuses to delete anything outside the scratch root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guard-wt-"));
  const outside = await mkdtemp(path.join(tmpdir(), "precious-"));
  const baseDir = path.join(root, "_base");
  try {
    await mkdir(baseDir, { recursive: true });
    git(["init", "-b", "main", "."], baseDir);
    await writeFile(path.join(outside, "important.txt"), "do not delete\n");

    const result = await removeWorktree({ baseDir, workdir: outside, branchName: null });

    assert.equal(result.ok, false, "must refuse a path outside the scratch root");
    assert.match(result.reason, /refusing to delete/);
    assert.equal(await access(path.join(outside, "important.txt")).then(() => true, () => false), true, "file must survive");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("removeWorktree never deletes the base clone itself", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "base-guard-"));
  const baseDir = path.join(root, "_base");
  try {
    await mkdir(baseDir, { recursive: true });
    git(["init", "-b", "main", "."], baseDir);

    const result = await removeWorktree({ baseDir, workdir: baseDir, branchName: null });

    assert.equal(result.ok, false);
    assert.equal(await access(baseDir).then(() => true, () => false), true, "the base clone must survive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* Real failure: the service was killed mid-fetch (the --watch restart problem),
 * leaving `.git/shallow.lock` behind. Every later run then died at clone with
 * "Unable to create '…/shallow.lock': File exists" until it was deleted by hand. */

async function repoWithLock(ageMs) {
  const dir = await mkdtemp(path.join(tmpdir(), "gitlock-"));
  git(["init", "-b", "main", "."], dir);
  const lockPath = path.join(dir, ".git", "shallow.lock");
  await writeFile(lockPath, "");
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    await utimes(lockPath, when, when);
  }
  return { dir, lockPath };
}

test("clearStaleGitLocks removes an ABANDONED lock", async () => {
  const { dir, lockPath } = await repoWithLock(5 * 60_000); // 5 minutes old
  try {
    const result = await clearStaleGitLocks(dir);
    assert.deepEqual(result.removed, ["shallow.lock"]);
    assert.deepEqual(result.active, []);
    assert.equal(await access(lockPath).then(() => true, () => false), false, "lock must be gone");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearStaleGitLocks LEAVES a fresh lock alone — another process may be mid-fetch", async () => {
  const { dir, lockPath } = await repoWithLock(0); // just created
  try {
    const result = await clearStaleGitLocks(dir);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.active, ["shallow.lock"]);
    assert.equal(await access(lockPath).then(() => true, () => false), true, "a live lock must NOT be stolen");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncBaseToLatest fails with a clear message when a fresh lock is held", async () => {
  const { dir } = await repoWithLock(0);
  try {
    await assert.rejects(
      () => syncBaseToLatest({ dir, branch: "main" }),
      /another instance of this service is probably running/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearStaleGitLocks is a no-op on a clean repo", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gitclean-"));
  try {
    git(["init", "-b", "main", "."], dir);
    assert.deepEqual(await clearStaleGitLocks(dir), { removed: [], active: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
