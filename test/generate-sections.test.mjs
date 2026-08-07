import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";
import { classifySections } from "../src/sections/classify-sections.mjs";

// generate-sections.mjs transitively imports llm/coding-agent.mjs -> config.mjs,
// which validates process.env at first import — must be a dynamic import
// AFTER setTestConfigEnv(), never a static top-of-file import (same
// convention as test/sqlite-repository.test.mjs / test/draft-store.test.mjs).
setTestConfigEnv();
const { buildStaticSectionFile, generateSections } = await import("../src/sections/generate-sections.mjs");

test("buildStaticSectionFile produces real, importable wrapper content for a static section", () => {
  const [faqSection] = classifySections([{ type: "faq", summary: "3 common questions" }]);
  const built = buildStaticSectionFile(faqSection, { allowlistBase: "app/campaigns/x/", index: 0 });
  assert.equal(built.path, "app/campaigns/x/sections/FaqSection0.tsx");
  assert.equal(built.componentName, "FaqSection0");
  assert.match(built.content, /export default function FaqSection0/);
});

test("buildStaticSectionFile throws for an ai-required section (no frameId to look up)", () => {
  const [heroSection] = classifySections([{ type: "hero", summary: "Title, video, lead form" }]);
  assert.throws(() => buildStaticSectionFile(heroSection, { allowlistBase: "app/campaigns/x/", index: 0 }));
});

test("generateSections writes real files for an all-static section list (no LLM/network involved)", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "generate-sections-test-"));
  try {
    const classified = classifySections([
      { type: "faq", summary: "3 common questions" },
      { type: "footer-cta", summary: "Closing CTA" },
    ]);
    const allowlist = ["app/campaigns/spring-sale/"];

    const result = await generateSections({
      classifiedSections: classified,
      workdir,
      allowlist,
      pristineFiles: new Set(),
      request: { campaignName: "Spring Sale", offer: "20% off", audience: "IT managers", cta: "Book a demo" },
      guide: { sections: classified },
    });

    assert.equal(result.codeFinished, true);
    assert.equal(result.sectionResults.length, 2);
    assert.equal(result.writtenByAgent.size, 3); // 2 sections + composed page

    for (const relPath of result.writtenByAgent) {
      const content = await readFile(path.join(workdir, relPath), "utf8");
      assert.ok(content.length > 0, `${relPath} should have real content`);
    }
    const pageContent = await readFile(path.join(workdir, "app/campaigns/spring-sale/page.tsx"), "utf8");
    assert.match(pageContent, /FaqSection0/);
    assert.match(pageContent, /FooterCtaSection1/);

    assert.deepEqual(result.sectionResults.map((r) => r.slot), ["section-0", "section-1"]);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("generateSections' static writes go through the same guard as agent writes — refuses a pristine (pre-existing) path", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "generate-sections-test-"));
  try {
    const classified = classifySections([{ type: "faq", summary: "3 common questions" }]);
    const allowlist = ["app/campaigns/spring-sale/"];
    await assert.rejects(
      generateSections({
        classifiedSections: classified,
        workdir,
        allowlist,
        // Pretend this exact deterministic path already existed before the
        // run — the pristine-file guard must reject it exactly like it
        // would for the coding agent's own write_file tool.
        pristineFiles: new Set(["app/campaigns/spring-sale/sections/FaqSection0.tsx"]),
        request: { campaignName: "x", offer: "x", audience: "x", cta: "x" },
        guide: { sections: classified },
      }),
      /existed before this run/
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

/* Targeted repair. Without this, a verify-failure retry regenerated every
 * ai-required section, so a section that already compiled could come back
 * broken — three real runs each failed on a different unrelated mistake. */

test("a targeted retry keeps sections the build did not blame, byte for byte", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "targeted-retry-"));
  try {
    const classified = classifySections([
      { type: "faq", summary: "3 common questions" },
      { type: "footer-cta", summary: "Closing CTA" },
    ]);
    const allowlist = ["app/campaigns/spring-sale/"];
    const request = { campaignName: "x", offer: "x", audience: "x", cta: "x" };

    // First pass — everything generated normally.
    const first = await generateSections({
      classifiedSections: classified,
      workdir,
      allowlist,
      pristineFiles: new Set(),
      request,
      guide: { sections: classified },
    });

    const untouchedPath = path.join(workdir, "app/campaigns/spring-sale/sections/FaqSection0.tsx");
    await writeFile(untouchedPath, "// hand-marked so a rewrite would be detectable\n");
    const markedBefore = await readFile(untouchedPath, "utf8");

    // Retry blaming ONLY the footer-cta file.
    const second = await generateSections({
      classifiedSections: classified,
      workdir,
      allowlist,
      pristineFiles: new Set(),
      request,
      guide: { sections: classified },
      verifyReport: "Failed to compile.\napp/campaigns/spring-sale/sections/FooterCtaSection1.tsx\nType error: boom",
      retryFailedPaths: new Set(["app/campaigns/spring-sale/sections/FooterCtaSection1.tsx"]),
      previousSectionResults: first.sectionResults,
    });

    // The unblamed section was left completely alone.
    assert.equal(await readFile(untouchedPath, "utf8"), markedBefore, "an unblamed section must not be regenerated");

    // Its result is carried forward unchanged, so staging still sees every file.
    const faq = second.sectionResults.find((r) => r.slot === "section-0");
    assert.equal(faq.path, "app/campaigns/spring-sale/sections/FaqSection0.tsx");
    assert.equal(second.sectionResults.length, 2);
    assert.equal(second.writtenByAgent.size, 3); // 2 sections + composed page
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("with no blamed files, a retry falls back to regenerating everything", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "untargeted-retry-"));
  try {
    const classified = classifySections([{ type: "faq", summary: "q" }]);
    const allowlist = ["app/campaigns/spring-sale/"];
    const request = { campaignName: "x", offer: "x", audience: "x", cta: "x" };

    const first = await generateSections({
      classifiedSections: classified, workdir, allowlist, pristineFiles: new Set(), request, guide: { sections: classified },
    });

    const p = path.join(workdir, "app/campaigns/spring-sale/sections/FaqSection0.tsx");
    await writeFile(p, "// clobbered\n");

    // Blame nothing — the failure couldn't be attributed to a file.
    await generateSections({
      classifiedSections: classified, workdir, allowlist, pristineFiles: new Set(), request, guide: { sections: classified },
      verifyReport: "npm ERR! something exploded",
      retryFailedPaths: new Set(),
      previousSectionResults: first.sectionResults,
    });

    const after = await readFile(p, "utf8");
    assert.notEqual(after, "// clobbered\n", "an unattributable failure must regenerate everything");
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});
