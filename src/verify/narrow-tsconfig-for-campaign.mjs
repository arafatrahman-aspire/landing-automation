import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

/**
 * Next's typecheck uses tsconfig `include`. The target repo includes every
 * ts/tsx file, so `next build` typechecks the whole marketing site. Narrowing
 * include to this campaign + root layout still typechecks anything those
 * files import (SiteLayout, frames, …) and skips unused pages.
 *
 * Worktree-only; never committed.
 */
export function patchTsconfigInclude(source, { campaignsParent, slug }) {
  if (typeof source !== "string" || !campaignsParent || !slug) {
    return { source, changed: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { source, changed: false };
  }
  const campaignGlobTs = `${campaignsParent}/${slug}/**/*.ts`;
  const campaignGlobTsx = `${campaignsParent}/${slug}/**/*.tsx`;
  const next = {
    ...parsed,
    include: [
      "next-env.d.ts",
      ".next/types/**/*.ts",
      campaignGlobTs,
      campaignGlobTsx,
      "src/app/layout.tsx",
      "src/app/layout.ts",
      "src/app/not-found.tsx",
      "src/app/**/*.css",
    ],
  };
  return { source: `${JSON.stringify(next, null, 2)}\n`, changed: true };
}

export async function applyCampaignTsconfig(workdir, { campaignsParent, slug }) {
  const filePath = path.join(workdir, "tsconfig.json");
  const exists = await access(filePath).then(() => true, () => false);
  if (!exists) return { patched: false };
  const original = await readFile(filePath, "utf8");
  const { source, changed } = patchTsconfigInclude(original, { campaignsParent, slug });
  if (changed) await writeFile(filePath, source, "utf8");
  return { patched: changed };
}
