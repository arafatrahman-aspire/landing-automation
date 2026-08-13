import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkBrowserAvailable, resetBrowserAvailabilityCache } from "../src/verify/browser-availability.mjs";
import { runFullVerifySuite } from "../src/verify/run-full-verify-suite.mjs";

/* No mocking of playwright: this probes whatever is actually installed in this
 * environment and asserts the SHAPE of the answer, which is the part the verify
 * suite depends on. Both outcomes are legitimate — a machine with chromium
 * installed and one without must each produce a usable result. */

test("reports a definite yes-or-no, never throws", async () => {
  resetBrowserAvailabilityCache();
  const result = await checkBrowserAvailable();

  assert.equal(typeof result.ok, "boolean");
  if (!result.ok) {
    // The reason is what tells a human to run `npx playwright install`, so it
    // has to survive into the report rather than being swallowed.
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  }
});

test("caches the answer instead of launching a browser per call", async () => {
  resetBrowserAvailabilityCache();
  const first = await checkBrowserAvailable();

  const startedAt = Date.now();
  const second = await checkBrowserAvailable();
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(second, first);
  // A real chromium launch is tens to hundreds of milliseconds; a cache hit is
  // effectively free. Generous bound so this can't go flaky on a loaded box.
  assert.ok(elapsed < 50, `cached call took ${elapsed}ms — it appears to have relaunched`);
});

test("a missing browser skips the layout checks instead of failing the run", async (t) => {
  const available = await checkBrowserAvailable();
  if (available.ok) {
    t.skip("chromium IS installed here — the skip path can't be exercised");
    return;
  }

  // A minimal but REAL Node repo, so the suite genuinely passes build/lint and
  // reaches the browser-backed checks — the branch under test. Anything that
  // short-circuits earlier (no package.json, failing build) would return before
  // the browser is ever consulted and prove nothing.
  const dir = await mkdtemp(path.join(tmpdir(), "verify-nobrowser-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { build: "node -e \"0\"", start: "node -e \"0\"" } })
  );

  try {
    // The regression this guards: chromium.launch()'s rejection escaped
    // runFullVerifySuite's `Promise.all` uncaught and took the whole run down
    // at verify — a browser that was simply never installed presenting as a
    // hard pipeline crash.
    const result = await runFullVerifySuite({
      workdir: dir,
      installTimeoutMs: 120_000,
      buildTimeoutMs: 60_000,
      pageUrlPath: "/campaigns/example",
      packageManagerOverride: "npm",
      disableDocker: true,
    });

    assert.equal(result.ok, true, `expected a pass with skips, got: ${result.report}`);
    assert.equal(result.checks.build, true);
    assert.equal(result.checks.hero, null);
    assert.equal(result.checks.seo, null);
    assert.equal(result.checks.a11y, null);
    assert.match(result.report, /skipped — no browser available/);
    // The remedy has to reach the human reading the report.
    assert.match(result.report, /playwright install chromium/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
