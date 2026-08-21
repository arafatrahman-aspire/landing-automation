import { config } from "../config.mjs";
import { omnirouteGenerate, assistantTextFromChatCompletion } from "./omniroute.mjs";

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
  if (config.aiProvider === "omniroute") {
    const data = await omnirouteGenerate({ system, prompt, maxTokens, json });
    const text = assistantTextFromChatCompletion(data);
    if (!text) throw new Error("OmniRoute returned no text");
    return text;
  }
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
          // Gemini rejects responseMimeType when tools (google_search) are also
          // present — INVALID_ARGUMENT. When webSearch is on, skip the mime
          // type and let extractJson parse the free-text/fenced-JSON reply.
          ...(json && !webSearch ? { responseMimeType: "application/json" } : {}),
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

  // 1. Try direct parse.
  try {
    return JSON.parse(candidate);
  } catch (firstErr) {
    // 2. Attempt lightweight repair for the most common LLM JSON mistakes,
    //    then retry.  We don't want to hide real errors so we only swallow
    //    the repair attempt and still throw the ORIGINAL error on total failure.
    try {
      return JSON.parse(repairJson(candidate));
    } catch {
      // repair didn't help — throw the original, more informative error.
      throw new Error(`${firstErr.message} (candidate starts: ${candidate.slice(0, 120).replace(/\s+/g, " ")})`);
    }
  }
}

/**
 * Best-effort repair for malformed JSON that LLMs commonly emit:
 *  1. Trailing commas before `}` / `]`
 *  2. Literal control characters (newline, tab, …) inside string values
 *  3. Truncated arrays/objects — close any unclosed structures at the end
 *
 * Does NOT attempt to fix unescaped double-quotes inside strings (that would
 * require a full parser and is ambiguous anyway).
 */
function repairJson(raw) {
  let s = String(raw);

  // Remove trailing commas before closing brackets/braces.
  s = s.replace(/,([\s\r\n]*[}\]])/g, "$1");

  // Replace literal (unescaped) control characters inside JSON strings with
  // their escape sequences.  Walk char-by-char so we only touch string content.
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === "\\" && inString) { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) {
      // Escape raw control characters that are illegal inside JSON strings.
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        if (ch === "\n") { result += "\\n"; continue; }
        if (ch === "\r") { result += "\\r"; continue; }
        if (ch === "\t") { result += "\\t"; continue; }
        result += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
    }
    result += ch;
  }
  s = result;

  // Insert commas LLMs commonly omit between adjacent array/object elements
  // (e.g. two strings on consecutive lines with no separator).
  s = insertMissingCommas(s);

  // Close any unclosed string (truncated output).
  if (inString) s += '"';

  // Close unclosed structures: count unmatched { and [ outside strings.
  let depth = 0;
  const stack = [];
  inString = false; escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") { stack.push(ch === "{" ? "}" : "]"); depth++; }
    if (ch === "}" || ch === "]") { stack.pop(); depth--; }
  }
  // Append missing closing tokens in reverse order.
  while (stack.length) s += stack.pop();

  return s;
}

/**
 * Insert a comma wherever two JSON values sit next to each other with no
 * separator — e.g. `"a"\n"b"` inside an array, a mistake models make when an
 * array item wraps a line. Walks the string tracking whether the previous
 * token completed a value (string/number/literal/`}`/`]`) and, if the next
 * token starts a new value instead of `,`/`}`/`]`, inserts the missing comma.
 * Safe on already-valid JSON: a complete value is always followed by a
 * separator there, so `afterValue` never coincides with the start of another
 * value.
 */
function insertMissingCommas(raw) {
  const s = String(raw);
  const isLiteralChar = (c) => /[-+0-9.eEtruefalsn]/.test(c);
  let out = "";
  let inString = false;
  let escaped = false;
  let afterValue = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') { inString = false; afterValue = true; }
      i++;
      continue;
    }
    if (ch === '"') {
      if (afterValue) out += ",";
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (afterValue) out += ",";
      out += ch;
      afterValue = false;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      out += ch;
      afterValue = true;
      i++;
      continue;
    }
    if (ch === "," || ch === ":") {
      out += ch;
      afterValue = false;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    if (/[-0-9tfn]/.test(ch)) {
      if (afterValue) out += ",";
      let j = i;
      while (j < s.length && isLiteralChar(s[j])) j++;
      out += s.slice(i, j);
      afterValue = true;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
