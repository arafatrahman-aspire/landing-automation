import { access, readdir, readFile } from "node:fs/promises";
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

/** A real repo can have more than one lockfile lying around (leftover from a
 *  past package-manager migration, accidentally committed, etc.) — lockfile
 *  presence alone is then ambiguous. `package.json`'s own `packageManager`
 *  field (the field Corepack itself treats as authoritative, e.g.
 *  `"npm@10.2.3"`) is a stronger signal than "which lockfile happens to
 *  exist," so it's checked first; lockfiles are only a fallback when that
 *  field is absent. */
async function packageManagerFromField(workdir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8"));
    const name = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
    return name && name in INSTALL_CMD ? name : null;
  } catch {
    return null;
  }
}

/** @param {string} workdir
 *  @param {string|null} [override] - PACKAGE_MANAGER_OVERRIDE (config.mjs) —
 *  when set, wins over every other signal. Exists for a repo where
 *  detection picks the wrong tool (e.g. a leftover, out-of-date `yarn.lock`
 *  sitting alongside the real `package-lock.json` a repo actually uses) and
 *  a human just wants to say "always use npm here," rather than the service
 *  guessing from ambiguous repo state every run. */
export async function detectPackageManager(workdir, override) {
  if (override && override in INSTALL_CMD) return override;
  const declared = await packageManagerFromField(workdir);
  if (declared) return declared;
  if (await has(workdir, "pnpm-lock.yaml")) return "pnpm";
  if (await has(workdir, "yarn.lock")) return "yarn";
  return "npm";
}

/* yarn/pnpm are invoked via `corepack` rather than a bare `yarn`/`pnpm`
 * binary — corepack ships with Node itself (guaranteed present, unlike a
 * separately/globally installed yarn or pnpm, which this service's host
 * environment may simply not have — this is exactly what broke a real run:
 * "yarn install failed: spawn yarn ENOENT" because no global `yarn` existed
 * on PATH). `corepack yarn`/`corepack pnpm` also correctly honors the target
 * repo's own `packageManager` field in package.json when present, instead of
 * trusting whatever version happens to be on the host. npm always ships
 * with Node, so it's invoked directly.
 *
 * Deliberately NOT using frozen/CI-strict installs (`npm ci`,
 * `--frozen-lockfile`) — a real target repo's lockfile can already be out of
 * sync with its own package.json for reasons that have nothing to do with
 * this service (that's exactly what broke a real run: yarn refused to
 * install with "Your lockfile needs to be updated, but yarn was run with
 * `--frozen-lockfile`", on a repo the coding agent had not touched at all).
 * The agent can never modify an existing package.json/lockfile (the
 * pristine-file guard forbids it), and this install only ever happens in a
 * throwaway worktree that gets discarded after verify — `commitPaths` only
 * stages the declared manifest files + CODEGEN_LOG.md, so a lockfile
 * regenerated here is never committed. A plain install can safely update it
 * locally instead of hard-failing on pre-existing drift this service didn't
 * cause and can't fix by retrying code. */
export const INSTALL_CMD = {
  npm: ["npm", ["install"]],
  yarn: ["corepack", ["yarn", "install"]],
  pnpm: ["corepack", ["pnpm", "install"]],
};

export const RUN_SCRIPT_CMD = {
  npm: (script) => ["npm", ["run", script]],
  yarn: (script) => ["corepack", ["yarn", script]],
  pnpm: (script) => ["corepack", ["pnpm", script]],
};
