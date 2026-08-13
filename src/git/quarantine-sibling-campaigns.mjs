import { readdir, rm, access } from "node:fs/promises";
import path from "node:path";

/* Sibling campaigns under the same parent directory (e.g. src/app/campaigns/)
 * are typechecked by `next build` even though this run never touches them.
 * A prior campaign that landed on the base branch via CONTINUE_ON_VERIFY_FAILURE
 * — e.g. soc-analyst-fast-track-bootcamp/DetailsSection1.tsx with a type error —
 * then fails EVERY subsequent run, and the classifier correctly reports
 * "NOT CAUSED BY THIS RUN". Regenerating our sections cannot fix that.
 *
 * This removes every sibling campaign directory from the run's worktree except
 * the one we are about to generate. Deletions stay local: commitPaths only
 * stages paths this run wrote, so nothing on the base branch is rewritten.
 * The PR stays additive. */

/**
 * Parent directory that holds per-slug campaign folders, derived from a
 * WRITE_PATH_ALLOWLIST template such as `src/app/campaigns/{slug}/`.
 * @param {string} allowlistTemplate
 * @returns {string|null} repo-relative parent, no trailing slash
 */
export function campaignsParentFromAllowlistTemplate(allowlistTemplate) {
  if (typeof allowlistTemplate !== "string" || !allowlistTemplate.includes("{slug}")) return null;
  const normalized = allowlistTemplate.replace(/\/+$/, "");
  const marker = "/{slug}";
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return null;
  const parent = normalized.slice(0, idx);
  return parent || null;
}

/**
 * @param {object} p
 * @param {string} p.workdir - run worktree root
 * @param {string} p.slug - campaign being generated (kept)
 * @param {string} p.campaignsParent - repo-relative parent of campaign dirs
 * @returns {Promise<{removed: string[], kept: string|null}>}
 */
export async function quarantineSiblingCampaigns({ workdir, slug, campaignsParent }) {
  if (!workdir || !slug || !campaignsParent) {
    return { removed: [], kept: null };
  }

  const parentAbs = path.join(workdir, campaignsParent);
  try {
    await access(parentAbs);
  } catch {
    return { removed: [], kept: null };
  }

  const entries = await readdir(parentAbs, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === slug) continue;
    const abs = path.join(parentAbs, entry.name);
    await rm(abs, { recursive: true, force: true });
    removed.push(path.posix.join(campaignsParent.replace(/\\/g, "/"), entry.name));
  }

  return { removed, kept: path.posix.join(campaignsParent.replace(/\\/g, "/"), slug) };
}
