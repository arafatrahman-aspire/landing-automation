import path from "node:path";
import { readFile, access } from "node:fs/promises";

/* Checks whether a static frame candidate's component actually EXISTS in the
 * freshly-cloned target repo, before the pipeline commits to templating
 * against it.
 *
 * Why this exists: a static section is templated from the catalog, NOT
 * written by the coding agent — so if the catalog names a component the repo
 * doesn't actually have, the generated import is unresolvable and the build
 * fails PERMANENTLY. The verify-failure retry can't rescue it either, because
 * the retry regenerates the exact same catalog-derived import. A real run hit
 * precisely this: the whole analyze/ frame directory was untracked in git, so
 * every fresh `git worktree` checkout was missing it and all four static
 * sections failed with "Module not found".
 *
 * With this check, a missing frame downgrades that section to ai-required
 * (the coding agent writes it from scratch) instead of guaranteeing a failed
 * run. */

// Tried in order against a resolved alias target, since the catalog's
// importPath is extensionless (as it appears in a real import statement).
const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

async function fileExists(absPath) {
  return access(absPath).then(() => true, () => false);
}

/** Reads compilerOptions.paths from tsconfig.json, falling back to
 *  jsconfig.json — the same two files Next.js/Vite themselves read. Returns
 *  null (not a throw) when neither is present or parseable: an unreadable
 *  config is a reason to fall back to plain-relative resolution below, not to
 *  fail a run. */
async function readPathAliases(workdir) {
  for (const configName of ["tsconfig.json", "jsconfig.json"]) {
    const configPath = path.join(workdir, configName);
    try {
      const raw = await readFile(configPath, "utf8");
      // Strip // line comments and trailing commas — both are legal in the
      // JSONC these config files are usually written in, and both break JSON.parse.
      const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
      const parsed = JSON.parse(stripped);
      const paths = parsed?.compilerOptions?.paths;
      if (!paths || typeof paths !== "object") continue;
      // `baseUrl` is optional in modern TS; when absent, path targets resolve
      // relative to the config file's own directory.
      const baseUrl = parsed.compilerOptions.baseUrl ?? ".";
      return { paths, baseDir: path.join(workdir, baseUrl) };
    } catch {
      // missing or malformed — try the next candidate
    }
  }
  return null;
}

/** Expands one import specifier through a TS `paths` entry. TS allows at most
 *  one `*` per pattern, matched as a prefix/suffix pair. */
function expandAlias(specifier, pattern, targets) {
  const starIndex = pattern.indexOf("*");

  if (starIndex === -1) {
    return specifier === pattern ? [...targets] : [];
  }

  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return [];

  const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
  return targets.map((target) => target.replace("*", wildcard));
}

/**
 * Resolves a frame candidate's `importPath` (e.g.
 * "@components/frames/landing/analyze/FaqAccordionFrame") to a real file
 * inside the cloned repo.
 *
 * @returns {Promise<string|null>} absolute path to the resolved file, or null if it doesn't exist
 */
export async function resolveFrameFile({ workdir, importPath }) {
  if (!workdir || !importPath) return null;

  const aliasConfig = await readPathAliases(workdir);
  const candidateBases = [];

  if (aliasConfig) {
    for (const [pattern, targets] of Object.entries(aliasConfig.paths)) {
      if (!Array.isArray(targets)) continue;
      for (const expanded of expandAlias(importPath, pattern, targets)) {
        candidateBases.push(path.resolve(aliasConfig.baseDir, expanded));
      }
    }
  }

  // Fallbacks for repos with no usable alias config: treat the specifier as
  // repo-relative, and as src/-relative (by far the most common convention).
  if (candidateBases.length === 0 && !importPath.startsWith("@")) {
    candidateBases.push(path.resolve(workdir, importPath));
    candidateBases.push(path.resolve(workdir, "src", importPath));
  }

  for (const base of candidateBases) {
    for (const ext of SOURCE_EXTENSIONS) {
      if (await fileExists(base + ext)) return base + ext;
    }
    // Directory-style import (…/Foo resolving to …/Foo/index.tsx)
    for (const ext of SOURCE_EXTENSIONS) {
      const indexPath = path.join(base, `index${ext}`);
      if (await fileExists(indexPath)) return indexPath;
    }
  }

  return null;
}

/**
 * Which of the given frame candidates actually exist in this repo.
 *
 * @param {object} p
 * @param {string} p.workdir
 * @param {Array<{id: string, importPath: string}>} p.candidates
 * @returns {Promise<Set<string>>} the ids that resolved to a real file
 */
export async function findAvailableFrameIds({ workdir, candidates }) {
  const available = new Set();
  await Promise.all(
    candidates.map(async (candidate) => {
      const resolved = await resolveFrameFile({ workdir, importPath: candidate.importPath });
      if (resolved) available.add(candidate.id);
    })
  );
  return available;
}
