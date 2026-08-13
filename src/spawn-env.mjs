/* The environment to hand a spawned child process.
 *
 * WHY THIS EXISTS — a fortnight of unexplained build failures.
 *
 * Running the service with `npm run dev` executes it under `node --watch`, and
 * Node's watch mode sets `WATCH_REPORT_DEPENDENCIES=1` in the process
 * environment. That variable tells a Node process to report every module it
 * loads back to its parent by pushing `{ 'watch:require': … }` messages down
 * its IPC channel.
 *
 * It is inherited. Every child we spawn gets it, and so does every child of
 * THOSE children. `next build` farms compilation and type-checking out to
 * jest-worker child processes connected over IPC — which promptly start
 * emitting watch:require messages into the very channel jest-worker uses for
 * its own protocol. jest-worker reads a message shape it has never heard of
 * and dies:
 *
 *   uncaughtException TypeError: Unexpected response from worker: undefined
 *     at ChildProcessWorker._onMessage (…/next/dist/compiled/jest-worker/…)
 *
 * The parent then exits without printing anything the workers had found, so
 * the report is a stack trace into Next's own bundle with no source file in it.
 * Confirmed by direct experiment in a real worktree: `npm run build` succeeds
 * in 71s, and `WATCH_REPORT_DEPENDENCIES=1 npm run build` fails in 1.9s with
 * that exact error.
 *
 * It was invisible for so long because it depends on nothing in the code and
 * everything in how the service happened to be launched: `npm start` builds
 * fine, `npm run dev` never can. Docker hid it too, since a container gets a
 * fresh environment — so "verify only breaks without Docker" looked like a
 * Docker argument rather than an environment one.
 *
 * There is a warning at startup about running under --watch, but a warning is
 * not a fix. Sanitising here makes the service correct however it was started. */

// Node's watch-mode IPC reporting flag. Never meaningful to anything we spawn:
// the target repo's build, its dev server, git — none of them are our watcher's
// children in any sense that matters.
const WATCH_ENV_VARS = ["WATCH_REPORT_DEPENDENCIES"];

// `--watch` can also arrive through NODE_OPTIONS, which is likewise inherited.
// A child that re-execs itself under a watcher would hang a build forever.
const WATCH_FLAG_RE = /(^|\s)--watch(-path|-preserve-output)?(=\S*)?(?=\s|$)/g;

/**
 * process.env with anything watch-related removed, plus any overrides.
 *
 * @param {Record<string, string>} [overrides] - e.g. { PORT: "4321" }
 * @returns {Record<string, string|undefined>}
 */
export function cleanEnvForChildProcess(overrides = {}) {
  const env = { ...process.env, ...overrides };

  for (const name of WATCH_ENV_VARS) delete env[name];

  if (typeof env.NODE_OPTIONS === "string") {
    const stripped = env.NODE_OPTIONS.replace(WATCH_FLAG_RE, " ").replace(/\s+/g, " ").trim();
    // An empty NODE_OPTIONS is not the same as an absent one to every tool that
    // reads it, so remove the variable rather than leaving "".
    if (stripped) env.NODE_OPTIONS = stripped;
    else delete env.NODE_OPTIONS;
  }

  return env;
}
