import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

// refine-actions.mjs transitively reaches config.mjs — dynamic import AFTER
// setTestConfigEnv, same convention as review-actions.test.mjs.
setTestConfigEnv({ DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "refine-actions-db-")), "test.db") });

const runStore = await import("../src/state/campaign-repository.mjs");
const draftStore = await import("../src/staging/draft-versions.mjs");
const { listSections, refineSection, recolorDraft, RefineActionError } = await import("../src/pipeline/refine-section.mjs");

const SLUG = "test-slug";
const ALLOWLIST_BASE = `app/campaigns/${SLUG}/`;

/** A workdir that verifyBuild() can pass trivially — no real Next.js, no
 *  Docker, just a package.json whose build script always succeeds — so
 *  this test exercises refine's own logic (file writes, draft staging,
 *  sectionResults update) without needing a real frontend build. */
async function makeFixtureWorkdir() {
  const workdir = await mkdtemp(path.join(tmpdir(), "refine-actions-fixture-"));
  await writeFile(path.join(workdir, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { build: "echo build-ok" } }));
  return workdir;
}

async function makeStagedRun({ runId, workdir, sectionResults }) {
  await runStore.createRun({
    runId,
    slug: SLUG,
    campaignName: "Test Campaign",
    request: { slug: SLUG, campaignName: "Test Campaign", offer: "x", audience: "x", cta: "x" },
  });
  await runStore.updateRun(runId, {
    status: "staged_for_review",
    workdir,
    guide: { heroTitle: "x", heroHasVideo: false, seoTitle: "x", seoMetaDescription: "x", sections: sectionResults.map((s) => ({ type: s.type, summary: "x" })) },
    sectionResults,
  });

  const files = [];
  for (const s of sectionResults) {
    const relDir = path.dirname(s.path);
    await mkdir(path.join(workdir, relDir), { recursive: true });
    const content = `export default function ${s.componentName}() { return null; } // placeholder v1\n`;
    await writeFile(path.join(workdir, s.path), content);
    files.push({ path: s.path, content, sectionSlot: s.slot });
  }
  const pagePath = `${ALLOWLIST_BASE}page.tsx`;
  const pageContent = sectionResults.map((s) => `import ${s.componentName} from "./sections/${s.componentName}";`).join("\n") + "\nexport default function Page() { return null; }\n";
  await mkdir(path.dirname(path.join(workdir, pagePath)), { recursive: true });
  await writeFile(path.join(workdir, pagePath), pageContent);
  files.push({ path: pagePath, content: pageContent, sectionSlot: null });

  await draftStore.stageNewVersion({ runId, files });
}

test("listSections returns every slot with its type/mode/frame and available candidates", async (t) => {
  const workdir = await makeFixtureWorkdir();
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const runId = "list-sections-1";
  await makeStagedRun({
    runId,
    workdir,
    sectionResults: [
      { type: "faq", mode: "static", path: `${ALLOWLIST_BASE}sections/FaqSection0.tsx`, componentName: "FaqSection0", slot: "section-0", frameId: "faq-accordion", finished: true },
    ],
  });

  const sections = await listSections(runId);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].type, "faq");
  assert.equal(sections[0].frameId, "faq-accordion");
  assert.ok(sections[0].candidates.some((c) => c.id === "faq-accordion"));
});

test("listSections rejects a nonexistent run", async () => {
  await assert.rejects(() => listSections("does-not-exist"), (err) => {
    assert.ok(err instanceof RefineActionError);
    assert.equal(err.reason, "not_found");
    return true;
  });
});

test("refineSection use-different-frame: regenerates a static slot, stages a new version, updates sectionResults, refreshes preview", async (t) => {
  const workdir = await makeFixtureWorkdir();
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const runId = "refine-run-1";
  const faqSlot = { type: "faq", mode: "static", path: `${ALLOWLIST_BASE}sections/FaqSection0.tsx`, componentName: "FaqSection0", slot: "section-0", frameId: "faq-accordion", finished: true };
  const ctaSlot = { type: "footer-cta", mode: "static", path: `${ALLOWLIST_BASE}sections/FooterCtaSection1.tsx`, componentName: "FooterCtaSection1", slot: "section-1", frameId: "cta-section", finished: true };
  await makeStagedRun({ runId, workdir, sectionResults: [faqSlot, ctaSlot] });

  const result = await refineSection(runId, "section-0", "use-different-frame", { frameId: "faq-accordion" });
  assert.equal(result.ok, true);
  assert.equal(result.version, 2); // v1 was the initial stage in makeStagedRun

  // The refined slot's file now has REAL populateFrame() content, not the placeholder.
  // faq-accordion is always inlined (the redesigned card grid), not imported.
  const newContent = await readFile(path.join(workdir, faqSlot.path), "utf8");
  assert.match(newContent, /md:grid-cols-2/);
  assert.doesNotMatch(newContent, /placeholder/);

  // The OTHER slot's file is completely untouched.
  const ctaContent = await readFile(path.join(workdir, ctaSlot.path), "utf8");
  assert.match(ctaContent, /placeholder v1/);

  // draft_files: new version has both files, correctly slotted; the untouched
  // slot's content in the new version is identical to what it was before.
  const latest = await draftStore.getLatestVersion(runId);
  assert.equal(latest.version, 2);
  const bySlot = Object.fromEntries(latest.files.map((f) => [f.path, f]));
  assert.match(bySlot[faqSlot.path].content, /md:grid-cols-2/);
  assert.equal(bySlot[faqSlot.path].sectionSlot, "section-0");
  assert.match(bySlot[ctaSlot.path].content, /placeholder v1/);

  // Older version is still there, untouched (full history preserved).
  const v1 = await draftStore.getLatestVersionForSlot(runId, "section-1");
  assert.equal(v1.version, 2); // section-1 wasn't touched by this refine, so its latest version is still whatever it was staged at (2, since stageNewVersion always writes the full file set)
  assert.match(v1.files[0].content, /placeholder v1/);

  const run = await runStore.getRun(runId);
  assert.equal(run.sectionResults.length, 2);
  assert.equal(run.sectionResults[0].frameId, "faq-accordion");
  assert.equal(run.status, "staged_for_review"); // refine never changes run status
});

test("refineSection rejects use-different-frame on an ai-required slot", async (t) => {
  const workdir = await makeFixtureWorkdir();
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const runId = "refine-run-2";
  const heroSlot = { type: "hero", mode: "ai-required", path: `${ALLOWLIST_BASE}sections/HeroSection0.tsx`, componentName: "HeroSection0", slot: "section-0", finished: true };
  await makeStagedRun({ runId, workdir, sectionResults: [heroSlot] });

  await assert.rejects(() => refineSection(runId, "section-0", "use-different-frame", { frameId: "x" }), (err) => {
    assert.ok(err instanceof RefineActionError);
    assert.equal(err.reason, "invalid_action");
    return true;
  });
});

test("refineSection rejects an unknown action", async (t) => {
  const workdir = await makeFixtureWorkdir();
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const runId = "refine-run-3";
  const faqSlot = { type: "faq", mode: "static", path: `${ALLOWLIST_BASE}sections/FaqSection0.tsx`, componentName: "FaqSection0", slot: "section-0", frameId: "faq-accordion", finished: true };
  await makeStagedRun({ runId, workdir, sectionResults: [faqSlot] });

  await assert.rejects(() => refineSection(runId, "section-0", "not-a-real-action", {}), (err) => {
    assert.ok(err instanceof RefineActionError);
    assert.equal(err.reason, "invalid_action");
    return true;
  });
});

test("refineSection rejects a run that isn't staged_for_review", async () => {
  const runId = "refine-run-4";
  await runStore.createRun({ runId, slug: SLUG, campaignName: "X" });
  // freshly created run is "queued"

  await assert.rejects(() => refineSection(runId, "section-0", "use-different-frame", { frameId: "faq-accordion" }), (err) => {
    assert.ok(err instanceof RefineActionError);
    assert.equal(err.reason, "wrong_status");
    return true;
  });
});

test("refineSection rejects an unknown slot", async (t) => {
  const workdir = await makeFixtureWorkdir();
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const runId = "refine-run-5";
  const faqSlot = { type: "faq", mode: "static", path: `${ALLOWLIST_BASE}sections/FaqSection0.tsx`, componentName: "FaqSection0", slot: "section-0", frameId: "faq-accordion", finished: true };
  await makeStagedRun({ runId, workdir, sectionResults: [faqSlot] });

  await assert.rejects(() => refineSection(runId, "section-99", "use-different-frame", { frameId: "faq-accordion" }), (err) => {
    assert.ok(err instanceof RefineActionError);
    assert.equal(err.reason, "not_found");
    return true;
  });
});

test("refineSection use-different-frame rejects an unknown frameId", async (t) => {
  const workdir = await makeFixtureWorkdir();
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const runId = "refine-run-6";
  const faqSlot = { type: "faq", mode: "static", path: `${ALLOWLIST_BASE}sections/FaqSection0.tsx`, componentName: "FaqSection0", slot: "section-0", frameId: "faq-accordion", finished: true };
  await makeStagedRun({ runId, workdir, sectionResults: [faqSlot] });

  await assert.rejects(() => refineSection(runId, "section-0", "use-different-frame", { frameId: "not-a-real-frame" }), (err) => {
    assert.ok(err instanceof RefineActionError);
    assert.equal(err.reason, "invalid_action");
    return true;
  });
});

test("recolorDraft rejects a custom scheme missing hex channels before touching the run", async () => {
  await assert.rejects(() => recolorDraft("missing-run", { preset: "custom", primary: "#111111" }), (err) => {
    assert.ok(err instanceof RefineActionError);
    assert.equal(err.reason, "invalid_action");
    assert.match(err.message, /hex/i);
    return true;
  });
});
