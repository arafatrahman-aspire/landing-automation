import { test } from "node:test";
import assert from "node:assert/strict";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv();

const { extractJson } = await import("../src/llm/generate-text.mjs");

test("extractJson reads a fenced json block", () => {
  assert.deepEqual(extractJson('```json\n{"summary":"hello"}\n```'), { summary: "hello" });
});

test("extractJson accepts a one-line fence without a newline after the tag", () => {
  assert.deepEqual(extractJson('```json{"a":1}```'), { a: 1 });
});

test("extractJson falls back to the outermost braces in prose", () => {
  assert.deepEqual(extractJson('Sure — here you go: {"ok":true} thanks'), { ok: true });
});

test("extractJson rejects empty input with a clear error (not bare Unexpected end of JSON input)", () => {
  assert.throws(() => extractJson(""), /empty model response/);
  assert.throws(() => extractJson("   "), /empty model response/);
});

test("extractJson rejects text with no object instead of slicing to empty string", () => {
  assert.throws(() => extractJson("no braces here"), /no JSON object found/);
});

test("extractJson surfaces a truncated-object hint", () => {
  assert.throws(() => extractJson('{"summary": "unterminated'), /no JSON object found|Unexpected end|candidate starts/);
});
