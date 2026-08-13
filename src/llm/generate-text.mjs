import { config } from "../config.mjs";

/* One-shot text/JSON generation for the non-agentic stages (research, guide,
 * file-manifest) — provider-switchable via AI_PROVIDER, plain fetch, no SDKs.
 * This is a fresh implementation (not imported from the parent project) but
 * deliberately mirrors scripts/campaign/lib/ai.mjs's shape.
 * The AGENTIC coding loop does NOT use this module — see ai/claude-agent.mjs,
 * which needs full control over a multi-turn tool-use conversation. */

/**
 * @param {object} p
 * @param {string} [p.system]
 * @param {string} p.prompt
 * @param {boolean} [p.webSearch]
 * @param {number} [p.maxTokens]
 * @param {boolean} [p.json] - ask the provider for a JSON object body (Gemini
 *   responseMimeType). Callers that parse with extractJson should set this.
 */
export async function generateText({ system, prompt, webSearch = false, maxTokens = 8192, json = false }) {
  if (config.aiProvider === "claude") return claudeGenerate({ system, prompt, webSearch, maxTokens });
  return geminiGenerate({ system, prompt, webSearch, maxTokens, json });
}

async function geminiGenerate({ system, prompt, webSearch, maxTokens, json }) {
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
        generationConfig: {
          maxOutputTokens: maxTokens,
          // Gemini 2.5 "thinking" shares the output budget. With a modest
          // maxOutputTokens (guide elaboration used 512), thoughts alone hit
          // MAX_TOKENS and the visible reply is empty or truncated mid-JSON —
          // every section then logged "Unexpected end of JSON input".
          thinkingConfig: { thinkingBudget: 0 },
          ...(json ? { responseMimeType: "application/json" } : {}),
        },
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const finishReason = data.candidates?.[0]?.finishReason;
  // Thought parts must not be concatenated into the parseable reply.
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("");
  if (!text) {
    throw new Error(`Gemini returned no text (finishReason: ${finishReason ?? "unknown"})`);
  }
  if (finishReason === "MAX_TOKENS") {
    throw new Error(`Gemini response truncated (finishReason: MAX_TOKENS) — raise maxTokens or shorten the prompt`);
  }
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
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("extractJson: empty model response");
  }

  // Optional language tag; optional newline after the opening fence (models
  // sometimes emit ```json{...}``` on one line).
  const fenced = text.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  let candidate;
  if (fenced) {
    candidate = fenced[1].trim();
  } else {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
      throw new Error(`extractJson: no JSON object found (first 200 chars): ${text.slice(0, 200)}`);
    }
    candidate = text.slice(start, end + 1);
  }

  if (!candidate) {
    throw new Error("extractJson: empty JSON candidate after fence/slice");
  }

  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`${err.message} (candidate starts: ${candidate.slice(0, 120).replace(/\s+/g, " ")})`);
  }
}
