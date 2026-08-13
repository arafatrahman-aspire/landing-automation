import path from "node:path";
import { mkdir, access } from "node:fs/promises";
import { config } from "../../config.mjs";
import * as runStore from "../../state/campaign-repository.mjs";
import { cloneShallow, syncBaseToLatest, addWorktree, removeWorktree, listTrackedFiles, setRemoteAuth } from "../../git/clone-and-commit.mjs";
import {
  campaignsParentFromAllowlistTemplate,
  quarantineSiblingCampaigns,
} from "../../git/quarantine-sibling-campaigns.mjs";
import { logStage } from "./log-helper.mjs";

// A fresh network clone every run is slow and wasteful. Instead, a single
// persistent "base" clone lives at WORKDIR_ROOT/_base (created once, synced
// before each run), and every run gets its own isolated working directory
// via `git worktree add` — a new branch checked out into its own folder,
// sharing the base clone's object store instead of re-downloading the whole
// repo. Cleanup (git/clone-and-commit.mjs's removeWorktree) removes the
// worktree and its local branch but never touches the base clone itself.

// All runs share one `_base` checkout, so two campaigns starting close
// together would otherwise race on `_base`'s own fetch/reset/checkout —
// serialized via this lock so only one run touches `_base` at a time.
// `git worktree add` itself is safe to run concurrently against a settled
// `_base`, so only the ensure/sync step below needs to be inside the lock.
let baseCloneLock = Promise.resolve();
function withBaseCloneLock(fn) {
  const next = baseCloneLock.then(fn, fn);
  baseCloneLock = next.catch(() => {});
  return next;
}

export async function clone(state) {
  await runStore.heartbeat(state.runId, "clone");
  const workdirRoot = path.resolve(config.workdirRoot);
  const baseDir = path.join(workdirRoot, "_base");
  const workdir = path.join(workdirRoot, state.runId);
  await mkdir(workdirRoot, { recursive: true });

  const remoteUrl = config.github.cloneUrl;
  const isHttp = remoteUrl.startsWith("http");
  const token = isHttp ? config.github.token : undefined;

  await withBaseCloneLock(async () => {
    const baseExists = await access(path.join(baseDir, ".git")).then(() => true, () => false);
    if (!baseExists) {
      await logStage(state.runId, `clone: no cached base clone yet — cloning ${remoteUrl}@${config.github.baseBranch} once into ${baseDir}`);
      await cloneShallow({ remoteUrl, branch: config.github.baseBranch, dir: baseDir, token, timeoutMs: 120_000 });
      if (token) await setRemoteAuth({ dir: baseDir, remoteUrl, token });
    } else {
      await logStage(state.runId, `clone: reusing cached base clone at ${baseDir} — syncing to latest ${config.github.baseBranch} (no full re-clone)`);
      if (token) await setRemoteAuth({ dir: baseDir, remoteUrl, token });
      await syncBaseToLatest({
        dir: baseDir,
        branch: config.github.baseBranch,
        logger: (msg) => logStage(state.runId, `clone: ${msg}`),
      });
    }
  });

  const branchName = `codegen/${state.request.slug}-${state.runId.slice(0, 8)}`;

  // A resumed or previously-interrupted run may still have the directory and
  // branch its earlier lifetime created — `git worktree add` refuses to reuse
  // either name. Clear them out first; on a normal first run this is a no-op.
  //
  // Not best-effort: if the leftover can't be cleared, `worktree add` is
  // guaranteed to fail with a much less informative "already exists", so say
  // plainly what's actually wrong instead of letting that happen.
  const stale = await access(workdir).then(() => true, () => false);
  if (stale) {
    await logStage(state.runId, `clone: found a leftover directory at ${workdir} — clearing it before re-checkout`);
    const removal = await removeWorktree({ baseDir, workdir, branchName });
    if (!removal.ok) {
      throw new Error(
        `clone: a leftover directory at ${workdir} could not be removed (${removal.reason}). Delete it manually and re-run.`
      );
    }
  } else if (branchName) {
    // The directory can be gone while the branch survives (e.g. the worktree
    // was removed but the branch was not) — that alone breaks `add -b`.
    await removeWorktree({ baseDir, workdir, branchName });
  }

  await addWorktree({ baseDir, workdir, branchName, baseBranch: config.github.baseBranch });

  // Drop other campaigns from this worktree so a poisoned page that reached the
  // base branch (CONTINUE_ON_VERIFY_FAILURE → approve → merge) cannot fail
  // `next build` for every later run. Deletions are local only — commitPaths
  // stages solely what this run writes.
  const campaignsParent = campaignsParentFromAllowlistTemplate(config.writePathAllowlistTemplates[0] ?? "");
  if (campaignsParent) {
    const { removed } = await quarantineSiblingCampaigns({
      workdir,
      slug: state.request.slug,
      campaignsParent,
    });
    if (removed.length > 0) {
      await logStage(
        state.runId,
        `clone: quarantined ${removed.length} sibling campaign(s) so a pre-existing broken page cannot poison this run's build — ${removed.join(", ")}`
      );
    }
  }

  const pristineFiles = await listTrackedFiles({ dir: workdir });
  await logStage(state.runId, `clone: snapshot done, ${pristineFiles.size} tracked files`);

  await runStore.updateRun(state.runId, { branchName, workdir });
  await logStage(state.runId, `clone: done, branch "${branchName}" checked out into its own worktree`);
  return { workdir, pristineFiles, branchName, baseDir };
}
