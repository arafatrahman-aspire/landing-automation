import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv({ DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "refine-page-db-")), "test.db") });

const runStore = await import("../src/state/campaign-repository.mjs");
const draftStore = await import("../src/staging/draft-versions.mjs");
const { matchSlotsFromInstructions, refinePage, RefineActionError } = await import("../src/pipeline/refine-section.mjs");

const SLUG = "photo-course";
const ALLOWLIST_BASE = `app/campaigns/${SLUG}/`;

const SECTIONS = [
  { slot: "section-0", type: "hero" },
  { slot: "section-1", type: "faq" },
  { slot: "section-2", type: "testimonials" },
  { slot: "section-3", type: "curriculum" },
];

test("matchSlotsFromInstructions picks FAQ / testimonials / syllabus by plain language", () => {
  assert.deepEqual(matchSlotsFromInstructions("rewrite the FAQ for photography", SECTIONS), ["section-1"]);
  assert.deepEqual(matchSlotsFromInstructions("fix testimonials and reviews", SECTIONS), ["section-2"]);
  assert.deepEqual(matchSlotsFromInstructions("update the syllabus modules", SECTIONS), ["section-3"]);
  assert.deepEqual(
    matchSlotsFromInstructions("make the FAQ and testimonials about photography", SECTIONS).sort(),
    ["section-1", "section-2"]
  );
});

test("matchSlotsFromInstructions treats whole-page phrasing as every slot", () => {
  assert.deepEqual(matchSlotsFromInstructions("soften the whole page", SECTIONS), SECTIONS.map((s) => s.slot));
  assert.deepEqual(matchSlotsFromInstructions("rewrite everything", SECTIONS), SECTIONS.map((s) => s.slot));
});

test("matchSlotsFromInstructions returns [] when nothing is named", () => {
  assert.deepEqual(matchSlotsFromInstructions("make it warmer", SECTIONS), []);
  assert.deepEqual(matchSlotsFromInstructions("", SECTIONS), []);
});

async function makeFixtureWorkdir() {
  const workdir = await mkdtemp(path.join(tmpdir(), "refine-page-fixture-"));
  await writeFile(path.join(workdir, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { build: "echo build-ok" } }));
  return workdir;
}

async function makeStagedRun({ runId, workdir, sectionResults }) {
  await runStore.createRun({
    runId,
    slug: SLUG,
    campaignName: "Weekend Photography",
    request: { slug: SLUG, campaignName: "Weekend Photography", offer: "x", audience: "x", cta: "x" },
  });
  await runStore.updateRun(runId, {
    status: "staged_for_review",
    workdir,
    guide: {
      heroTitle: "x",
      heroHasVideo: false,
      seoTitle: "x",
      seoMetaDescription: "x",
      sections: sectionResults.map((s) => ({ type: s.type, summary: "x" })),
    },
    sectionResults,
  });

  const files = [];
  for (const s of sectionResults) {
    const relDir = path.dirname(s.path);
    await mkdir(path.join(workdir, relDir), { recursive: true });
    const content = `export default function ${s.componentName}() { return null; } // v1\n`;
    await writeFile(path.join(workdir, s.path), content);
    files.push({ path: s.path, content, sectionSlot: s.slot });
  }
  const pagePath = `${ALLOWLIST_BASE}page.tsx`;
  const pageContent =
    sectionResults.map((s) => `import ${s.componentName} from "./sections/${s.componentName}";`).join("\n") +
    "\nexport default function Page() { return null; }\n";
  await mkdir(path.dirname(path.join(workdir, pagePath)), { recursive: true });
  await writeFile(path.join(workdir, pagePath), pageContent);
  files.push({ path: pagePath, content: pageContent, sectionSlot: null });
  await draftStore.stageNewVersion({ runId, files });
}

test("refinePage rewrites named sections, stages a new version, and skips the real coding agent when injected", async (t) => {
  const workdir = await makeFixtureWorkdir();
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const runId = "refine-page-1";
  const sectionResults = [
    {
      type: "faq",
      mode: "static",
      path: `${ALLOWLIST_BASE}sections/FaqSection0.tsx`,
      componentName: "FaqSection0",
      slot: "section-0",
      frameId: "faq-accordion",
      finished: true,
    },
    {
      type: "testimonials",
      mode: "ai-required",
      path: `${ALLOWLIST_BASE}sections/TestimonialsSection1.tsx`,
      componentName: "TestimonialsSection1",
      slot: "section-1",
      finished: true,
    },
  ];
  await makeStagedRun({ runId, workdir, sectionResults });

  const touched = [];
  const result = await refinePage(
    runId,
    { instructions: "Rewrite the FAQ for a photography weekend course" },
    {
      runAgent: async ({ filePath, componentName }) => {
        touched.push(filePath);
        await writeFile(
          path.join(workdir, filePath),
          `export default function ${componentName}() { return <section>photography faq</section>; }\n`
        );
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.version, 2);
  assert.deepEqual(result.slots, ["section-0"]);
  assert.equal(result.planSource, "keywords");
  assert.deepEqual(touched, [`${ALLOWLIST_BASE}sections/FaqSection0.tsx`]);

  const faq = await readFile(path.join(workdir, sectionResults[0].path), "utf8");
  assert.match(faq, /photography faq/);
  const testimonials = await readFile(path.join(workdir, sectionResults[1].path), "utf8");
  assert.match(testimonials, /\/\/ v1/, "untouched section must stay byte-identical");

  const run = await runStore.getRun(runId);
  assert.equal(run.sectionResults[0].mode, "ai-required");
  assert.equal(run.sectionResults[1].mode, "ai-required");
});

test("refinePage rejects empty instructions", async () => {
  await assert.rejects(() => refinePage("nope", { instructions: "  " }), (err) => {
    assert.ok(err instanceof RefineActionError);
    assert.equal(err.reason, "invalid_action");
    return true;
  });
});
