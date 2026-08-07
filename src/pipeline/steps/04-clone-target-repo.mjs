import path from "node:path";
import { mkdir, access } from "node:fs/promises";
import { config } from "../../config.mjs";
import * as runStore from "../../state/campaign-repository.mjs";
import { cloneShallow, syncBaseToLatest, addWorktree, removeWorktree, listTrackedFiles, setRemoteAuth } from "../../git/clone-and-commit.mjs";
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
      await syncBaseToLatest({ dir: baseDir, branch: config.github.baseBranch });
    }
  });

  const branchName = `codegen/${state.request.slug}-${state.runId.slice(0, 8)}`;

  // A resumed run (pipeline/resume-interrupted-runs.mjs) may still have the
  // worktree and branch its previous lifetime created — `git worktree add`
  // refuses to reuse either name, so clear them out first. Best-effort: on a
  // normal first run there's nothing there and this is a no-op.
  const stale = await access(workdir).then(() => true, () => false);
  if (stale) {
    await logStage(state.runId, `clone: found a leftover worktree at ${workdir} (resumed run) — removing it before re-checkout`);
    await removeWorktree({ baseDir, workdir, branchName }).catch(() => {});
  }

  await addWorktree({ baseDir, workdir, branchName, baseBranch: config.github.baseBranch });

  const pristineFiles = await listTrackedFiles({ dir: workdir });
  await logStage(state.runId, `clone: snapshot done, ${pristineFiles.size} tracked files`);

  await runStore.updateRun(state.runId, { branchName, workdir });
  await logStage(state.runId, `clone: done, branch "${branchName}" checked out into its own worktree`);
  return { workdir, pristineFiles, branchName, baseDir };
}
