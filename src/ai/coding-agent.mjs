import { config } from "../config.mjs";
import { TOOL_DEFINITIONS, createToolExecutor } from "./tools.mjs";

/* The agentic coding loop. Provider-switchable via CODING_AGENT_PROVIDER
 * (gemini|claude, independent of AI_PROVIDER which governs the one-shot
 * research/guide stages) — swap providers with one env var, no code changes.
 *
 * Both implementations share the same contract:
 *   runXCodingAgent({workdir, allowedPrefixes, pristineFiles, manifestPaths,
 *     systemPrompt, taskPrompt, maxIterations, logger})
 *     -> {finished, summary, iterations, writtenFiles}
 *
 * Termination is the explicit `finish_coding` tool call in both cases, not
 * "the model stopped requesting tools" (fragile, no structured summary).
 * MAX_AGENT_ITERATIONS is the safety-net cap either way: if hit without
 * finish_coding, the caller (orchestrator/steps.mjs) MUST treat this as a
 * failure and never proceed to verify/commit/push/PR. */

const MAX_TOKENS = 8192;

/* ---------------- Claude (Anthropic Messages API, tool_use) ---------------- */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

async function callClaude({ system, messages }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: config.codingAgentModel, max_tokens: MAX_TOKENS, system, messages, tools: TOOL_DEFINITIONS }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

async function runClaudeCodingAgent({ workdir, allowedPrefixes, pristineFiles, manifestPaths, systemPrompt, taskPrompt, maxIterations, logger }) {
  const executor = createToolExecutor({ workdir, allowedPrefixes, pristineFiles, manifestPaths, logger });
  const messages = [{ role: "user", content: taskPrompt }];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const response = await callClaude({ system: systemPrompt, messages });
    const blocks = response.content ?? [];
    const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");

    logger(`iteration ${iteration}: ${toolUseBlocks.length} tool call(s) [${toolUseBlocks.map((b) => b.name).join(", ") || "none"}]`);

    if (toolUseBlocks.length === 0) {
      messages.push({ role: "assistant", content: blocks });
      messages.push({
        role: "user",
        content: "Continue: call write_file for any remaining planned files, or call finish_coding when the file plan is fully implemented.",
      });
      continue;
    }

    const finishBlock = toolUseBlocks.find((b) => b.name === "finish_coding");
    const actionBlocks = toolUseBlocks.filter((b) => b.name !== "finish_coding");

    const results = [];
    for (const block of actionBlocks) {
      const result = await executor.execute(block.name, block.input ?? {}).catch((err) => ({ ok: false, message: err.message }));
      results.push({ block, result });
    }

    if (finishBlock) {
      const summary = finishBlock.input?.summary ?? "(no summary provided)";
      logger(`finish_coding called: ${summary}`);
      return { finished: true, summary, iterations: iteration, writtenFiles: executor.getWrittenFiles() };
    }

    messages.push({ role: "assistant", content: blocks });
    messages.push({
      role: "user",
      content: results.map(({ block, result }) => ({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) })),
    });
  }

  logger(`max iterations (${maxIterations}) reached without finish_coding`);
  return { finished: false, summary: null, iterations: maxIterations, writtenFiles: executor.getWrittenFiles() };
}

/* ---------------- Gemini (generateContent, functionCall) ---------------- */

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  if (schema.type) out.type = schema.type.toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.required) out.required = schema.required;
  return out;
}

const GEMINI_FUNCTION_DECLARATIONS = TOOL_DEFINITIONS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: toGeminiSchema(t.input_schema),
}));

async function callGemini({ system, contents }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.codingAgentModel}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiApiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }],
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

async function runGeminiCodingAgent({ workdir, allowedPrefixes, pristineFiles, manifestPaths, systemPrompt, taskPrompt, maxIterations, logger }) {
  const executor = createToolExecutor({ workdir, allowedPrefixes, pristineFiles, manifestPaths, logger });
  const contents = [{ role: "user", parts: [{ text: taskPrompt }] }];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const response = await callGemini({ system: systemPrompt, contents });
    const candidate = response.candidates?.[0];
    if (!candidate) {
      throw new Error(`Gemini returned no candidates (possibly safety-blocked): ${JSON.stringify(response).slice(0, 300)}`);
    }
    const parts = candidate.content?.parts ?? [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    logger(`iteration ${iteration}: ${functionCalls.length} tool call(s) [${functionCalls.map((f) => f.name).join(", ") || "none"}]`);

    if (functionCalls.length === 0) {
      contents.push({ role: "model", parts });
      contents.push({
        role: "user",
        parts: [{ text: "Continue: call write_file for any remaining planned files, or call finish_coding when the file plan is fully implemented." }],
      });
      continue;
    }

    const finishCall = functionCalls.find((f) => f.name === "finish_coding");
    const actionCalls = functionCalls.filter((f) => f.name !== "finish_coding");

    const results = [];
    for (const call of actionCalls) {
      const result = await executor.execute(call.name, call.args ?? {}).catch((err) => ({ ok: false, message: err.message }));
      results.push({ call, result });
    }

    if (finishCall) {
      const summary = finishCall.args?.summary ?? "(no summary provided)";
      logger(`finish_coding called: ${summary}`);
      return { finished: true, summary, iterations: iteration, writtenFiles: executor.getWrittenFiles() };
    }

    contents.push({ role: "model", parts });
    contents.push({
      role: "user",
      parts: results.map(({ call, result }) => ({ functionResponse: { name: call.name, response: result } })),
    });
  }

  logger(`max iterations (${maxIterations}) reached without finish_coding`);
  return { finished: false, summary: null, iterations: maxIterations, writtenFiles: executor.getWrittenFiles() };
}

/* ---------------- dispatch ---------------- */

/** @returns {Promise<{finished: boolean, summary: string|null, iterations: number, writtenFiles: Set<string>}>} */
export async function runCodingAgent(opts) {
  const maxIterations = opts.maxIterations ?? config.maxAgentIterations;
  const logger = opts.logger ?? (() => {});
  const run = config.codingAgentProvider === "gemini" ? runGeminiCodingAgent : runClaudeCodingAgent;
  return run({ ...opts, maxIterations, logger });
}
