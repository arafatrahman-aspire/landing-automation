import path from "node:path";
import { readFile, readdir, access } from "node:fs/promises";
import * as runStore from "../../state/campaign-repository.mjs";
import { generateText, extractJson } from "../../llm/generate-text.mjs";
import { validateGuide, truncateGuideFields } from "../../schemas/content-guide-schema.mjs";
import { SECTION_TYPES } from "../../design-catalog/section-types.mjs";
import { resolveSectionReferences, formatReferencesForPrompt } from "../../design-catalog/resolve-references.mjs";
import { buildContentRulesPromptFragment } from "../../schemas/content-rules-prompt.mjs";
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

/* PHASE 1 — the outline: hero title/SEO copy, and just the ordered list of
 * section TYPES with a one-line THEME each (not real content yet — the
 * angle/purpose this section will cover, e.g. "why the certification pays
 * off" vs. "who's eligible"). One call, same as the whole guide used to be.
 *
 * Kept deliberately light: this call's only job is structure — which
 * sections exist, in what order, covering what distinct ground — so PHASE 2
 * (below) can give each one focused, undivided attention instead of writing
 * nine sections' worth of real content in the same breath as everything
 * else. */
async function generateOutline({ state, repoConventions, catalogExamples, contentRules, attempt }) {
  const { request, researchNotes } = state;

  const text = await generateText({
    system:
      "You plan the section-by-section structure of a marketing landing page, for a coding agent to implement inside an existing frontend repository. Return ONLY a JSON object matching the requested shape, no prose outside it.",
    json: true,
    prompt: `Plan the STRUCTURE of a new, self-contained campaign landing page — not its final content, just which sections it needs and what distinct ground each one covers. A separate pass writes each section's real content brief afterward, one section at a time.

Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
CTA: ${request.cta}
Video URL: ${request.videoUrl ?? "(none provided)"}
Brief notes: ${request.brief}
${researchNotes ? `Research: ${JSON.stringify(researchNotes)}` : ""}
${contentRules ? `\n${contentRules}\n` : ""}
TARGET REPO (just cloned):
${repoConventions}

AVAILABLE SECTION TYPES (choose ONLY from this fixed list — you cannot invent a new one), with real examples from this repo's design catalog where available:
${formatReferencesForPrompt(catalogExamples)}

Rules — STRICT length limits, every field is required, do not exceed them:
- heroTitle: 40-60 characters MAX.
- seoTitle: 70 characters MAX.
- seoMetaDescription: 200 characters MAX.
- "sections" is an ordered array drawn ONLY from: ${SECTION_TYPES.join(", ")}. Always include exactly one "hero", first. Only include other sections that genuinely make sense for this campaign (${request.pageLength ? "see PAGE LENGTH above" : "2-5 sections total is typical"}, not all 9).
- EVERY section object MUST have BOTH a "type" and a "theme" key — never omit "theme". Each theme is ONE short phrase, 100 characters MAX, naming the distinct angle THIS section covers (not overlapping any other section's angle) — a later pass turns this into the real content brief, so terse is fine here.
- heroHasVideo: true only because a Video URL was provided above; false means the hero shows a compact "what / when / who" details summary instead.
- seoTitle/seoMetaDescription: concise and accurate, not generic or keyword-stuffed.
- Output ONLY this exact JSON shape in a \`\`\`json fence, nothing else, no comments, no trailing text:
{"heroTitle": "...", "heroHasVideo": ${Boolean(request.videoUrl)}, "seoTitle": "...", "seoMetaDescription": "...", "sections": [{"type": "hero", "theme": "..."}, {"type": "faq", "theme": "..."}]}`,
  });

  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object") throw new Error("outline: parsed JSON is not an object");
  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) throw new Error("outline: 'sections' must be a non-empty array");
  for (const section of parsed.sections) {
    if (typeof section?.type !== "string" || typeof section?.theme !== "string" || !section.theme.trim()) {
      throw new Error(`outline: every section needs a string "type" and non-empty "theme" — got ${JSON.stringify(section)}`);
    }
  }
  return parsed;
}

/* PHASE 2 — one independent call per section, all concurrent (the same
 * fan-out philosophy sections/generate-sections.mjs already applies to
 * CODING: every ai-required section gets its own scoped run rather than one
 * call writing the whole page). Turns that section's outline theme into a
 * real, specific content brief — 2-4 sentences, concrete enough that the
 * later coding/templating stage can write the section straight from it
 * instead of improvising generic copy.
 *
 * Never fails the run: an elaboration failure (network error, bad JSON) just
 * falls back to the outline's own short theme as the summary — worse copy,
 * not a broken plan. */
async function elaborateSection({ section, outline, request, catalogExamples, contentRules, logger }) {
  const reference = catalogExamples.find((r) => r.sectionType === section.type);
  const referenceText = reference
    ? formatReferencesForPrompt([reference])
    : "(no design catalog example available for this section type — use your own judgment)";
  const otherSections = outline.sections
    .filter((s) => s !== section)
    .map((s) => `- ${s.type}: ${s.theme}`)
    .join("\n");

  const prompt = `Write a detailed content brief for ONE section of a marketing landing page. This brief IS the instruction a coding agent (or a data-filling layer, for simpler layouts) will use to write this section's actual content — the more specific you are here, the less generic the finished section will be.

SECTION: "${section.type}"
ITS ROLE ON THIS PAGE: ${section.theme}

OTHER SECTIONS ALREADY PLANNED FOR THIS PAGE (context only, so you don't repeat their ground — this section still needs its own complete brief):
${otherSections || "(none — this is the only section)"}

CAMPAIGN:
Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
CTA: ${request.cta}
${request.brief ? `Brief: ${request.brief}` : ""}
${contentRules ? `\n${contentRules}\n` : ""}
DESIGN REFERENCE FOR THIS SECTION TYPE:
${referenceText}

Write 2-4 sentences of SPECIFIC direction for this section: concrete claims, numbers, hooks, structure, or examples relevant to THIS campaign — not a restatement of "its role" above, and not generic marketing filler. Someone with no other context should be able to write the whole section from this brief alone. There is no character cap — be as specific as the campaign needs.

Return ONLY a fenced \`\`\`json object: {"summary": "..."}`;

  const maxAttempts = 2;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await generateText({
        system:
          'You write specific, concrete content briefs for one section of a landing page at a time. Return ONLY a JSON object of the form {"summary":"..."} with no prose outside it.',
        prompt,
        // Gemini 2.5 thinking used to consume a 512 budget entirely, leaving
        // truncated/empty JSON ("Unexpected end of JSON input") on every section.
        maxTokens: 4096,
        json: true,
      });
      const parsed = extractJson(text);
      if (typeof parsed.summary === "string" && parsed.summary.trim()) return parsed.summary.trim();
      throw new Error(`elaboration returned no usable "summary" — got ${JSON.stringify(parsed)}`);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        logger(`guide: elaboration attempt ${attempt} failed for "${section.type}", retrying — ${err.message}`);
      }
    }
  }
  logger(`guide: elaboration failed for the "${section.type}" section, falling back to its outline theme — ${lastError?.message}`);
  return section.theme;
}

export async function guide(state, { attempt = 1 } = {}) {
  await runStore.heartbeat(state.runId, "guide");
  // Crash resume: the plan was already generated and validated in a previous
  // process lifetime, and persisted below — reuse it rather than paying for
  // (and risking a different answer from) the same calls again.
  if (state.guide) {
    await logStage(state.runId, "guide: reusing the plan persisted before the restart (resumed run)");
    return { guide: state.guide };
  }
  await logStage(state.runId, `guide: planning the section structure (attempt ${attempt})`);
  const { request } = state;
  const repoConventions = await detectRepoConventions(state.workdir);

  // Resolve examples for EVERY catalog section type (not just chosen ones
  // yet — sections haven't been chosen until the outline call returns), so
  // both phases below pick from / write against real code, not a blank page.
  const catalogExamples = await resolveSectionReferences({ workdir: state.workdir, sectionTypes: SECTION_TYPES });

  // The campaign owner's own tone/brand/must-include rules, as their own
  // labelled block rather than mixed into `brief` — see content-rules-prompt.mjs.
  // Empty string when the brief sets none of them. `includeStructure: true` for
  // the outline (it's the one deciding the section list/length); Phase 2 below
  // rebuilds its own copy with `includeStructure: false`, same reasoning
  // section-agent-prompt.mjs already uses for the per-section coding prompt —
  // structural decisions are already made by the time a section is being
  // elaborated, so repeating them just invites second-guessing.
  const outlineContentRules = buildContentRulesPromptFragment(request, { includeStructure: true });

  let outline;
  try {
    outline = await generateOutline({ state, repoConventions, catalogExamples, contentRules: outlineContentRules, attempt });
  } catch (err) {
    if (attempt < 2) {
      await logStage(state.runId, `guide: outline generation failed, retrying — ${err.message}`);
      return guide(state, { attempt: attempt + 1 });
    }
    throw new Error(`guide: could not produce a valid outline after retry — ${err.message}`);
  }

  await logStage(
    state.runId,
    `guide: outline done — ${outline.sections.length} section(s): ${outline.sections.map((s) => s.type).join(", ")} — writing each section's content brief separately`
  );

  const sectionContentRules = buildContentRulesPromptFragment(request, { includeStructure: false });
  const elaboratedSummaries = await Promise.all(
    outline.sections.map((section) =>
      elaborateSection({
        section,
        outline,
        request,
        catalogExamples,
        contentRules: sectionContentRules,
        logger: (msg) => logStage(state.runId, msg),
      })
    )
  );

  const candidate = truncateGuideFields({
    heroTitle: outline.heroTitle,
    heroHasVideo: outline.heroHasVideo,
    seoTitle: outline.seoTitle,
    seoMetaDescription: outline.seoMetaDescription,
    sections: outline.sections.map((section, i) => ({ type: section.type, summary: elaboratedSummaries[i] })),
  });

  const result = validateGuide(candidate);
  if (!result.ok) {
    if (attempt < 2) {
      await logStage(state.runId, `guide: assembled plan failed schema validation, retrying from the outline — ${result.errors}`);
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
