import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const NEXT_CONFIG_NAMES = ["next.config.mjs", "next.config.js", "next.config.ts", "next.config.cjs"];

/**
 * Next 14's `next build` runs ESLint as part of compile. The target repo
 * ships eslint@9 + eslint-config-next@16 while still on Next 14, so that
 * step dies with "Invalid Options: useEslintrc, extensions" and the whole
 * build exits 1 — even when types are clean.
 *
 * Setting eslint.ignoreDuringBuilds in the worktree next.config skips that
 * broken step. The file is never committed (commitPaths only stages campaign
 * files). Callers should only invoke this when shouldIgnoreEslintDuringBuild
 * is true.
 */
export function shouldIgnoreEslintDuringBuild(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next || !deps.eslint) return false;
  const nextMajor = firstMajor(deps.next);
  const eslintMajor = firstMajor(deps.eslint);
  return nextMajor != null && nextMajor <= 14 && eslintMajor != null && eslintMajor >= 9;
}

function firstMajor(spec) {
  const m = String(spec).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Pure string transform — used by tests and applyIgnoreEslintDuringBuild. */
export function patchNextConfigSource(source) {
  if (typeof source !== "string") return { source, changed: false };
  if (/ignoreDuringBuilds\s*:\s*true/.test(source)) return { source, changed: false };

  if (/\beslint\s*:\s*\{/.test(source)) {
    return {
      source: source.replace(/\beslint\s*:\s*\{/, "eslint: {\n    ignoreDuringBuilds: true,"),
      changed: true,
    };
  }

  const anchor = /(const\s+nextConfig\s*=\s*\{|export\s+default\s+\{)/;
  if (!anchor.test(source)) return { source, changed: false };
  return {
    source: source.replace(anchor, (m) => `${m}\n  eslint: { ignoreDuringBuilds: true },`),
    changed: true,
  };
}

/**
 * @param {string} workdir - package.json directory (repo root or monorepo app)
 * @returns {Promise<{patched: boolean, path: string|null}>}
 */
export async function applyIgnoreEslintDuringBuild(workdir) {
  for (const name of NEXT_CONFIG_NAMES) {
    const filePath = path.join(workdir, name);
    const exists = await access(filePath).then(() => true, () => false);
    if (!exists) continue;
    const original = await readFile(filePath, "utf8");
    const { source, changed } = patchNextConfigSource(original);
    if (changed) await writeFile(filePath, source, "utf8");
    return { patched: changed, path: name };
  }
  return { patched: false, path: null };
}
