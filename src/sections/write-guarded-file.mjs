import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveWritePath } from "../llm/filesystem-tools.mjs";

// Writes one pre-built file through the same write guard the coding agent's
// write_file tool uses (resolveWritePath, llm/filesystem-tools.mjs).
// Static/composed files aren't agent-written, but still go through the
// identical containment/pristine/allowlist checks — for consistency with
// the agent's own writes, not just convenience. Shared by
// sections/generate-sections.mjs and pipeline/refine-section.mjs.
export async function writeGuardedFile({ workdir, allowedPrefixes, pristineFiles, relPath, content }) {
  const check = resolveWritePath({ requestedPath: relPath, workdir, allowedPrefixes, pristineFiles, writtenByAgent: new Set(), manifestPaths: null });
  if (!check.ok) {
    throw new Error(`write-guarded-file: refusing to write "${relPath}" — ${check.message}`);
  }
  await mkdir(path.dirname(check.absolutePath), { recursive: true });
  await writeFile(check.absolutePath, content);
  return check.relativePath;
}
