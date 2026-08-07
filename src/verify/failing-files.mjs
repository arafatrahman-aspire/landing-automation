/* Works out WHICH generated files a verify failure actually blames.
 *
 * Why it matters: without this, a verify-failure retry regenerates every
 * ai-required section from scratch. That's wasteful, but worse, it's a
 * regression risk — a section that compiled fine gets rewritten and can come
 * back broken, so consecutive attempts fail on different errors and the run
 * never converges. Three real runs failed on three unrelated mistakes
 * (a missing frame, an invented import, then a `toggleFqa`/`toggleFaq` typo).
 *
 * With the blamed files identified, a retry can repair exactly those and leave
 * everything that already compiled completely untouched. */

// Build output is full of ANSI colour codes (and, once a terminal has eaten
// the ESC byte, bare "[90m"-style leftovers). Both would corrupt path matching.
const ANSI_RE = /\[[0-9;]*m/g;
const BARE_ANSI_RE = /\[[0-9;]{1,12}m/g;

// A path-ish token ending in a source extension, optionally with :line:col.
const PATH_RE = /[\w./@-]*\.(?:tsx|ts|jsx|js)(?::\d+:\d+)?/g;

/**
 * @param {string} report - a full verify/build report
 * @param {object} [opts]
 * @param {string} [opts.allowlistBase] - only paths under here are considered ours (e.g. "src/app/campaigns/x/")
 * @returns {Set<string>} repo-relative paths this failure blames
 */
export function extractFailingFiles(report, { allowlistBase = null } = {}) {
  const blamed = new Set();
  if (typeof report !== "string" || report.trim() === "") return blamed;

  const clean = report.replace(ANSI_RE, "").replace(BARE_ANSI_RE, "");

  for (const raw of clean.match(PATH_RE) ?? []) {
    let p = raw
      .replace(/:\d+:\d+$/, "") // drop :line:col
      .replace(/^\.\//, "") // "./src/app/..." -> "src/app/..."
      .replace(/^\/app\//, ""); // docker workdir prefix -> repo-relative

    if (!p || p.startsWith(".")) continue; // relative specifiers are imports, not files on disk

    // Only ever blame files this run generated. Without this, node_modules
    // frames and framework internals in a stack trace would be "blamed".
    if (allowlistBase && !p.startsWith(allowlistBase)) continue;

    // page.tsx is composed deterministically (sections/compose-page.mjs), never
    // agent-written — it shows up in every "Import trace" block but is never
    // the thing to repair.
    if (p.endsWith("/page.tsx")) continue;

    blamed.add(p);
  }

  return blamed;
}
