import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { patchNextConfigRemotePatterns, applySupabaseImageRemotePattern } from "../src/verify/allow-supabase-images.mjs";

test("patchNextConfigRemotePatterns inserts images.remotePatterns on a typical nextConfig object", () => {
  const src = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
`;
  const { source, changed } = patchNextConfigRemotePatterns(src);
  assert.equal(changed, true);
  assert.match(source, /\*\*\.supabase\.co/);
  assert.match(source, /remotePatterns/);
  assert.match(source, /reactStrictMode: true/);
});

test("patchNextConfigRemotePatterns adds an entry to an existing remotePatterns array", () => {
  const src = `const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.example.com" },
    ],
  },
};
`;
  const { source, changed } = patchNextConfigRemotePatterns(src);
  assert.equal(changed, true);
  assert.match(source, /\*\*\.supabase\.co/);
  assert.match(source, /cdn\.example\.com/);
});

test("patchNextConfigRemotePatterns is a no-op when supabase is already allowlisted", () => {
  const already = `const nextConfig = {\n  images: { remotePatterns: [{ hostname: "**.supabase.co" }] },\n};\n`;
  assert.deepEqual(patchNextConfigRemotePatterns(already), { source: already, changed: false });
  const star = `const nextConfig = {\n  images: { remotePatterns: [{ hostname: "*.supabase.co" }] },\n};\n`;
  assert.deepEqual(patchNextConfigRemotePatterns(star), { source: star, changed: false });
});

test("applySupabaseImageRemotePattern patches next.config.mjs on disk", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "supabase-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "next.config.mjs");
  await writeFile(configPath, "const nextConfig = {\n  reactStrictMode: true,\n};\nexport default nextConfig;\n");

  const first = await applySupabaseImageRemotePattern(root);
  assert.equal(first.patched, true);
  assert.equal(first.path, "next.config.mjs");
  const written = await readFile(configPath, "utf8");
  assert.match(written, /\*\*\.supabase\.co/);

  const second = await applySupabaseImageRemotePattern(root);
  assert.equal(second.patched, false);
  assert.equal(second.path, "next.config.mjs");
});
