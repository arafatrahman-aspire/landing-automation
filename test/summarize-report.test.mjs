import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeVerifyReport } from "../src/verify/summarize-report.mjs";

/* Built from a REAL failing report (run aee7e242, 2313 chars). Its first
 * ~1400 characters are npm install chatter, so the old
 * `report.slice(0, 500)` log line showed nothing but package counts and
 * funding notices — the actual compile error was never visible in the log. */
const REAL_REPORT = `docker run (node:20-alpine) [npm ci && npm run build] failed:

added 557 packages, and audited 766 packages in 1m

197 packages are looking for funding
  run \`npm fund\` for details

29 vulnerabilities (2 low, 7 moderate, 19 high, 1 critical)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run \`npm audit\` for details.

> aspiretss-frontend@0.1.0 build
> next build

  ▲ Next.js 14.2.35
  - Environments: .env

   Creating an optimized production build ...
npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported
npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported
npm notice
npm notice New major version of npm available! 10.8.2 -> 12.0.2
npm notice
Failed to compile.

./src/app/campaigns/cybersecurity-training-professional/sections/FaqSection3.tsx
Module not found: Can't resolve '../../../components/Accordion'

./src/app/campaigns/cybersecurity-training-professional/sections/HeroSection0.tsx
Error: Unexpected token \`section\`. Expected jsx identifier

> Build failed because of webpack errors`;

test("surfaces the real compile error that the old 500-char slice hid entirely", () => {
  const summary = summarizeVerifyReport(REAL_REPORT);

  // The things a human actually needs.
  assert.match(summary, /Failed to compile/);
  assert.match(summary, /Can't resolve '\.\.\/\.\.\/\.\.\/components\/Accordion'/);
  assert.match(summary, /Expected jsx identifier/);

  // Proof the old behavior was broken: the naive slice contained none of it.
  const oldBehavior = REAL_REPORT.slice(0, 500);
  assert.doesNotMatch(oldBehavior, /Failed to compile/);
});

test("strips npm install bookkeeping", () => {
  const summary = summarizeVerifyReport(REAL_REPORT);
  assert.doesNotMatch(summary, /packages are looking for funding/);
  assert.doesNotMatch(summary, /npm audit fix/);
  assert.doesNotMatch(summary, /npm warn deprecated/);
  assert.doesNotMatch(summary, /New major version of npm/);
  assert.doesNotMatch(summary, /vulnerabilities/);
});

test("keeps the command header so the failure has context", () => {
  const summary = summarizeVerifyReport(REAL_REPORT);
  assert.match(summary, /docker run \(node:20-alpine\)/);
});

test("is dramatically shorter than the raw report", () => {
  const summary = summarizeVerifyReport(REAL_REPORT);
  assert.ok(summary.length < REAL_REPORT.length, "should condense");
  assert.ok(summary.length > 100, "but must not throw away the error itself");
});

test("respects a maxChars budget and says so when it truncates", () => {
  const summary = summarizeVerifyReport(REAL_REPORT, { maxChars: 120 });
  assert.ok(summary.length < 260);
  assert.match(summary, /truncated/);
});

test("falls back to the raw content when there is no recognizable failure marker", () => {
  const odd = "something went sideways\nno standard marker here";
  const summary = summarizeVerifyReport(odd);
  assert.match(summary, /something went sideways/);
});

test("handles an empty or missing report without throwing", () => {
  assert.equal(summarizeVerifyReport(""), "(empty report)");
  assert.equal(summarizeVerifyReport(null), "(empty report)");
  assert.equal(summarizeVerifyReport("   \n  "), "(empty report)");
});
