import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSectionReferences, formatReferencesForPrompt } from "../src/design/resolve.mjs";

/* Exercises against the REAL shipped src/design/catalog.mjs (hero's first
 * reference file is components/Hero.tsx) rather than mocking the catalog —
 * consistent with this repo's "real fixture, no mocks" test convention. */

test("resolves content for a reference file that exists, and returns null (not a throw) for one that doesn't", async (t) => {
  const workdir = await mkdtemp(path.join(tmpdir(), "resolve-test-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  await mkdir(path.join(workdir, "components"), { recursive: true });
  await writeFile(path.join(workdir, "components", "Hero.tsx"), "export function Hero() { return null; }");
  // app/about/page.tsx (hero's OTHER reference file) deliberately left missing.

  const resolved = await resolveSectionReferences({ workdir, sectionTypes: ["hero"] });
  assert.equal(resolved.length, 1);
  const heroFiles = resolved[0].files;
  const found = heroFiles.find((f) => f.path === "components/Hero.tsx");
  const missing = heroFiles.find((f) => f.path === "app/about/page.tsx");
  assert.ok(found.content.includes("export function Hero"));
  assert.equal(missing.content, null);
});

test("a section type with no catalog entry resolves to nothing (never throws)", async (t) => {
  const workdir = await mkdtemp(path.join(tmpdir(), "resolve-test-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));

  const resolved = await resolveSectionReferences({ workdir, sectionTypes: ["not-a-catalog-key"] });
  assert.deepEqual(resolved, []);
});

test("formatReferencesForPrompt renders found and not-found files distinctly, and handles an empty list", async (t) => {
  const workdir = await mkdtemp(path.join(tmpdir(), "resolve-test-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));

  const resolved = await resolveSectionReferences({ workdir, sectionTypes: ["hero"] });
  const text = formatReferencesForPrompt(resolved);
  assert.match(text, /not found in this repo/i);

  assert.match(formatReferencesForPrompt([]), /no design catalog examples resolved/i);
});
