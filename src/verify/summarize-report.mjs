/* Pulls the part of a build/verify report a human (or the run log) actually
 * needs to see.
 *
 * Why: a failing `npm ci && npm run build` emits ~1.5KB of install chatter —
 * package counts, funding notices, audit summaries, deprecation warnings, npm
 * upgrade notices — BEFORE the real compiler error. The run log truncated the
 * report to its first 500 characters, so every failure was logged as nothing
 * but that chatter and the actual error was never visible. A real report ran
 * 2313 characters with the compile error starting past character 1400.
 *
 * This keeps the full report intact for the retry prompt and the database; it
 * only decides what's worth showing in a one-line log entry. */

// Lines that are pure npm/package-manager bookkeeping, never a build failure.
const NOISE_PATTERNS = [
  /^\s*$/,
  /^added \d+ packages/,
  /^\d+ packages are looking for funding/,
  /^\s*run `npm fund` for details/,
  /^\d+ vulnerabilities?/,
  /^To address (all )?issues/,
  /^\s*npm audit fix/,
  /^Run `npm audit` for details/,
  /^npm warn deprecated/,
  /^npm notice/,
  /^npm WARN/,
  /^\s*-\s*Environments?:/,
  /^\s*▲ Next\.js/,
  /^\s*Creating an optimized production build/,
  /^>\s/, // npm script echo lines: "> app@0.1.0 build"
];

function isNoise(line) {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

// Markers that indicate "the real failure starts around here".
const FAILURE_MARKERS = [
  /Failed to compile/i,
  /Module not found/i,
  /Syntax Error/i,
  /Type error/i,
  /^Error:/m,
  /error TS\d+/,
  /ELIFECYCLE/,
  /Build failed/i,
];

/**
 * Condenses a verify/build report down to its meaningful lines.
 *
 * @param {string} report - the full, untruncated report
 * @param {object} [opts]
 * @param {number} [opts.maxChars] - budget for the result
 * @returns {string}
 */
export function summarizeVerifyReport(report, { maxChars = 900 } = {}) {
  if (typeof report !== "string" || report.trim() === "") return "(empty report)";

  const lines = report.split("\n");

  // The first line is usually the "what command failed" header — worth keeping
  // as context even though everything after it may be noise.
  const header = lines.find((l) => l.trim() !== "") ?? "";

  // Prefer everything from the first real failure marker onward: that's where
  // the compiler stops summarizing its environment and starts reporting bugs.
  const failureStart = lines.findIndex((line) => FAILURE_MARKERS.some((re) => re.test(line)));
  const body = failureStart === -1 ? lines : lines.slice(failureStart);

  const meaningful = body.filter((line) => !isNoise(line));
  const kept = meaningful.length > 0 ? meaningful : body.filter((l) => l.trim() !== "");

  // Include the header only when the failure body doesn't already start with it.
  const parts = kept[0] === header ? kept : [header, ...kept];
  const joined = parts.join("\n").trim();

  if (joined.length <= maxChars) return joined;
  // Truncate from the END rather than the start: with the noise already gone,
  // the earliest lines are the most specific (file + error), and later lines
  // are usually import traces and doc links.
  return `${joined.slice(0, maxChars)}\n… (report truncated — full text in the run's verify report)`;
}
