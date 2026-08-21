import { config } from "../config.mjs";

/* OpenAI-compatible client for a local OmniRoute gateway
 * (https://omniroute.online / http://localhost:20128/v1).
 *
 * Used when AI_PROVIDER=omniroute (one-shot research/guide/static copy) or
 * CODING_AGENT_PROVIDER=omniroute (agentic loop in omniroute-coding-agent.mjs).
 * Gemini and Claude stay on their own modules; this is additive. */

function chatUrl() {
  const base = (config.omnirouteBaseUrl || "http://localhost:20128/v1").replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

function headers() {
  const h = { "Content-Type": "application/json" };
  if (config.omnirouteApiKey) h.Authorization = `Bearer ${config.omnirouteApiKey}`;
  return h;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  }
  return content == null ? "" : String(content);
}

/** Felo / OpenCode-free reject `role: system`. Fold those into the first user turn. */
export function foldSystemIntoUserMessages(messages) {
  const systems = [];
  const rest = [];
  for (const m of messages ?? []) {
    if (m?.role === "system") systems.push(messageText(m.content));
    else rest.push(m);
  }
  const prefix = systems.filter(Boolean).join("\n\n");
  if (!prefix) return rest;
  if (rest.length === 0) return [{ role: "user", content: prefix }];
  const idx = rest.findIndex((m) => m?.role === "user");
  if (idx === -1) return [{ role: "user", content: prefix }, ...rest];
  const first = rest[idx];
  const merged = { ...first, content: `${prefix}\n\n${messageText(first.content)}` };
  return [...rest.slice(0, idx), merged, ...rest.slice(idx + 1)];
}

function hasTools(tools) {
  return Array.isArray(tools) && tools.length > 0;
}

/**
 * Chat-completions body. One-shot calls omit `max_tokens` / `response_format`
 * and fold `system` into the user message — OmniRoute `auto` often lands on
 * Felo/OpenCode-free, which 400 on those OpenAI-only fields ("Felo thread
 * creation failed"). Tool-calling keeps a fuller OpenAI shape.
 */
function resolveOmnirouteModel() {
  const requested = config.omnirouteModel || "auto";
  // gemini-web drives Gemini in a Playwright browser inside OmniRoute's
  // Docker image. That image is missing playwright-core/browsers.json, so
  // gweb/* 500s. Route those ids to the Google AI Studio provider instead.
  if (/^(gweb|gemini-web)\//i.test(requested)) return "gemini/gemini-2.5-flash";
  return requested;
}

export function buildOmnirouteChatBody({ system, prompt, maxTokens, json = false, tools = null, messages = null }) {
  const model = resolveOmnirouteModel();
  if (hasTools(tools)) {
    return {
      model,
      stream: false,
      messages: messages ?? [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
      tools,
      tool_choice: "auto",
    };
  }

  let msgs;
  if (messages) {
    msgs = foldSystemIntoUserMessages(messages);
  } else {
    const user = system ? `${system}\n\n${prompt ?? ""}` : prompt;
    msgs = [{ role: "user", content: user }];
  }
  // `json: true` asks the upstream model for a JSON object response.
  // `response_format` is an OpenAI-compatible field; simplifyOmnirouteBody
  // strips it automatically on a 400 retry so free Felo/OpenCode backends
  // that don't support it still work.
  return {
    model,
    stream: false,
    messages: msgs,
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };
}

export function omnirouteBodyCanSimplify(body) {
  if (!body || typeof body !== "object") return false;
  if (body.max_tokens != null || body.max_completion_tokens != null) return true;
  if (body.response_format) return true;
  return (body.messages ?? []).some((m) => m?.role === "system");
}

export function simplifyOmnirouteBody(body) {
  const { max_tokens: _mt, max_completion_tokens: _mct, response_format: _rf, ...rest } = body;
  return { ...rest, messages: foldSystemIntoUserMessages(body.messages ?? []) };
}

export function omniroutePoolExhaustedHint(bodyText) {
  const text = String(bodyText ?? "");
  if (/playwright|browsers\.json|gemini-web/i.test(text)) {
    return (
      "OmniRoute routed the request to a gemini-web (Playwright) backend, but Playwright is not installed in the OmniRoute Docker image. " +
      "Fix: open the OmniRoute dashboard → Providers, connect a Google AI Studio (Gemini API) account, " +
      "then set OMNIROUTE_MODEL=gemini/gemini-2.5-flash in your .env and restart this service."
    );
  }
  if (!/felo\/felo-|oc\/[a-z0-9-]+|exhausted_connection:opencode|Felo thread creation failed/i.test(text)) {
    return "";
  }
  return (
    'OmniRoute model "auto" exhausted free backends (Felo HTTP 400 / OpenCode 401). ' +
    "The OmniRoute dashboard currently has no connected provider (Home → Provider Topology: 0 active). " +
    "Open http://localhost:20128/dashboard/providers, connect a working account, " +
    "then set OMNIROUTE_MODEL to that model id (not auto) and restart this API."
  );
}

export function isOmnirouteFreePoolExhausted(errOrText) {
  const text = errOrText instanceof Error ? errOrText.message : String(errOrText ?? "");
  return Boolean(omniroutePoolExhaustedHint(text));
}

export function isOmnirouteQueueTimeout(status, bodyText) {
  const s = Number(status);
  if (s !== 503 && s !== 429 && s !== 524) return false;
  // HTTP 429 alone (any body) is always a rate-limit — retry it.
  if (s === 429) return true;
  // 503/524: only retry when the body looks like a queue/gateway timeout.
  return /maxWaitMs|RATE_LIMIT_QUEUE_TIMEOUT|rate-limit queue|job timed out after|timeout|overloaded/i.test(String(bodyText ?? ""));
}

export function formatOmnirouteHttpError(status, bodyText) {
  const head = String(bodyText ?? "").slice(0, 400);
  const hint = omniroutePoolExhaustedHint(bodyText);
  return hint ? `OmniRoute API ${status}: ${head}\n${hint}` : `OmniRoute API ${status}: ${head}`;
}

function omnirouteOrigin() {
  return (config.omnirouteBaseUrl || "http://localhost:20128/v1").replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bump the OmniRoute request-queue maxWaitMs to at least minMaxWaitMs so
 * that Gemini 2.5-flash thinking calls (which can take 60-120 s) are not
 * dropped by the gateway before they finish.
 *
 * Called at server startup and silently skipped if OmniRoute is unreachable.
 */
export async function ensureOmnirouteQueueWait({
  minMaxWaitMs = 120_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = `${omnirouteOrigin()}/api/resilience`;
  const currentRes = await fetchImpl(url, { signal: AbortSignal.timeout(4_000) });
  if (!currentRes.ok) return false;
  const current = await currentRes.json().catch(() => null);
  const maxWaitMs = Number(current?.requestQueue?.maxWaitMs) || 0;
  if (maxWaitMs >= minMaxWaitMs) return false;
  const patchRes = await fetchImpl(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestQueue: { maxWaitMs: minMaxWaitMs } }),
    signal: AbortSignal.timeout(4_000),
  });
  return patchRes.ok;
}

async function postChat(url, body, timeoutMs, fetchImpl) {
  return fetchImpl(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function isNetworkOrTimeoutError(err) {
  if (!err) return false;
  const name = err.name ?? "";
  // AbortSignal.timeout() and fetch network failures
  if (name === "TimeoutError" || name === "AbortError") return true;
  // Node.js fetch / undici network errors
  if (name === "TypeError" && /fetch failed|network|ECONNRESET|ECONNREFUSED|socket/i.test(err.message ?? "")) return true;
  return false;
}

/**
 * One-shot chat completion. Returns the raw OpenAI-style JSON body.
 * `webSearch` is ignored — OmniRoute has no Gemini-style Google Search tool;
 * research still runs, using the routed model's own knowledge.
 *
 * Default timeoutMs is 180 s — Gemini 2.5-flash thinking can take well over
 * 90 s when the thinking budget isn't capped, and OmniRoute adds queue time
 * on top of that. Network-level timeouts and AbortErrors are caught and
 * retried just like HTTP 429/503.
 */
export async function omnirouteGenerate(
  { system, prompt, maxTokens = 8192, json = false, tools = null, messages = null, timeoutMs = 180_000 },
  { fetchImpl = globalThis.fetch, retryDelayMs = 4_000, maxAttempts = 5 } = {}
) {
  const url = chatUrl();
  let body = buildOmnirouteChatBody({ system, prompt, maxTokens, json, tools, messages });
  let lastErr = null;
  const attempts = Math.max(1, Number(maxAttempts) || 1);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let res = await postChat(url, body, timeoutMs, fetchImpl);
      if (!res.ok && res.status === 400 && omnirouteBodyCanSimplify(body)) {
        body = simplifyOmnirouteBody(body);
        res = await postChat(url, body, timeoutMs, fetchImpl);
      }
      if (res.ok) {
        const raw = await res.text();
        const contentType = res.headers?.get?.("content-type") ?? "";
        return parseChatCompletionPayload(raw, contentType);
      }
      const errText = await res.text();
      lastErr = new Error(formatOmnirouteHttpError(res.status, errText));
      const retryable = isOmnirouteQueueTimeout(res.status, errText) && attempt < attempts;
      if (!retryable) throw lastErr;
    } catch (err) {
      // Re-throw errors that are already formatted OmniRoute errors (from the
      // block above) or any non-network error we can't recover from.
      if (err === lastErr) {
        // Already decided not to retry (retryable was false) — rethrow.
        throw err;
      }
      if (!isNetworkOrTimeoutError(err)) throw err;
      // Network/timeout: log and retry if attempts remain.
      if (attempt >= attempts) throw err;
      lastErr = err;
    }
    // Exponential-ish back-off — give OmniRoute's queue time to clear.
    if (retryDelayMs > 0) await wait(retryDelayMs * attempt);
  }
  throw lastErr;
}

/**
 * OmniRoute (and some upstreams) ignore `stream: false` and still emit SSE
 * (`data: {"id":...}`). `res.json()` then throws
 * `Unexpected token 'd', "data: {"id"... is not valid JSON`.
 */
export function parseChatCompletionPayload(raw, contentType = "") {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("OmniRoute returned an empty body");
  const looksSse = /event-stream/i.test(contentType) || /^data:/m.test(text);
  if (looksSse) return parseSseChatCompletion(text);
  try {
    return JSON.parse(text);
  } catch (err) {
    if (/^data:/m.test(text)) return parseSseChatCompletion(text);
    throw new Error(`OmniRoute returned non-JSON: ${text.slice(0, 120)} (${err.message})`);
  }
}

export function parseSseChatCompletion(raw) {
  const chunks = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(payload));
    } catch {
      /* keep-alives / comments */
    }
  }
  if (chunks.length === 0) {
    throw new Error(`OmniRoute SSE had no JSON events (${String(raw).slice(0, 120)})`);
  }
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i]?.choices?.[0]?.message) return chunks[i];
  }
  return assembleSseDeltas(chunks);
}

function assembleSseDeltas(chunks) {
  let content = "";
  const toolCallsByIndex = new Map();
  let id = chunks[0]?.id;
  let model = chunks[0]?.model;
  for (const chunk of chunks) {
    id ??= chunk.id;
    model ??= chunk.model;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const prev = toolCallsByIndex.get(idx) ?? {
          id: tc.id,
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (tc.id) prev.id = tc.id;
        if (tc.function?.name) prev.function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") prev.function.arguments += tc.function.arguments;
        toolCallsByIndex.set(idx, prev);
      }
    }
  }
  const tool_calls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  return {
    id,
    model,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(tool_calls.length ? { tool_calls } : {}),
        },
        finish_reason: "stop",
      },
    ],
  };
}

export function assistantTextFromChatCompletion(data) {
  const msg = data?.choices?.[0]?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  }
  return "";
}

export function toolCallsFromChatCompletion(data) {
  const msg = data?.choices?.[0]?.message;
  const raw = msg?.tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((tc) => {
    let args = {};
    const payload = tc.function?.arguments;
    if (typeof payload === "string" && payload.trim()) {
      try {
        args = JSON.parse(payload);
      } catch {
        args = {};
      }
    } else if (payload && typeof payload === "object") {
      args = payload;
    }
    return {
      id: tc.id,
      name: tc.function?.name ?? tc.name,
      args,
      raw: tc,
    };
  });
}
