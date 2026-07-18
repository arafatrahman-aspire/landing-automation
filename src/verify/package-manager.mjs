import { access, readdir } from "node:fs/promises";
import path from "node:path";

/* Shared Node-ecosystem helpers — used by verify/build.mjs (install+build+lint)
 * and verify/local-server.mjs (serving the built page for hero-fit/seo/a11y
 * checks), so both agree on "how do we run a script in this repo" exactly
 * once. */

export const SEARCH_EXCLUDED_DIRS = new Set(["node_modules", "vendor", ".git", "dist", "build", ".next", ".turbo"]);

export const has = (workdir, f) => access(path.join(workdir, f)).then(() => true, () => false);

/** Finds the directory containing package.json: repo root first, then one
 *  level down (covers a Laravel app whose JS/asset pipeline lives in a
 *  subfolder, or a small Next.js monorepo with apps/web/package.json). Does
 *  NOT search deeper than that — ambiguous-nested-package situations are a
 *  configuration problem for a human to resolve, not something to guess at. */
export async function findPackageJsonDir(workdir) {
  if (await has(workdir, "package.json")) return workdir;
  let entries;
  try {
    entries = await readdir(workdir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;
    const candidate = path.join(workdir, entry.name);
    if (await has(candidate, "package.json")) return candidate;
  }
  return null;
}

export async function detectPackageManager(workdir) {
  if (await has(workdir, "pnpm-lock.yaml")) return "pnpm";
  if (await has(workdir, "yarn.lock")) return "yarn";
  return "npm";
}

export const INSTALL_CMD = {
  npm: ["npm", ["ci"]],
  yarn: ["yarn", ["install", "--frozen-lockfile"]],
  pnpm: ["pnpm", ["install", "--frozen-lockfile"]],
};

export const RUN_SCRIPT_CMD = {
  npm: (script) => ["npm", ["run", script]],
  yarn: (script) => ["yarn", [script]],
  pnpm: (script) => ["pnpm", [script]],
};
