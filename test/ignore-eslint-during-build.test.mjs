import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  shouldIgnoreEslintDuringBuild,
  patchNextConfigSource,
  applyIgnoreEslintDuringBuild,
} from "../src/verify/ignore-eslint-during-build.mjs";

test("shouldIgnoreEslintDuringBuild is true for Next ≤14 + ESLint ≥9", () => {
  assert.equal(
    shouldIgnoreEslintDuringBuild({
      dependencies: { next: "^14.2.14" },
      devDependencies: { eslint: "^9.0.0" },
    }),
    true
  );
  assert.equal(
    shouldIgnoreEslintDuringBuild({
      dependencies: { next: "14.2.14", eslint: "9.16.0" },
    }),
    true
  );
});

test("shouldIgnoreEslintDuringBuild is false when versions do not mismatch", () => {
  assert.equal(shouldIgnoreEslintDuringBuild(null), false);
  assert.equal(shouldIgnoreEslintDuringBuild({}), false);
  assert.equal(
    shouldIgnoreEslintDuringBuild({ dependencies: { next: "^14.2.14" } }),
    false
  );
  assert.equal(
    shouldIgnoreEslintDuringBuild({
      dependencies: { next: "^14.2.14", eslint: "^8.57.0" },
    }),
    false
  );
  assert.equal(
    shouldIgnoreEslintDuringBuild({
      dependencies: { next: "^15.0.0" },
      devDependencies: { eslint: "^9.0.0" },
    }),
    false
  );
  assert.equal(
    shouldIgnoreEslintDuringBuild({
      dependencies: { next: "^16.0.0", eslint: "^9.0.0" },
    }),
    false
  );
});

test("patchNextConfigSource inserts eslint.ignoreDuringBuilds on a typical nextConfig object", () => {
  const src = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
`;
  const { source, changed } = patchNextConfigSource(src);
  assert.equal(changed, true);
  assert.match(source, /eslint:\s*\{\s*ignoreDuringBuilds:\s*true\s*\}/);
  assert.match(source, /reactStrictMode: true/);
});

test("patchNextConfigSource inserts into export default {", () => {
  const { source, changed } = patchNextConfigSource("export default {\n  reactStrictMode: true,\n};\n");
  assert.equal(changed, true);
  assert.match(source, /eslint:\s*\{\s*ignoreDuringBuilds:\s*true\s*\}/);
});

test("patchNextConfigSource adds ignoreDuringBuilds to an existing eslint block", () => {
  const src = `const nextConfig = {\n  eslint: {\n    dirs: ["src"],\n  },\n};\n`;
  const { source, changed } = patchNextConfigSource(src);
  assert.equal(changed, true);
  assert.match(source, /eslint:\s*\{\s*\n\s*ignoreDuringBuilds:\s*true,/);
  assert.match(source, /dirs: \["src"\]/);
});

test("patchNextConfigSource is a no-op when already patched or unrecognised", () => {
  const already = `const nextConfig = {\n  eslint: { ignoreDuringBuilds: true },\n};\n`;
  assert.deepEqual(patchNextConfigSource(already), { source: already, changed: false });
  assert.deepEqual(patchNextConfigSource("module.exports = withSomething({})"), {
    source: "module.exports = withSomething({})",
    changed: false,
  });
  assert.deepEqual(patchNextConfigSource(null), { source: null, changed: false });
});

test("applyIgnoreEslintDuringBuild patches next.config.mjs on disk", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "eslint-ignore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "next.config.mjs");
  await writeFile(configPath, "const nextConfig = {\n  reactStrictMode: true,\n};\nexport default nextConfig;\n");

  const first = await applyIgnoreEslintDuringBuild(root);
  assert.equal(first.patched, true);
  assert.equal(first.path, "next.config.mjs");
  const written = await readFile(configPath, "utf8");
  assert.match(written, /ignoreDuringBuilds:\s*true/);

  const second = await applyIgnoreEslintDuringBuild(root);
  assert.equal(second.patched, false);
  assert.equal(second.path, "next.config.mjs");
});

test("applyIgnoreEslintDuringBuild returns not-patched when no next.config exists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "eslint-ignore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await applyIgnoreEslintDuringBuild(root);
  assert.deepEqual(result, { patched: false, path: null });
});
