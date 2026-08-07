import path from "node:path";
import { readFile, readdir, access } from "node:fs/promises";
import { config } from "../../config.mjs";
import * as runStore from "../../state/campaign-repository.mjs";
import { generateText, extractJson } from "../../llm/generate-text.mjs";
import { validateGuide, truncateGuideFields } from "../../schemas/content-guide-schema.mjs";
import { SECTION_TYPES } from "../../design-catalog/section-types.mjs";
import { resolveSectionReferences, formatReferencesForPrompt } from "../../design-catalog/resolve-references.mjs";
import { logStage } from "./log-helper.mjs";

// The target repo's stack isn't fixed (Next.js today, Laravel or something
// else tomorrow) — this scan runs right after clone, BEFORE guide() below
// locks in any file paths, so the plan it produces describes what the repo
// actually is instead of assuming React.
async function detectRepoConventions(workdir) {
  const notes = [];

  // package.json tells us the JS framework, if there is one.
  try {
    const pkg = JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = deps.next ? "Next.js" : deps.react ? "React" : deps.vue ? "Vue" : "a Node-based frontend";
    notes.push(`package.json found (${framework} — key deps: ${Object.keys(deps).slice(0, 15).join(", ") || "none"}).`);
  } catch {
    // no package.json at root — fine, could be PHP or a monorepo subfolder
  }

  // composer.json means this is likely a PHP/Laravel repo, which changes
  // where new pages go and how they get wired up.
  const hasComposer = await access(path.join(workdir, "composer.json")).then(() => true, () => false);
  if (hasComposer) {
    notes.push(
      "composer.json found — likely a PHP/Laravel repo. New pages are probably Blade templates " +
        "(.blade.php); routing is normally registered in an existing routes file, which must NOT be " +
        "modified (pristine-file guard) — leave the new page unwired and note in the PR that a human " +
        "needs to add the route manually."
    );
  }

  // A shallow top-level directory listing — just enough signal for the model
  // to stop guessing, not a full dependency-tree walk.
  try {
    const entries = await readdir(workdir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !["node_modules", ".git", "vendor", "dist", "build", ".next"].includes(e.name))
      .map((e) => e.name);
    notes.push(`Top-level directories: ${dirs.join(", ") || "(none)"}`);
  } catch {
    // ignore — best-effort signal only
  }

  return notes.join("\n") || "(repo structure could not be inspected — explore it directly once coding starts)";
}

export async function guide(state, { attempt = 1 } = {}) {
  await runStore.heartbeat(state.runId, "guide");
  // Crash resume: the plan was already generated and validated in a previous
  // process lifetime, and persisted below — reuse it rather than paying for
  // (and risking a different answer from) the same call again.
  if (state.guide) {
    await logStage(state.runId, "guide: reusing the plan persisted before the restart (resumed run)");
    return { guide: state.guide };
  }
  await logStage(state.runId, `guide: generating a structured content/section plan (attempt ${attempt})`);
  const { request, researchNotes } = state;
  const repoConventions = await detectRepoConventions(state.workdir);

  // Resolve examples for EVERY catalog section type (not just chosen ones
  // yet — sections haven't been chosen until this very call returns), so the
  // model picks its section list having actually seen real code, not a blank page.
  const catalogExamples = await resolveSectionReferences({ workdir: state.workdir, sectionTypes: SECTION_TYPES });

  const text = await generateText({
    system:
      "You plan content and section composition for a marketing landing page, for a coding agent to implement inside an existing frontend repository. Return ONLY a fenced ```json block, no prose outside it.",
    prompt: `Plan a new, self-contained campaign landing page.

Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
CTA: ${request.cta}
Video URL: ${request.videoUrl ?? "(none provided)"}
Brief notes: ${request.brief}
${researchNotes ? `Research: ${JSON.stringify(researchNotes)}` : ""}

TARGET REPO (just cloned):
${repoConventions}

AVAILABLE SECTION TYPES (choose ONLY from this fixed list — you cannot invent a new one), with real examples from this repo's design catalog where available:
${formatReferencesForPrompt(catalogExamples)}

Rules — STRICT length limits, every field is required, do not exceed them:
- heroTitle: 40-60 characters MAX.
- seoTitle: 70 characters MAX.
- seoMetaDescription: 200 characters MAX.
- "sections" is an ordered array drawn ONLY from: ${SECTION_TYPES.join(", ")}. Always include exactly one "hero", first. Only include other sections that genuinely make sense for this campaign (2-5 sections total is typical, not all 9).
- EVERY section object MUST have BOTH a "type" and a "summary" key — never omit "summary". Each summary is ONE short sentence, 100 characters MAX.
- heroHasVideo: true only because a Video URL was provided above; false means the hero shows a compact "what / when / who" details summary instead.
- seoTitle/seoMetaDescription: concise and accurate, not generic or keyword-stuffed.
- Output ONLY this exact JSON shape in a \`\`\`json fence, nothing else, no comments, no trailing text:
{"heroTitle": "...", "heroHasVideo": ${Boolean(request.videoUrl)}, "seoTitle": "...", "seoMetaDescription": "...", "sections": [{"type": "hero", "summary": "..."}, {"type": "faq", "summary": "..."}]}`,
  });

  let parsed;
  try {
    parsed = truncateGuideFields(extractJson(text));
  } catch (err) {
    if (attempt < 2) {
      await logStage(state.runId, `guide: JSON parse failed, retrying — ${err.message}`);
      return guide(state, { attempt: attempt + 1 });
    }
    throw new Error(`guide: could not parse JSON after retry — ${err.message}`);
  }

  const result = validateGuide(parsed);
  if (!result.ok) {
    if (attempt < 2) {
      await logStage(state.runId, `guide: schema invalid, retrying — ${result.errors}`);
      return guide(state, { attempt: attempt + 1 });
    }
    throw new Error(`guide: schema invalid after retry —\n${result.errors}`);
  }

  await runStore.updateRun(state.runId, { guide: result.value });
  await logStage(
    state.runId,
    `guide: done — ${result.value.sections.length} section(s): ${result.value.sections.map((s) => s.type).join(", ")}`
  );
  return { guide: result.value };
}
