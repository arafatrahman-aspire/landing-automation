import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

const SOURCE_FILE_RE = /\.(jsx?|tsx?|vue)$/;
const IMPORT_SCAN_EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "vendor"]);
const IMPORT_SCAN_MAX_FILES = 3000;
const IMPORT_SCAN_MAX_EXAMPLES = 8;

// A prompt instruction alone ("go check how the repo does this") isn't
// reliable — a real run repeated the identical `react-icons/fa6` mistake on
// retry instead of looking, even after being told to. So instead of only
// asking the model to explore, this greps the cloned repo for real, working
// import lines of whatever package the previous verify failure named
// unresolvable, and hands them over as ground truth. Called from
// 06-generate-sections.mjs on a retry only, not on a fresh attempt.
export async function findExistingImportExamples({ workdir, verifyReport }) {
  if (!verifyReport) return "";
  const unresolved = [...verifyReport.matchAll(/Can't resolve '([^']+)'/g)].map((m) => m[1]);
  if (unresolved.length === 0) return "";

  // A relative specifier ("../../../components/Accordion") is a component the
  // agent INVENTED, not a package it mis-imported. Grepping for its "base
  // package" would reduce it to ".." and match nearly every relative import in
  // the repo — pages of irrelevant examples that crowd out the real feedback.
  // These get a direct instruction instead (see below).
  const relative = unresolved.filter((mod) => mod.startsWith("."));
  const packages = unresolved.filter((mod) => !mod.startsWith("."));

  const relativeAdvice =
    relative.length === 0
      ? ""
      : `\nTHESE IMPORTS POINT AT FILES THAT DO NOT EXIST — you invented them: ${relative
          .map((m) => `"${m}"`)
          .join(", ")}\nDo NOT import a project-local file unless you have opened it with read_file in this session and it exists. If you need a UI element (accordion, tabs, modal, etc.) and no real component for it exists in this repository, implement it INLINE in your own file instead of importing one.\n`;

  if (packages.length === 0) return relativeAdvice;

  const basePackages = new Set(
    packages.map((mod) => {
      const parts = mod.split("/");
      return mod.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    })
  );

  const examples = [];
  let scanned = 0;

  // Bounded scan (file-count cap, common extensions only) — this runs once
  // per retry, not per request, so a slow walk here would add up.
  async function walk(dir) {
    if (examples.length >= IMPORT_SCAN_MAX_EXAMPLES || scanned >= IMPORT_SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (examples.length >= IMPORT_SCAN_MAX_EXAMPLES || scanned >= IMPORT_SCAN_MAX_FILES) return;
      if (IMPORT_SCAN_EXCLUDED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!SOURCE_FILE_RE.test(entry.name)) continue;
      scanned++;
      let content;
      try {
        content = await readFile(full, "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!/\b(from|require)\s*\(?['"]/.test(line)) continue;
        for (const pkg of basePackages) {
          if (line.includes(pkg)) {
            examples.push(`${path.relative(workdir, full)}: ${line.trim()}`);
            break;
          }
        }
      }
    }
  }
  await walk(workdir);

  if (examples.length === 0) return relativeAdvice;
  return `${relativeAdvice}\nREAL EXISTING IMPORTS OF THE SAME PACKAGE(S), FOUND ELSEWHERE IN THIS REPO — copy the exact path used here, do not invent a different one:\n${examples
    .slice(0, IMPORT_SCAN_MAX_EXAMPLES)
    .join("\n")}\n`;
}
