import { readdir, mkdir, rename, access } from "node:fs/promises";
import path from "node:path";

/* `next build` compiles every App Router page in the worktree. The Aspire
 * site has ~100 of them; this campaign only needs root layout + its own
 * `campaigns/{slug}` route. Moving the rest under `_verify_skip` (a private
 * App Router folder, never a route) cuts compile/typecheck to the page we
 * actually generated. Files stay on disk for a later refine to read.
 *
 * Local to the worktree — commitPaths only stages campaign files. */

const SKIP_DIR = "_verify_skip";

const KEEP_APP_DIRS = new Set(["campaigns", SKIP_DIR]);

const KEEP_APP_FILE = /^(layout|template|error|global-error|not-found|loading|default|globals|favicon|icon|apple-icon|opengraph-image|twitter-image|robots|sitemap|manifest)(\.|$)/i;

export function appDirFromCampaignsParent(campaignsParent) {
  if (typeof campaignsParent !== "string" || !campaignsParent) return null;
  const normalized = campaignsParent.replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = path.posix.dirname(normalized);
  return parent === "." ? null : parent;
}

/**
 * @param {object} p
 * @param {string} p.workdir
 * @param {string|null} p.campaignsParent - e.g. src/app/campaigns
 * @returns {Promise<{moved: string[], appDir: string|null}>}
 */
export async function quarantineUnrelatedAppRoutes({ workdir, campaignsParent }) {
  const appDir = appDirFromCampaignsParent(campaignsParent);
  if (!workdir || !appDir) return { moved: [], appDir: null };

  const appAbs = path.join(workdir, appDir);
  try {
    await access(appAbs);
  } catch {
    return { moved: [], appDir };
  }

  const skipAbs = path.join(appAbs, SKIP_DIR);
  await mkdir(skipAbs, { recursive: true });

  const entries = await readdir(appAbs, { withFileTypes: true });
  const moved = [];
  for (const entry of entries) {
    if (KEEP_APP_DIRS.has(entry.name)) continue;
    if (!entry.isDirectory() && KEEP_APP_FILE.test(entry.name)) continue;
    const from = path.join(appAbs, entry.name);
    const to = path.join(skipAbs, entry.name);
    try {
      await access(to);
      continue; // already moved on a previous verify of this worktree
    } catch {
      await rename(from, to);
      moved.push(path.posix.join(appDir.replace(/\\/g, "/"), entry.name));
    }
  }

  return { moved, appDir };
}
