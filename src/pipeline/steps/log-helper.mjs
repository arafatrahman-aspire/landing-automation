import * as runStore from "../../state/campaign-repository.mjs";

// Every pipeline step logs through this — a thin wrapper so call sites read
// as "logStage(runId, message)" instead of repeating runStore.appendLog's
// "info" level everywhere.
export function logStage(runId, message) {
  return runStore.appendLog(runId, "info", message);
}
