import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

// approve-or-edit-plan.mjs reaches config.mjs transitively (via
// run-campaign-pipeline.mjs) — dynamic import AFTER setTestConfigEnv, and a
// temp DB_PATH so these never touch the real data/campaigns.db.
setTestConfigEnv({
  DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "plan-gate-db-")), "test.db"),
});

const runStore = await import("../src/state/campaign-repository.mjs");
const { getPlan, savePlan, abandonAtPlan, PlanActionError } = await import("../src/pipeline/approve-or-edit-plan.mjs");

const PLAN = {
  heroTitle: "Become a SOC analyst in eight weeks",
  heroHasVideo: false,
  seoTitle: "SOC Analyst Bootcamp",
  seoMetaDescription: "An eight-week intensive bootcamp with live labs and placement support.",
  sections: [
    { type: "hero", summary: "Headline, promise and sign-up form." },
    { type: "curriculum", summary: "Week-by-week module breakdown." },
    { type: "faq", summary: "Common objections answered." },
  ],
};

/** A run parked at the gate, exactly as routeAfterGuide leaves one. */
async function makeRunAtGate({ status = "awaiting_plan_approval", guide = PLAN, request = {} } = {}) {
  const runId = randomUUID();
  await runStore.createRun({
    runId,
    slug: "soc-bootcamp",
    campaignName: "SOC Bootcamp",
    request: { slug: "soc-bootcamp", campaignName: "SOC Bootcamp", offer: "o", audience: "a", cta: "c", ...request },
  });
  await runStore.updateRun(runId, { status, guide });
  return runId;
}

test("getPlan returns the plan with per-section mode and layout choices", async () => {
  const runId = await makeRunAtGate();
  const plan = await getPlan(runId);

  assert.equal(plan.editable, true);
  assert.equal(plan.guide.heroTitle, PLAN.heroTitle);
  assert.equal(plan.sections.length, 3);

  // Hero is always ai-required; curriculum has no reusable fillable frame
  // (SyllabusAccordionFrame hardcodes cyber cert modules), so it is too.
  // FAQ still has a fillable static candidate.
  const [hero, curriculum, faq] = plan.sections;
  assert.equal(hero.mode, "ai-required");
  assert.equal(curriculum.mode, "ai-required");
  assert.equal(curriculum.candidates.length, 0);
  assert.equal(faq.mode, "static");
  assert.ok(faq.candidates.length > 0, "a static section must offer at least one layout to choose from");
  assert.ok(faq.candidates[0].description, "candidates need a human-readable description to be pickable");
});

test("a section the brief flagged as ai-required is reported that way", async () => {
  // The UI has to show what will actually happen, and this is the same
  // resolveSectionMode call the pipeline makes — so the two cannot drift.
  const runId = await makeRunAtGate({ request: { aiRequiredSections: ["faq"] } });
  const plan = await getPlan(runId);
  assert.equal(plan.sections.find((s) => s.type === "faq").mode, "ai-required");
});

test("getPlan still works after the gate has been passed, but says it is no longer editable", async () => {
  const runId = await makeRunAtGate({ status: "staged_for_review" });
  const plan = await getPlan(runId);
  assert.equal(plan.editable, false);
  assert.equal(plan.status, "staged_for_review");
});

test("savePlan persists an edit", async () => {
  const runId = await makeRunAtGate();
  const edited = { ...PLAN, heroTitle: "A completely different headline", sections: PLAN.sections.slice(0, 2) };

  const saved = await savePlan(runId, edited);
  assert.equal(saved.heroTitle, "A completely different headline");
  assert.equal(saved.sections.length, 2);

  const run = await runStore.getRun(runId);
  assert.equal(run.guide.heroTitle, "A completely different headline");
});

test("over-long copy is truncated, not rejected", async () => {
  // A human editing an SEO description overruns the limit at least as often as
  // a model does; both go through the same truncate-then-validate path, so
  // neither loses their work over a cosmetic overage.
  const runId = await makeRunAtGate();
  const saved = await savePlan(runId, { ...PLAN, seoMetaDescription: "x".repeat(400) });
  assert.ok(saved.seoMetaDescription.length <= 200);
});

test("a structurally invalid plan is refused with a readable reason", async () => {
  const runId = await makeRunAtGate();
  await assert.rejects(
    () => savePlan(runId, { ...PLAN, sections: [{ type: "not-a-real-section", summary: "x" }] }),
    (err) => err instanceof PlanActionError && err.reason === "invalid_plan"
  );
  await assert.rejects(
    () => savePlan(runId, { ...PLAN, heroTitle: "" }),
    (err) => err instanceof PlanActionError && err.reason === "invalid_plan"
  );
});

test("the hero cannot be removed or demoted from first position", async () => {
  // The hero carries the lead form, and verify's hero-fit check assumes it is
  // the first thing on the page — a plan without one is not a landing page.
  const runId = await makeRunAtGate();

  await assert.rejects(
    () => savePlan(runId, { ...PLAN, sections: [{ type: "faq", summary: "no hero at all" }] }),
    (err) => err instanceof PlanActionError && /exactly one "hero"/.test(err.message)
  );

  await assert.rejects(
    () => savePlan(runId, { ...PLAN, sections: [PLAN.sections[1], PLAN.sections[0]] }),
    (err) => err instanceof PlanActionError && /must be first/.test(err.message)
  );

  await assert.rejects(
    () => savePlan(runId, { ...PLAN, sections: [PLAN.sections[0], PLAN.sections[0]] }),
    (err) => err instanceof PlanActionError && /exactly one "hero"/.test(err.message)
  );
});

test("editing is refused once the run has moved past the gate", async () => {
  // Otherwise a stale browser tab could rewrite the plan of a page that has
  // already been generated from it, and the two would silently disagree.
  const runId = await makeRunAtGate({ status: "staged_for_review" });
  await assert.rejects(
    () => savePlan(runId, PLAN),
    (err) => err instanceof PlanActionError && err.reason === "wrong_status"
  );
  await assert.rejects(
    () => abandonAtPlan(runId),
    (err) => err instanceof PlanActionError && err.reason === "wrong_status"
  );
});

test("an unknown run is a not_found, not a crash", async () => {
  await assert.rejects(
    () => getPlan(randomUUID()),
    (err) => err instanceof PlanActionError && err.reason === "not_found"
  );
});

test("abandoning at the gate ends the run without generating anything", async () => {
  const runId = await makeRunAtGate();
  const result = await abandonAtPlan(runId);

  assert.deepEqual(result, { ok: true, status: "abandoned" });
  const run = await runStore.getRun(runId);
  assert.equal(run.status, "abandoned");
  // Nothing was generated, so there is nothing staged to clean up.
  assert.equal(run.error, null);
});

test("a run parked at the gate is not treated as crashed on reboot", async () => {
  // reconcileCrashedRuns must leave it alone: "resuming" it would re-drive the
  // pipeline straight past the human standing at the gate.
  const runId = await makeRunAtGate();
  const { resumable, failed: _failed } = await runStore.reconcileCrashedRuns();
  assert.ok(!resumable.includes(runId), "a run awaiting plan approval must not be auto-resumed");
  assert.equal((await runStore.getRun(runId)).status, "awaiting_plan_approval");
});

test("a run at the gate cannot be deleted — it is paused, not finished", async () => {
  const runId = await makeRunAtGate();
  const result = await runStore.deleteRun(runId);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_terminal");
});
