import { test } from "node:test";
import assert from "node:assert/strict";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv();
const {
  assistantTextFromChatCompletion,
  toolCallsFromChatCompletion,
  buildOmnirouteChatBody,
  foldSystemIntoUserMessages,
  omnirouteBodyCanSimplify,
  simplifyOmnirouteBody,
  formatOmnirouteHttpError,
  isOmnirouteFreePoolExhausted,
  parseChatCompletionPayload,
  omnirouteGenerate,
  isOmnirouteQueueTimeout,
  ensureOmnirouteQueueWait,
} = await import("../src/llm/omniroute.mjs");
const { OPENAI_TOOLS } = await import("../src/llm/omniroute-coding-agent.mjs");

test("assistantTextFromChatCompletion reads OpenAI-style message content", () => {
  assert.equal(
    assistantTextFromChatCompletion({ choices: [{ message: { content: '{"ok":true}' } }] }),
    '{"ok":true}'
  );
  assert.equal(assistantTextFromChatCompletion({ choices: [{ message: {} }] }), "");
  assert.equal(assistantTextFromChatCompletion({}), "");
});

test("toolCallsFromChatCompletion parses function.arguments JSON", () => {
  const data = {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "write_file", arguments: '{"path":"a.tsx","content":"x"}' },
            },
          ],
        },
      },
    ],
  };
  const calls = toolCallsFromChatCompletion(data);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.equal(calls[0].args.path, "a.tsx");
});

test("OPENAI_TOOLS wraps every filesystem tool as type:function", () => {
  const names = OPENAI_TOOLS.map((t) => t.function.name);
  assert.deepEqual(names, ["list_files", "read_file", "write_file", "finish_coding"]);
  for (const t of OPENAI_TOOLS) {
    assert.equal(t.type, "function");
    assert.equal(t.function.parameters.type, "object");
  }
});

test("one-shot chat body folds system and omits OpenAI-only fields", () => {
  const body = buildOmnirouteChatBody({
    system: "Be JSON.",
    prompt: "Research X",
    maxTokens: 8192,
    json: true,
  });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.match(body.messages[0].content, /Be JSON/);
  assert.match(body.messages[0].content, /Research X/);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.response_format, undefined);
  assert.equal(body.stream, false);
});

test("gweb/gemini-web model ids are rewritten off Playwright", async () => {
  const { config } = await import("../src/config.mjs");
  const original = config.omnirouteModel;
  config.omnirouteModel = "gweb/gemini-3.1-pro";
  try {
    const body = buildOmnirouteChatBody({ prompt: "hi" });
    assert.equal(body.model, "gemini/gemini-2.5-flash");
  } finally {
    config.omnirouteModel = original;
  }
});

test("foldSystemIntoUserMessages merges system into the first user turn", () => {
  const folded = foldSystemIntoUserMessages([
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
  ]);
  assert.deepEqual(folded, [{ role: "user", content: "Be brief.\n\nHi" }]);
});

test("tool-calling body keeps system role and tools", () => {
  const body = buildOmnirouteChatBody({
    system: "coder",
    prompt: "write files",
    tools: OPENAI_TOOLS,
    maxTokens: 8192,
  });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.tools, OPENAI_TOOLS);
  assert.equal(body.tool_choice, "auto");
  assert.equal(true, omnirouteBodyCanSimplify(body));
  const simplified = simplifyOmnirouteBody(body);
  assert.equal(simplified.messages[0].role, "user");
  assert.equal(simplified.tools, OPENAI_TOOLS);
});

test("formatOmnirouteHttpError tells you to pin OMNIROUTE_MODEL when auto pool dies", () => {
  const err = formatOmnirouteHttpError(
    400,
    '{"error":{"message":"[400]: Felo thread creation failed with HTTP 400 [oc/north-mini-code-free (401), felo/felo-chat (400)]"}}'
  );
  assert.match(err, /no connected provider/);
  assert.equal(isOmnirouteFreePoolExhausted(new Error(err)), true);
  assert.equal(isOmnirouteFreePoolExhausted("unrelated 500"), false);
});

function jsonResponse(obj, status = 200) {
  const raw = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: async () => raw,
    json: async () => obj,
  };
}

test("omnirouteGenerate posts a Felo-safe one-shot body", async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return jsonResponse({ choices: [{ message: { content: "{}" } }] });
  };
  await omnirouteGenerate({ system: "sys", prompt: "hi", json: true, maxTokens: 8192 }, { fetchImpl });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.messages[0].role, "user");
  assert.equal(posts[0].body.max_tokens, undefined);
  assert.equal(posts[0].body.response_format, undefined);
  assert.equal(posts[0].body.stream, false);
});

test("omnirouteGenerate retries a 400 with a simplified body", async () => {
  const posts = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    posts.push(body);
    if (posts.length === 1) {
      return { ok: false, status: 400, headers: { get: () => "application/json" }, text: async () => "bad" };
    }
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  };
  await omnirouteGenerate({ system: "sys", prompt: "hi", tools: OPENAI_TOOLS }, { fetchImpl });
  assert.equal(posts.length, 2);
  assert.equal(posts[0].messages[0].role, "system");
  assert.equal(posts[1].messages[0].role, "user");
  assert.ok(posts[1].tools);
});

test("omnirouteGenerate surfaces pin-model hint on exhausted auto pool", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    headers: { get: () => "application/json" },
    text: async () =>
      '{"error":{"message":"[400]: Felo thread creation failed with HTTP 400 [oc/north-mini-code-free (401), felo/felo-chat (400)]"}}',
  });
  await assert.rejects(
    () => omnirouteGenerate({ prompt: "hi" }, { fetchImpl }),
    /no connected provider/
  );
});

test("parseChatCompletionPayload assembles OpenAI SSE deltas", () => {
  const sse = [
    'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"{\\"ok\\":"}}]}',
    'data: {"choices":[{"delta":{"content":"true}"}}]}',
    "data: [DONE]",
    "",
  ].join("\n");
  const data = parseChatCompletionPayload(sse, "text/event-stream");
  assert.equal(assistantTextFromChatCompletion(data), '{"ok":true}');
});

test("isOmnirouteQueueTimeout matches OmniRoute local queue 503s", () => {
  assert.equal(
    isOmnirouteQueueTimeout(
      503,
      '{"error":{"message":"[503]: Request dropped after exceeding the local rate-limit queue budget maxWaitMs (15000ms)"}}'
    ),
    true
  );
  assert.equal(isOmnirouteQueueTimeout(400, "maxWaitMs"), false);
});

test("omnirouteGenerate retries a queue 503 then succeeds", async () => {
  const posts = [];
  const fetchImpl = async () => {
    posts.push(1);
    if (posts.length === 1) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => "application/json" },
        text: async () =>
          '{"error":{"message":"[503]: Request dropped after exceeding the local rate-limit queue budget maxWaitMs (15000ms)"}}',
      };
    }
    return jsonResponse({ choices: [{ message: { content: "pong" } }] });
  };
  const data = await omnirouteGenerate({ prompt: "hi" }, { fetchImpl, retryDelayMs: 0 });
  assert.equal(posts.length, 2);
  assert.equal(assistantTextFromChatCompletion(data), "pong");
});

test("ensureOmnirouteQueueWait PATCHes when maxWaitMs is below the floor", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    if ((init.method ?? "GET") === "PATCH") {
      return jsonResponse({ ok: true, requestQueue: { maxWaitMs: 30_000 } });
    }
    return jsonResponse({ requestQueue: { maxWaitMs: 15_000 } });
  };
  const patched = await ensureOmnirouteQueueWait({ fetchImpl, minMaxWaitMs: 30_000 });
  assert.equal(patched, true);
  assert.equal(calls.some((c) => c.method === "PATCH"), true);
  assert.equal(JSON.parse(calls.find((c) => c.method === "PATCH").body).requestQueue.maxWaitMs, 30_000);
});

test("omnirouteGenerate accepts SSE when the gateway streams anyway", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n';
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    text: async () => sse,
    json: async () => {
      throw new SyntaxError(`Unexpected token 'd', "data: {"id"... is not valid JSON`);
    },
  });
  const data = await omnirouteGenerate({ prompt: "hi" }, { fetchImpl });
  assert.equal(assistantTextFromChatCompletion(data), "hello");
});
