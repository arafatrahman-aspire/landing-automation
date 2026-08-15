import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

// approve-or-abandon-run.mjs transitively reaches config.mjs (via git/clone-and-commit.mjs,
// preview/preview-server.mjs) — dynamic import AFTER setTestConfigEnv, same
// convention as test/sqlite-repository.test.mjs / generate-sections.test.mjs.
// KEEP_WORKDIR_ON_FAILURE=true so openPr()'s success path skips
// removeWorktree — this fixture's "workdir" is a plain clone, not a real
// worktree of a configured _base, so that cleanup path is deliberately not
// exercised here (it's already covered by test/git-ops.test.mjs and
// test/preview-sandbox.test.mjs).
setTestConfigEnv({
  DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "review-actions-db-")), "test.db"),
  KEEP_WORKDIR_ON_FAILURE: "true",
});

const runStore = await import("../src/state/campaign-repository.mjs");
const draftStore = await import("../src/staging/draft-versions.mjs");
const { config } = await import("../src/config.mjs");
const { approveRun, abandonRun, ReviewActionError, isScratchWorktree } = await import("../src/pipeline/approve-or-abandon-run.mjs");

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A local bare "remote" + a plain (non-worktree) clone of it — enough to
 *  exercise commit/push for real, without needing the shared _base/worktree
 *  machinery clone() normally sets up (that's exercised elsewhere). */
async function seedRepoAndClone(root) {
  const bareDir = path.join(root, "remote.git");
  const seedDir = path.join(root, "seed");
  git(["init", "--bare", "-b", "main", bareDir]);
  git(["init", "-b", "main", seedDir]);
  await writeFile(path.join(seedDir, "existing-file.txt"), "pristine\n");
  git(["-c", "user.name=seed", "-c", "user.email=seed@test.local", "add", "."], seedDir);
  git(["-c", "user.name=seed", "-c", "user.email=seed@test.local", "commit", "-m", "initial"], seedDir);
  git(["remote", "add", "origin", bareDir], seedDir);
  git(["push", "origin", "main"], seedDir);

  const workdir = path.join(root, "workdir");
  git(["clone", bareDir, workdir]);
  git(["-c", "user.name=bot", "-c", "user.email=bot@test.local", "checkout", "-b", "codegen/test-slug-1"], workdir);
  return { bareDir, workdir };
}

async function makeStagedForReviewRun({ runId, workdir, branchName }) {
  await runStore.createRun({
    runId,
    slug: "test-slug",
    campaignName: "Test Campaign",
    request: { slug: "test-slug", campaignName: "Test Campaign", offer: "x", audience: "x", cta: "x" },
  });
  await runStore.updateRun(runId, {
    status: "staged_for_review",
    workdir,
    branchName,
    guide: { heroTitle: "x", heroHasVideo: false, seoTitle: "x", seoMetaDescription: "x", sections: [{ type: "hero", summary: "x" }] },
    agentSummary: "hero: wrote a hero section",
    sectionResults: [{ type: "hero", mode: "ai-required", path: "app/campaigns/test-slug/sections/HeroSection0.tsx", componentName: "HeroSection0", slot: "section-0" }],
  });
}

test("approveRun: commits, pushes, and opens (dry-run) a PR, then marks the run completed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "review-actions-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { bareDir, workdir } = await seedRepoAndClone(root);

  const runId = "approve-run-1";
  await makeStagedForReviewRun({ runId, workdir, branchName: "codegen/test-slug-1" });

  await mkdir(path.join(workdir, "app/campaigns/test-slug/sections"), { recursive: true });
  await writeFile(path.join(workdir, "app/campaigns/test-slug/sections/HeroSection0.tsx"), "export default function HeroSection0() { return null; }\n");
  await writeFile(path.join(workdir, "app/campaigns/test-slug/page.tsx"), "export default function Page() { return null; }\n");
  await draftStore.stageNewVersion({
    runId,
    files: [
      { path: "app/campaigns/test-slug/sections/HeroSection0.tsx", content: "export default function HeroSection0() { return null; }\n", sectionSlot: "section-0" },
      { path: "app/campaigns/test-slug/page.tsx", content: "export default function Page() { return null; }\n" },
    ],
  });

  const result = await approveRun(runId);
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");

  const run = await runStore.getRun(runId);
  assert.equal(run.status, "completed");
  assert.match(run.prUrl ?? "", /dry-run/);

  // Confirm the branch actually landed on the "remote" with the right files.
  const refs = execFileSync("git", ["-C", bareDir, "branch", "--list", "codegen/test-slug-1"]).toString();
  assert.match(refs, /codegen\/test-slug-1/);
  const files = execFileSync("git", ["-C", bareDir, "ls-tree", "-r", "--name-only", "codegen/test-slug-1"]).toString();
  assert.match(files, /app\/campaigns\/test-slug\/sections\/HeroSection0\.tsx/);
  assert.match(files, /app\/campaigns\/test-slug\/page\.tsx/);
  assert.match(files, /CODEGEN_LOG\.md/);
});

test("approveRun rejects a run that isn't staged_for_review", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "review-actions-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "approve-run-2";
  await runStore.createRun({ runId, slug: "x", campaignName: "X" });
  // freshly created run is "queued", not "staged_for_review"

  await assert.rejects(() => approveRun(runId), (err) => {
    assert.ok(err instanceof ReviewActionError);
    assert.equal(err.reason, "wrong_status");
    return true;
  });
});

test("approveRun rejects a nonexistent run", async () => {
  await assert.rejects(() => approveRun("does-not-exist"), (err) => {
    assert.ok(err instanceof ReviewActionError);
    assert.equal(err.reason, "not_found");
    return true;
  });
});

test("abandonRun marks a run abandoned without committing anything", async () => {
  const runId = "abandon-run-1";
  await runStore.createRun({ runId, slug: "x", campaignName: "X" });
  await runStore.updateRun(runId, { status: "staged_for_review" }); // no workdir — nothing to clean up

  const result = await abandonRun(runId);
  assert.equal(result.ok, true);
  assert.equal(result.status, "abandoned");

  const run = await runStore.getRun(runId);
  assert.equal(run.status, "abandoned");
  assert.equal(run.prUrl, null);
});

test("abandonRun rejects a run that's already terminal", async () => {
  const runId = "abandon-run-2";
  await runStore.createRun({ runId, slug: "x", campaignName: "X" });
  await runStore.updateRun(runId, { status: "completed" });

  await assert.rejects(() => abandonRun(runId), (err) => {
    assert.ok(err instanceof ReviewActionError);
    assert.equal(err.reason, "wrong_status");
    return true;
  });
});

test("abandonRun rejects a nonexistent run", async () => {
  await assert.rejects(() => abandonRun("does-not-exist"), (err) => {
    assert.ok(err instanceof ReviewActionError);
    assert.equal(err.reason, "not_found");
    return true;
  });
});

test("isScratchWorktree only accepts per-run dirs under WORKDIR_ROOT", () => {
  const root = path.resolve(config.workdirRoot);
  assert.equal(isScratchWorktree(path.join(root, "some-run-id")), true);
  assert.equal(isScratchWorktree(path.join(root, "_base")), false);
  assert.equal(isScratchWorktree(root), false);
  assert.equal(isScratchWorktree("/tmp/not-scratch"), false);
  assert.equal(isScratchWorktree(null), false);
});
