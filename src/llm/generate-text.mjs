import { config } from "../config.mjs";

/* One-shot text/JSON generation for the non-agentic stages (research, guide,
 * file-manifest) — provider-switchable via AI_PROVIDER, plain fetch, no SDKs.
 * This is a fresh implementation (not imported from the parent project) but
 * deliberately mirrors scripts/campaign/lib/ai.mjs's shape.
 * The AGENTIC coding loop does NOT use this module — see ai/claude-agent.mjs,
 * which needs full control over a multi-turn tool-use conversation. */

export async function generateText({ system, prompt, webSearch = false, maxTokens = 8192 }) {
  if (config.aiProvider === "claude") return claudeGenerate({ system, prompt, webSearch, maxTokens });
  return geminiGenerate({ system, prompt, webSearch, maxTokens });
}

async function geminiGenerate({ system, prompt, webSearch, maxTokens }) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not set (.env)");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiApiKey },
      body: JSON.stringify({
        ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { maxOutputTokens: maxTokens },
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text) throw new Error(`Gemini returned no text (finishReason: ${data.candidates?.[0]?.finishReason})`);
  return text;
}

async function claudeGenerate({ system, prompt, webSearch, maxTokens }) {
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set (.env)");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.claudeModel,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
      ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text) throw new Error("Claude returned no text");
  return text;
}

/** Pull a JSON object out of an LLM reply (handles ```json fences and prose). */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}
