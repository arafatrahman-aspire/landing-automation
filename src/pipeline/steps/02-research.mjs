import { config } from "../../config.mjs";
import * as runStore from "../../state/campaign-repository.mjs";
import { generateText, extractJson } from "../../llm/generate-text.mjs";
import { logStage } from "./log-helper.mjs";

export async function research(state) {
  await runStore.heartbeat(state.runId, "research");
  // Crash resume: a re-driven run already paid for this LLM call in its
  // previous lifetime, and the notes were persisted — reuse them rather than
  // buying the same answer twice.
  if (state.researchNotes) {
    await logStage(state.runId, "research: reusing notes persisted before the restart (resumed run)");
    return { researchNotes: state.researchNotes };
  }
  if (config.skipResearch) {
    await logStage(state.runId, "research: skipped (SKIP_RESEARCH=true)");
    return { researchNotes: null };
  }
  await logStage(state.runId, "research: querying LLM (web search)");
  const { request } = state;
  const text = await generateText({
    system: "You are a research assistant for a marketing landing page. Return ONLY valid JSON, no prose.",
    prompt: `Research this marketing campaign so a copywriter/designer can build a high-converting landing page for it. Return JSON: {"keywords": string[], "painPoints": string[], "faqQuestions": string[], "notes": string}.

Campaign: ${request.campaignName}
Offer: ${request.offer}
Audience: ${request.audience}
Brief notes: ${request.brief}`,
    webSearch: true,
    maxTokens: 8192,
    // json:true omitted while webSearch is on — Gemini tool use + responseMimeType
    // can conflict; extractJson still parses the reply.
  });
  const researchNotes = extractJson(text);
  // Persisted (not just held in LangGraph state) so a crash-resumed run can
  // skip straight past this call — see the reuse branch at the top.
  await runStore.updateRun(state.runId, { researchNotes });
  await logStage(
    state.runId,
    `research: done (${researchNotes.keywords?.length ?? 0} keywords, ${researchNotes.faqQuestions?.length ?? 0} FAQ questions)`
  );
  return { researchNotes };
}
