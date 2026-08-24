import { EventEmitter } from "node:events";

/* In-process pub/sub for real-time run updates (SSE — state/run-events-sse.mjs).
 * campaign-repository.mjs's own docs already assume "a single always-on
 * process" (see sqlite-campaign-repository.mjs's reconcileCrashedRuns
 * comment: no checkpointing/resume across restarts) — the pipeline that
 * mutates run state and any connected SSE clients always live in that same
 * process, so a plain in-memory EventEmitter is enough. Nothing here needs
 * to survive a restart or fan out across processes. */

const emitter = new EventEmitter();
// An arbitrary number of browser tabs can watch the same run — don't warn
// past Node's default of 10 listeners per topic.
emitter.setMaxListeners(0);

function topic(runId) {
  return `run:${runId}`;
}

/**
 * Publish an update for one run. Never throws — a broken subscriber (e.g. a
 * write to an already-closed SSE response) must not take down the caller,
 * which is usually mid-write of the run's actual persisted state.
 *
 * @param {string} runId
 * @param {{type: "run", run: object} | {type: "log", entry: {ts: string, level: string, message: string}}} message
 */
export function publish(runId, message) {
  try {
    emitter.emit(topic(runId), message);
  } catch (err) {
    console.error(`run-events: listener for run ${runId} threw:`, err.message);
  }
}

/**
 * Subscribe to updates for one run. Returns an unsubscribe function.
 *
 * @param {string} runId
 * @param {(message: object) => void} listener
 * @returns {() => void}
 */
export function subscribe(runId, listener) {
  const name = topic(runId);
  emitter.on(name, listener);
  return () => emitter.off(name, listener);
}
