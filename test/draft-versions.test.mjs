import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv({ DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "draft-store-")), "test.db") });

const repo = await import("../src/state/campaign-repository.mjs");
const draftStore = await import("../src/staging/draft-versions.mjs");
const { getDb } = await import("../src/state/database-connection.mjs");

async function makeRun(runId) {
  await repo.createRun({ runId, slug: "x", campaignName: "X" });
}

test("stageNewVersion starts at version 1 and getLatestVersion returns exactly those files", async () => {
  const runId = "draft-run-1";
  await makeRun(runId);

  const staged = await draftStore.stageNewVersion({
    runId,
    files: [
      { path: "app/campaigns/x/page.tsx", content: "export default function Page() {}" },
      { path: "app/campaigns/x/Hero.tsx", content: "export function Hero() {}" },
    ],
  });
  assert.equal(staged.version, 1);
  assert.equal(staged.fileCount, 2);

  const latest = await draftStore.getLatestVersion(runId);
  assert.equal(latest.version, 1);
  assert.equal(latest.files.length, 2);
  assert.deepEqual(
    latest.files.map((f) => f.path).sort(),
    ["app/campaigns/x/Hero.tsx", "app/campaigns/x/page.tsx"]
  );
});

test("stageNewVersion also bumps runs.current_draft_version", async () => {
  const runId = "draft-run-2";
  await makeRun(runId);
  await draftStore.stageNewVersion({ runId, files: [{ path: "a.tsx", content: "a" }] });
  await draftStore.stageNewVersion({ runId, files: [{ path: "a.tsx", content: "a2" }] });
  // current_draft_version is a resume-state column (unused by sqlite-repository's
  // getRun shape until Phase 6) — check it directly on the underlying row.
  const row = getDb().prepare("SELECT current_draft_version FROM runs WHERE run_id = ?").get(runId);
  assert.equal(row.current_draft_version, 2);
});

test("getLatestVersion returns null when nothing has been staged yet", async () => {
  const runId = "draft-run-3";
  await makeRun(runId);
  assert.equal(await draftStore.getLatestVersion(runId), null);
});

test("diffFromPrevious returns null with only one staged version", async () => {
  const runId = "draft-run-4";
  await makeRun(runId);
  await draftStore.stageNewVersion({ runId, files: [{ path: "a.tsx", content: "a" }] });
  assert.equal(await draftStore.diffFromPrevious(runId), null);
});

test("diffFromPrevious reports added, removed, and modified paths between the two latest versions", async () => {
  const runId = "draft-run-5";
  await makeRun(runId);
  await draftStore.stageNewVersion({
    runId,
    files: [
      { path: "a.tsx", content: "v1-a" },
      { path: "b.tsx", content: "v1-b" },
    ],
  });
  await draftStore.stageNewVersion({
    runId,
    files: [
      { path: "a.tsx", content: "v2-a-changed" },
      { path: "c.tsx", content: "v2-c-new" },
    ],
  });

  const diff = await draftStore.diffFromPrevious(runId);
  assert.equal(diff.fromVersion, 1);
  assert.equal(diff.toVersion, 2);
  assert.deepEqual(diff.added, ["c.tsx"]);
  assert.deepEqual(diff.removed, ["b.tsx"]);
  assert.deepEqual(diff.modified, ["a.tsx"]);
});

test("stageNewVersion tags files with sectionSlot, and page.tsx (no slot) stays null", async () => {
  const runId = "draft-run-6";
  await makeRun(runId);
  await draftStore.stageNewVersion({
    runId,
    files: [
      { path: "app/campaigns/x/sections/FaqSection0.tsx", content: "faq", sectionSlot: "section-0" },
      { path: "app/campaigns/x/sections/HeroSection1.tsx", content: "hero", sectionSlot: "section-1" },
      { path: "app/campaigns/x/page.tsx", content: "page" }, // no sectionSlot given
    ],
  });

  const latest = await draftStore.getLatestVersion(runId);
  const bySlot = Object.fromEntries(latest.files.map((f) => [f.path, f.sectionSlot]));
  assert.equal(bySlot["app/campaigns/x/sections/FaqSection0.tsx"], "section-0");
  assert.equal(bySlot["app/campaigns/x/sections/HeroSection1.tsx"], "section-1");
  assert.equal(bySlot["app/campaigns/x/page.tsx"], null);
});

test("getLatestVersionForSlot returns only that slot's file(s), at the slot's own latest version", async () => {
  const runId = "draft-run-7";
  await makeRun(runId);
  await draftStore.stageNewVersion({
    runId,
    files: [
      { path: "app/campaigns/x/sections/FaqSection0.tsx", content: "faq v1", sectionSlot: "section-0" },
      { path: "app/campaigns/x/sections/HeroSection1.tsx", content: "hero v1", sectionSlot: "section-1" },
      { path: "app/campaigns/x/page.tsx", content: "page v1" },
    ],
  });
  // A whole-run regenerate stages version 2 for everything.
  await draftStore.stageNewVersion({
    runId,
    files: [
      { path: "app/campaigns/x/sections/FaqSection0.tsx", content: "faq v2", sectionSlot: "section-0" },
      { path: "app/campaigns/x/sections/HeroSection1.tsx", content: "hero v2", sectionSlot: "section-1" },
      { path: "app/campaigns/x/page.tsx", content: "page v2" },
    ],
  });

  const slot0 = await draftStore.getLatestVersionForSlot(runId, "section-0");
  assert.equal(slot0.version, 2);
  assert.equal(slot0.files.length, 1);
  assert.equal(slot0.files[0].content, "faq v2");

  const slot1 = await draftStore.getLatestVersionForSlot(runId, "section-1");
  assert.equal(slot1.files[0].content, "hero v2");
});

test("getLatestVersionForSlot returns an empty result for a slot that was never staged", async () => {
  const runId = "draft-run-8";
  await makeRun(runId);
  await draftStore.stageNewVersion({ runId, files: [{ path: "app/campaigns/x/page.tsx", content: "page" }] });
  const result = await draftStore.getLatestVersionForSlot(runId, "section-0");
  assert.equal(result.version, null);
  assert.deepEqual(result.files, []);
});
