import { config } from "../../config.mjs";
import * as runStore from "../../state/campaign-repository.mjs";
import { generateText, extractJson } from "../../llm/generate-text.mjs";
import { assignCampaignImages } from "../../assets/campaign-images.mjs";
import { logStage } from "./log-helper.mjs";

async function attachCampaignImages(state, researchNotes) {
  const notes = researchNotes && typeof researchNotes === "object" ? researchNotes : {};
  if (Array.isArray(notes.images) && notes.images.length > 0) return notes;

  const images = await assignCampaignImages({
    slug: state.request.slug,
    campaignName: state.request.campaignName,
    offer: state.request.offer,
    videoUrl: state.request.videoUrl,
    keywords: notes.keywords,
    // LLM-suggested visual queries per slot — far more Pexels-relevant than
    // raw brand names / acronyms from the keyword list.
    imageQueries: notes.imageQueries ?? null,
    pexelsApiKey: config.pexelsApiKey,
    serpApiKey: config.serpApiKey,
    supabaseUrl: config.supabaseUrl,
    supabaseServiceRoleKey: config.supabaseServiceRoleKey,
    supabaseStorageBucket: config.supabaseStorageBucket,
    logger: (msg) => logStage(state.runId, `research: ${msg}`),
  });

  if (images.length === 0) return notes;

  const next = { ...notes, images };
  await logStage(
    state.runId,
    `research: assigned ${images.length} campaign image(s) (${images.map((i) => `${i.slot}=${i.source}`).join(", ")})`
  );
  return next;
}

export async function research(state) {
  await runStore.heartbeat(state.runId, "research");
  // Crash resume: a re-driven run already paid for this LLM call in its
  // previous lifetime, and the notes were persisted — reuse them rather than
  // buying the same answer twice. Images are attached if the previous lifetime
  // stopped between the LLM call and the upload.
  if (state.researchNotes) {
    await logStage(state.runId, "research: reusing notes persisted before the restart (resumed run)");
    let researchNotes = state.researchNotes;
    try {
      researchNotes = await attachCampaignImages(state, researchNotes);
      if (researchNotes !== state.researchNotes) {
        await runStore.updateRun(state.runId, { researchNotes });
      }
    } catch (err) {
      await logStage(state.runId, `research: campaign images failed (${err.message}) — continuing without them`);
    }
    return { researchNotes };
  }
  if (config.skipResearch) {
    await logStage(state.runId, "research: skipped (SKIP_RESEARCH=true)");
    return { researchNotes: null };
  }
  await logStage(state.runId, "research: querying LLM (web search)");
  const { request } = state;
  const text = await generateText({
    system:
      "You are a research assistant for a marketing landing page. " +
      "Respond with ONLY a single valid JSON object — no markdown, no prose, no code fences. " +
      "All string values must use standard ASCII double-quotes. " +
      "Never include unescaped double-quotes, newlines, or backslashes inside string values.",
    prompt:
      `Research this marketing campaign and suggest stock photo search queries for it.\n` +
      `Return exactly this JSON shape (no extra fields):\n` +
      `{\n` +
      `  "keywords": ["keyword1", "keyword2", ...],\n` +
      `  "painPoints": ["pain point 1", ...],\n` +
      `  "faqQuestions": ["Question 1?", ...],\n` +
      `  "notes": "one paragraph of research notes",\n` +
      `  "imageQueries": {\n` +
      `    "hero": ["visually descriptive 2-3 word phrase for Pexels", "another phrase"],\n` +
      `    "details": ["phrase that shows the benefit or skill", "another phrase"],\n` +
      `    "timeline": ["phrase showing process or learning", "another phrase"]\n` +
      `  }\n` +
      `}\n` +
      `\n` +
      `For imageQueries: suggest SHORT (2-4 word), visually descriptive Pexels stock photo search terms\n` +
      `that would return RELEVANT, professional images for this campaign. Rules:\n` +
      `- Use concrete visual descriptions, NOT brand names, acronyms or jargon (e.g. NOT "Splunk" or "SIEM"\n` +
      `  but YES "security analyst workstation" or "cybersecurity dashboard")\n` +
      `- Each slot needs 2-3 different query options (Pexels may have limited results for some)\n` +
      `- hero: the main visual that represents the campaign's outcome or aspiration\n` +
      `- details: shows the skill, tool, or benefit being taught/offered\n` +
      `- timeline: shows learning, process, or progression\n` +
      `\n` +
      `Campaign: ${request.campaignName}\n` +
      `Offer: ${request.offer}\n` +
      `Audience: ${request.audience}\n` +
      `Brief notes: ${request.brief ?? "(none)"}`,
    webSearch: true,
    maxTokens: 8192,
    json: true,
  });
  let researchNotes;
  try {
    researchNotes = extractJson(text);
  } catch (parseErr) {
    // Log the raw response to help debug future failures, then re-throw.
    await logStage(state.runId, `research: JSON parse failed — raw response (first 400 chars): ${text.slice(0, 400).replace(/\n/g, " ")}`);
    throw parseErr;
  }
  try {
    researchNotes = await attachCampaignImages(state, researchNotes);
  } catch (err) {
    await logStage(state.runId, `research: campaign images failed (${err.message}) — continuing without them`);
  }
  // Persisted (not just held in LangGraph state) so a crash-resumed run can
  // skip straight past this call — see the reuse branch at the top.
  await runStore.updateRun(state.runId, { researchNotes });
  await logStage(
    state.runId,
    `research: done (${researchNotes.keywords?.length ?? 0} keywords, ${researchNotes.faqQuestions?.length ?? 0} FAQ questions)`
  );
  return { researchNotes };
}
