import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cloneShallow,
  listTrackedFiles,
  createLocalBranch,
  commitPaths,
  push,
} from "../src/git/ops.mjs";

/* Exercises the full clone -> branch -> commit -> push sequence against a
 * local `git init --bare` fixture — proves git/ops.mjs's sequencing and
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
