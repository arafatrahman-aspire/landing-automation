import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFailingFiles, extractAllBlamedFiles } from "../src/verify/failing-files.mjs";

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

/* Telling "our code is broken" apart from "the target repo doesn't build".
 * A real run looked like a codegen failure for days when the actual defect was
 * src/app/soc-health-check/page.tsx, committed to the target repo weeks
 * earlier — a file this service never wrote and cannot write. */

const REPO_OWN_FAILURE = `Failed to compile.
./src/app/soc-health-check/page.tsx:22:9
Type error: Property 'contents' does not exist on type 'IntrinsicAttributes & Frame29Props'. Did you mean 'contents1'?`;

test("a failure in a file outside our allowlist blames nothing of ours", () => {
  const ours = extractFailingFiles(REPO_OWN_FAILURE, { allowlistBase: BASE });
  assert.equal(ours.size, 0, "none of this is ours to fix");

  const everything = extractAllBlamedFiles(REPO_OWN_FAILURE);
  assert.ok(everything.has("src/app/soc-health-check/page.tsx"), "the real culprit must stay visible");
});

test("a foreign page.tsx is NOT hidden by the composed-page exclusion", () => {
  // Our own page.tsx is excluded as noise; somebody else's must not be.
  const everything = extractAllBlamedFiles(REPO_OWN_FAILURE);
  assert.equal(everything.size, 1);
});

test("our own composed page.tsx is still excluded when it is ours", () => {
  const report = `Failed to compile.\n./${BASE}page.tsx\nModule not found`;
  assert.equal(extractFailingFiles(report, { allowlistBase: BASE }).size, 0);
});

test("a mixed failure still surfaces our file so the repair loop can act", () => {
  const report = `${REPO_OWN_FAILURE}\n./${BASE}sections/FaqSection3.tsx:5:1\nType error: boom`;
  const ours = extractFailingFiles(report, { allowlistBase: BASE });
  assert.deepEqual([...ours], [`${BASE}sections/FaqSection3.tsx`]);
  assert.equal(extractAllBlamedFiles(report).size, 2);
});

/* ---------------- node_modules is never a blamed file ---------------- */

// Verbatim from the stored report of run ea209fac: the build worker crashed and
// the ONLY path in the whole 15-line report was inside Next's own bundle.
const WORKER_CRASH_REPORT = `npm run build failed:

> aspiretss-frontend@0.1.0 build
> next build

   ▲ Next.js 14.2.35
   - Environments: .env

   Creating an optimized production build ...
uncaughtException TypeError: Unexpected response from worker: undefined
    at ChildProcessWorker._onMessage (/home/u/work/data/.scratch/ea209fac/node_modules/next/dist/compiled/jest-worker/index.js:1:12438)
    at ChildProcess.emit (node:events:509:28)
`;

test("a dependency's internals are never blamed as a source file", () => {
  // This exact report made the classifier announce "the target repository does
  // not build on its own" while naming two things that are not source files:
  // Next's bundled jest-worker, and the string "Next.js" from its own version
  // banner (which ends in `.js` and so matched the path pattern).
  const blamed = extractAllBlamedFiles(WORKER_CRASH_REPORT);
  assert.equal(blamed.size, 0, `expected nothing blamed, got: ${[...blamed].join(", ")}`);
});

test("the Next.js version banner is not mistaken for a filename", () => {
  assert.equal(extractAllBlamedFiles("   ▲ Next.js 14.2.35\n").size, 0);
});

test("node_modules is excluded even when real repo files are also blamed", () => {
  const report = `Failed to compile.
./src/app/campaigns/x/sections/HeroSection0.tsx:52:5
Type error: something is wrong
    at Object.<anonymous> (/repo/node_modules/typescript/lib/tsc.js:1:2)
`;
  const blamed = extractAllBlamedFiles(report);
  assert.ok(blamed.has("src/app/campaigns/x/sections/HeroSection0.tsx"));
  assert.ok(![...blamed].some((p) => p.includes("node_modules")), `node_modules leaked: ${[...blamed].join(", ")}`);
});
