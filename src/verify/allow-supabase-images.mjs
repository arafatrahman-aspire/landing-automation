import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const NEXT_CONFIG_NAMES = ["next.config.mjs", "next.config.js", "next.config.ts", "next.config.cjs"];

const SUPABASE_HOST = "**.supabase.co";
const PATTERN_ENTRY = `{ protocol: "https", hostname: "${SUPABASE_HOST}" }`;

/**
 * Worktree-only next.config patch so next/image accepts campaign photos
 * hosted on Supabase Storage. Never committed (commitPaths only stages
 * campaign files). Same idea as ignore-eslint-during-build.mjs.
 */
export function patchNextConfigRemotePatterns(source) {
  if (typeof source !== "string") return { source, changed: false };
  if (source.includes("**.supabase.co") || source.includes("*.supabase.co")) {
    return { source, changed: false };
  }

  if (/\bremotePatterns\s*:\s*\[/.test(source)) {
    return {
      source: source.replace(/\bremotePatterns\s*:\s*\[/, (m) => `${m}\n      ${PATTERN_ENTRY},`),
      changed: true,
    };
  }

  if (/\bimages\s*:\s*\{/.test(source)) {
    return {
      source: source.replace(/\bimages\s*:\s*\{/, (m) => `${m}\n    remotePatterns: [\n      ${PATTERN_ENTRY},\n    ],`),
      changed: true,
    };
  }

  const anchor = /(const\s+nextConfig\s*=\s*\{|export\s+default\s+\{)/;
  if (!anchor.test(source)) return { source, changed: false };
  return {
    source: source.replace(anchor, (m) => `${m}\n  images: {\n    remotePatterns: [\n      ${PATTERN_ENTRY},\n    ],\n  },`),
    changed: true,
  };
}

/**
 * @param {string} workdir - package.json directory (repo root or monorepo app)
 * @returns {Promise<{patched: boolean, path: string|null}>}
 */
export async function applySupabaseImageRemotePattern(workdir) {
  for (const name of NEXT_CONFIG_NAMES) {
    const filePath = path.join(workdir, name);
    const exists = await access(filePath).then(() => true, () => false);
    if (!exists) continue;
    const original = await readFile(filePath, "utf8");
    const { source, changed } = patchNextConfigRemotePatterns(original);
    if (changed) await writeFile(filePath, source, "utf8");
    return { patched: changed, path: name };
  }
  return { patched: false, path: null };
}
