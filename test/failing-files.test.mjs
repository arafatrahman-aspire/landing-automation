import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFailingFiles } from "../src/verify/failing-files.mjs";

const BASE = "src/app/campaigns/cybersecurity-training-professional/";

/* Every fixture below is copied from a REAL failing run of this service. */

test("blames the file in a tsc type error (the toggleFqa/toggleFaq typo run)", () => {
  const report = `Failed to compile.
./src/app/campaigns/cybersecurity-training-professional/sections/FaqSection4.tsx:51:32
Type error: Cannot find name 'toggleFqa'. Did you mean 'toggleFaq'?`;

  const files = extractFailingFiles(report, { allowlistBase: BASE });
  assert.deepEqual([...files], [`${BASE}sections/FaqSection4.tsx`]);
});

test("blames the file in a webpack module-not-found error", () => {
  const report = `Failed to compile.

./src/app/campaigns/cybersecurity-training-professional/sections/FaqSection3.tsx
Module not found: Can't resolve '../../../components/Accordion'

https://nextjs.org/docs/messages/module-not-found`;

  const files = extractFailingFiles(report, { allowlistBase: BASE });
  assert.deepEqual([...files], [`${BASE}sections/FaqSection3.tsx`]);
  // The unresolvable specifier itself is an import, not a file to repair.
  assert.ok(![...files].some((f) => f.includes("Accordion")));
});

test("handles the ANSI-coloured swc syntax error with its /app/ docker prefix", () => {
  const report = `./src/app/campaigns/cybersecurity-training-professional/sections/HeroSection0.tsx
Error:
  [31mx[0m Unexpected token \`section\`. Expected jsx identifier
    ,-[[36;1;4m/app/src/app/campaigns/cybersecurity-training-professional/sections/HeroSection0.tsx[0m:83:1]
 [2m83[0m |   };`;

  const files = extractFailingFiles(report, { allowlistBase: BASE });
  assert.deepEqual([...files], [`${BASE}sections/HeroSection0.tsx`]);
});

test("never blames the deterministically-composed page.tsx, even though import traces always list it", () => {
  const report = `./src/app/campaigns/cybersecurity-training-professional/sections/HeroSection0.tsx
Error: Syntax Error

Import trace for requested module:
./src/app/campaigns/cybersecurity-training-professional/sections/HeroSection0.tsx
./src/app/campaigns/cybersecurity-training-professional/page.tsx`;

  const files = extractFailingFiles(report, { allowlistBase: BASE });
  assert.ok(!files.has(`${BASE}page.tsx`), "page.tsx is composed by us, never agent-written");
  assert.ok(files.has(`${BASE}sections/HeroSection0.tsx`));
});

test("ignores files outside this campaign's allowlist (framework/node_modules frames)", () => {
  const report = `Error in ./node_modules/next/dist/client/index.js:22:1
./src/components/frames/Frame1.tsx
./src/app/campaigns/cybersecurity-training-professional/sections/FaqSection4.tsx:5:1`;

  const files = extractFailingFiles(report, { allowlistBase: BASE });
  assert.deepEqual([...files], [`${BASE}sections/FaqSection4.tsx`]);
});

test("collects several blamed files from one report", () => {
  const report = `Failed to compile.
./src/app/campaigns/cybersecurity-training-professional/sections/FaqSection3.tsx
Module not found: Can't resolve '../../../components/Accordion'
./src/app/campaigns/cybersecurity-training-professional/sections/HeroSection0.tsx
Error: Unexpected token`;

  const files = extractFailingFiles(report, { allowlistBase: BASE });
  assert.equal(files.size, 2);
});

test("returns an empty set for an empty, missing, or file-less report", () => {
  assert.equal(extractFailingFiles("", { allowlistBase: BASE }).size, 0);
  assert.equal(extractFailingFiles(null, { allowlistBase: BASE }).size, 0);
  assert.equal(extractFailingFiles("npm ERR! something died", { allowlistBase: BASE }).size, 0);
});
