import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTypeScriptStrictness, buildTypeScriptPromptFragment } from "../src/pipeline/steps/detect-typescript-strictness.mjs";

/* Regression cover for a real failure: the agent wrote
 * `const Button = ({ children, onClick }) => ...` into a .tsx file in a repo
 * with "strict": true, and `next build` failed with
 * "Binding element 'children' implicitly has an 'any' type." */

async function repoWith(tsconfig) {
  const dir = await mkdtemp(path.join(tmpdir(), "ts-strict-"));
  if (tsconfig !== null) await writeFile(path.join(dir, "tsconfig.json"), tsconfig);
  return dir;
}

test("detects strict mode from the real target repo's tsconfig shape", async () => {
  // Copied from the actual atss-frontend tsconfig.
  const dir = await repoWith(JSON.stringify({ compilerOptions: { strict: true, paths: { "@*": ["./src/*"] } } }));
  try {
    assert.deepEqual(await detectTypeScriptStrictness(dir), { isTypeScript: true, strict: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a repo with no tsconfig is not TypeScript, and gets no type rules at all", async () => {
  const dir = await repoWith(null);
  try {
    const result = await detectTypeScriptStrictness(dir);
    assert.deepEqual(result, { isTypeScript: false, strict: false });
    assert.equal(buildTypeScriptPromptFragment(result), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only an explicitly loose config counts as loose", async () => {
  const loose = await repoWith(JSON.stringify({ compilerOptions: { strict: false, noImplicitAny: false } }));
  const partial = await repoWith(JSON.stringify({ compilerOptions: { strict: false } }));
  try {
    assert.equal((await detectTypeScriptStrictness(loose)).strict, false);
    // strict:false but noImplicitAny unset still errors on implicit any in
    // many setups, so this must NOT be treated as loose.
    assert.equal((await detectTypeScriptStrictness(partial)).strict, true);
  } finally {
    await rm(loose, { recursive: true, force: true });
    await rm(partial, { recursive: true, force: true });
  }
});

test("assumes strict when strictness is inherited via extends (safe default)", async () => {
  const dir = await repoWith(JSON.stringify({ extends: "./base.json", compilerOptions: { jsx: "preserve" } }));
  try {
    assert.equal((await detectTypeScriptStrictness(dir)).strict, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tolerates JSONC tsconfig", async () => {
  const dir = await repoWith(`{
    // next.js default
    "compilerOptions": { "strict": true, },
  }`);
  try {
    assert.equal((await detectTypeScriptStrictness(dir)).strict, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the strict fragment names the exact failure and the repo's IProps convention", () => {
  const fragment = buildTypeScriptPromptFragment({ isTypeScript: true, strict: true });
  assert.match(fragment, /implicitly has an 'any' type/);
  assert.match(fragment, /interface IProps/);
  assert.match(fragment, /React\.ChangeEvent/);
  assert.match(fragment, /BUILD FAILURE/);
  // The exact untyped shape that failed must be called out as forbidden.
  assert.match(fragment, /\(\{ children, onClick \}\)/);
});
