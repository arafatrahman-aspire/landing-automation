import { readFile } from "node:fs/promises";
import path from "node:path";
import { catalog } from "./catalog.mjs";

const MAX_REFERENCE_BYTES = 20_000;

async function readIfExists(workdir, relPath) {
  try {
    const buf = await readFile(path.join(workdir, relPath));
    const text = buf.subarray(0, MAX_REFERENCE_BYTES).toString("utf8");
    return buf.length > MAX_REFERENCE_BYTES ? `${text}\n\n[... truncated, file is ${buf.length} bytes]` : text;
  } catch {
    return null; // not curated for this repo, or the path is stale — skip, don't fail the run
  }
}

/**
 * Resolves real reference-file content for a set of section types, from the
 * ALREADY-CLONED target repo workdir. Section types with no catalog entry,
 * or whose files don't exist in this particular repo, are simply omitted
 * from the result — a missing example is a quality gap for a human to fix
 * in catalog.mjs, never a reason to fail the run.
 *
 * @param {object} p
 * @param {string} p.workdir
 * @param {string[]} p.sectionTypes
 * @returns {Promise<Array<{sectionType: string, note: string, files: Array<{path: string, content: string|null}>}>>}
 */
export async function resolveSectionReferences({ workdir, sectionTypes }) {
  const results = [];
  for (const sectionType of sectionTypes) {
    const entry = catalog[sectionType];
    if (!entry) continue;
    const files = await Promise.all(
      entry.referenceFiles.map(async (p) => ({ path: p, content: await readIfExists(workdir, p) }))
    );
    results.push({ sectionType, note: entry.note, files });
  }
  return results;
}

/** Renders resolved references into a plain-text block for an LLM prompt. */
export function formatReferencesForPrompt(resolved) {
  if (resolved.length === 0) {
    return "(no design catalog examples resolved — none configured for these sections, or none matched files in this repo)";
  }
  return resolved
    .map(({ sectionType, note, files }) => {
      const fileBlocks = files
        .map((f) =>
          f.content !== null
            ? `  Reference file: ${f.path}\n  ---\n${f.content}\n  ---`
            : `  Reference file: ${f.path} (not found in this repo — no example available, use your own judgment)`
        )
        .join("\n");
      return `### ${sectionType}\n${note}\n${fileBlocks}`;
    })
    .join("\n\n");
}
