import { TOOL_DEFINITIONS, createToolExecutor } from "./filesystem-tools.mjs";
import { omnirouteGenerate, assistantTextFromChatCompletion, toolCallsFromChatCompletion } from "./omniroute.mjs";

/* Agentic coding loop over OmniRoute's OpenAI-compatible /v1/chat/completions.
 * Same contract as runClaudeCodingAgent / runGeminiCodingAgent. Existing
 * Gemini/Claude loops are untouched. */

const MAX_TOKENS = 8192;

const FINISH_NUDGE =
  "Every file in the file plan has now been written. Call finish_coding now with a short summary — do not create or rewrite any more files.";

function allManifestFilesWritten(manifestPaths, writtenFiles) {
  return Boolean(manifestPaths) && manifestPaths.size > 0 && [...manifestPaths].every((p) => writtenFiles.has(p));
}

export const OPENAI_TOOLS = TOOL_DEFINITIONS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema ?? { type: "object", properties: {} },
  },
}));

/**
 * @param {object} opts — same shape as the Gemini/Claude coding agents
 * @returns {Promise<{finished: boolean, summary: string|null, iterations: number, writtenFiles: Set<string>}>}
 */
export async function runOmnirouteCodingAgent({
  workdir,
  allowedPrefixes,
  pristineFiles,
  manifestPaths,
  systemPrompt,
  taskPrompt,
  maxIterations,
  logger,
}) {
  const executor = createToolExecutor({ workdir, allowedPrefixes, pristineFiles, manifestPaths, logger });
  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: taskPrompt },
  ];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const data = await omnirouteGenerate({
      messages,
      tools: OPENAI_TOOLS,
      maxTokens: MAX_TOKENS,
      // 180 s matches the one-shot default — Gemini 2.5-flash thinking can
      // take well over 120 s per tool-use iteration inside OmniRoute.
      timeoutMs: 180_000,
    });
    const choice = data?.choices?.[0]?.message ?? {};
    const calls = toolCallsFromChatCompletion(data);

    logger(`iteration ${iteration}: ${calls.length} tool call(s) [${calls.map((c) => c.name).join(", ") || "none"}]`);

    if (calls.length === 0) {
      messages.push({ role: "assistant", content: assistantTextFromChatCompletion(data) || "" });
      messages.push({
        role: "user",
        content:
          "Continue: call write_file for any remaining planned files, or call finish_coding when the file plan is fully implemented.",
      });
      continue;
    }

    const finishCall = calls.find((c) => c.name === "finish_coding");
    const actionCalls = calls.filter((c) => c.name !== "finish_coding");

    messages.push({
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: calls.map((c) => c.raw),
    });

    for (const call of actionCalls) {
      const result = await executor.execute(call.name, call.args ?? {}).catch((err) => ({ ok: false, message: err.message }));
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    if (finishCall) {
      const summary = finishCall.args?.summary ?? "(no summary provided)";
      logger(`finish_coding called: ${summary}`);
      return { finished: true, summary, iterations: iteration, writtenFiles: executor.getWrittenFiles() };
    }

    if (allManifestFilesWritten(manifestPaths, executor.getWrittenFiles())) {
      messages.push({ role: "user", content: FINISH_NUDGE });
    }
  }

  logger(`max iterations (${maxIterations}) reached without finish_coding`);
  return { finished: false, summary: null, iterations: maxIterations, writtenFiles: executor.getWrittenFiles() };
}
