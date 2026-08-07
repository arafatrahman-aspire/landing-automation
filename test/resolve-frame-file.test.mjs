import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFrameFile, findAvailableFrameIds } from "../src/design-catalog/resolve-frame-file.mjs";

/* Regression cover for the real production failure this module exists to
 * prevent: the target repo's whole analyze/ frame directory was untracked in
 * git, so every fresh worktree checkout lacked it, and all four static
 * sections generated unresolvable imports ("Module not found"). */

async function makeRepo({ tsconfig, files = [] }) {
  const dir = await mkdtemp(path.join(tmpdir(), "frame-resolve-"));
  if (tsconfig) await writeFile(path.join(dir, "tsconfig.json"), tsconfig);
  for (const rel of files) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "export default function X() { return null; }\n");
  }
  return dir;
}

// Mirrors the REAL atss-frontend tsconfig: "@*" -> "./src/*", no baseUrl.
const REAL_TSCONFIG = JSON.stringify({
  compilerOptions: { paths: { "@*": ["./src/*"] } },
});

test("resolves an aliased import to a real .tsx file through tsconfig paths", async () => {
  const dir = await makeRepo({
    tsconfig: REAL_TSCONFIG,
    files: ["src/components/frames/landing/analyze/FaqAccordionFrame.tsx"],
  });
  try {
    const resolved = await resolveFrameFile({
      workdir: dir,
      importPath: "@components/frames/landing/analyze/FaqAccordionFrame",
    });
    assert.ok(resolved, "should resolve");
    assert.match(resolved, /FaqAccordionFrame\.tsx$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns null when the aliased file does NOT exist — the untracked-analyze-dir bug", async () => {
  // tsconfig is present and the alias is valid; the component simply isn't
  // in this checkout, exactly as when analyze/ was untracked in git.
  const dir = await makeRepo({ tsconfig: REAL_TSCONFIG, files: ["src/components/frames/Frame1.tsx"] });
  try {
    const resolved = await resolveFrameFile({
      workdir: dir,
      importPath: "@components/frames/landing/analyze/FaqAccordionFrame",
    });
    assert.equal(resolved, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tolerates JSONC tsconfig (comments and trailing commas)", async () => {
  const dir = await makeRepo({
    tsconfig: `{
      // path aliases
      "compilerOptions": {
        "paths": { "@/*": ["./src/*"], },
      },
    }`,
    files: ["src/components/Widget.tsx"],
  });
  try {
    const resolved = await resolveFrameFile({ workdir: dir, importPath: "@/components/Widget" });
    assert.ok(resolved, "should resolve despite comments/trailing commas");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("honors an explicit baseUrl", async () => {
  const dir = await makeRepo({
    tsconfig: JSON.stringify({ compilerOptions: { baseUrl: "./app", paths: { "@ui/*": ["./ui/*"] } } }),
    files: ["app/ui/Button.tsx"],
  });
  try {
    const resolved = await resolveFrameFile({ workdir: dir, importPath: "@ui/Button" });
    assert.ok(resolved, "baseUrl should be applied to the path target");
    assert.match(resolved, /app[/\\]ui[/\\]Button\.tsx$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolves a directory-style import via index files", async () => {
  const dir = await makeRepo({
    tsconfig: REAL_TSCONFIG,
    files: ["src/components/Card/index.tsx"],
  });
  try {
    const resolved = await resolveFrameFile({ workdir: dir, importPath: "@components/Card" });
    assert.match(resolved, /index\.tsx$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("falls back to repo-relative and src-relative when there is no tsconfig at all", async () => {
  const dir = await makeRepo({ files: ["src/components/Plain.jsx"] });
  try {
    const resolved = await resolveFrameFile({ workdir: dir, importPath: "components/Plain" });
    assert.ok(resolved, "should find it under src/ without any alias config");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findAvailableFrameIds reports exactly the candidates that exist", async () => {
  const dir = await makeRepo({
    tsconfig: REAL_TSCONFIG,
    files: ["src/components/frames/landing/analyze/RealFrame.tsx"],
  });
  try {
    const available = await findAvailableFrameIds({
      workdir: dir,
      candidates: [
        { id: "real", importPath: "@components/frames/landing/analyze/RealFrame" },
        { id: "ghost", importPath: "@components/frames/landing/analyze/GhostFrame" },
      ],
    });
    assert.deepEqual([...available], ["real"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
