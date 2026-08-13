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

    // A blamed file always sits in a directory. Requiring a slash filters out
    // prose that merely ends in a source extension — Next's own version banner
    // `▲ Next.js 14.2.35` matched the path pattern and was reported to a user
    // as a failing file called "Next.js". The cost is that a blamed file at the
    // repo ROOT (`next.config.js`) is no longer detected; that only weakens the
    // "not caused by this run" hint, whereas a bogus filename actively misleads.
    // Generated files always live under `src/app/campaigns/<slug>/`, so they are
    // unaffected either way.
    if (!p.includes("/")) continue;

    // Dependency internals are never anybody's source file, and blaming one is
    // actively misleading. A real run crashed with
    //   uncaughtException TypeError: Unexpected response from worker: undefined
    //     at .../node_modules/next/dist/compiled/jest-worker/index.js
    // which was the FIRST path in the report, so with no allowlist to filter it
    // (extractAllBlamedFiles passes none) it became the sole "blamed" file — and
    // 07-verify.mjs's classifier concluded "the target repository does not build
    // on its own", pointing at Next.js's own bundled worker. The real webpack
    // errors were further down the same report.
    if (/(^|\/)node_modules\//.test(p)) continue;

    // Only ever blame files this run generated.
    if (allowlistBase && !p.startsWith(allowlistBase)) continue;

    // OUR page.tsx is composed deterministically (sections/compose-page.mjs),
    // never agent-written — it appears in every "Import trace" block but is
    // never the thing to repair. Only that exact file is excluded: a page.tsx
    // elsewhere in the repo is somebody else's file and must stay visible, so
    // a pre-existing breakage can be told apart from ours.
    if (allowlistBase && p === `${allowlistBase}page.tsx`) continue;

    blamed.add(p);
  }

  return blamed;
}

/**
 * Every source file a failure blames, with no allowlist filter — used to tell
 * "our generated code is broken" apart from "the target repo doesn't build".
 *
 * A real run made this necessary: once the per-file prechecks cleaned up the
 * generated sections, the build got far enough to hit a type error in
 * `src/app/soc-health-check/page.tsx`, committed to the target repo weeks
 * earlier. No amount of regenerating our sections can fix that, so treating it
 * as a codegen failure sends everyone hunting in the wrong place.
 *
 * @returns {Set<string>}
 */
export function extractAllBlamedFiles(report) {
  return extractFailingFiles(report, { allowlistBase: null });
}
