import { getRun, getFullLog } from "./campaign-repository.mjs";
import { subscribe } from "./run-events.mjs";

const HEARTBEAT_MS = 20_000;

function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * GET /campaigns/:runId/events — a Server-Sent Events stream of one run's
 * status and log, replacing the UI's 2s poll of GET /campaigns/:runId +
 * GET /campaigns/:runId/log with real-time push (run-events.mjs is the
 * in-process pub/sub this reads from; every write in
 * sqlite-campaign-repository.mjs publishes there).
 *
 * Sends one `init` event with the full current run + log on connect, then
 * incremental `run` (full record, on any status/stage/etc. change) and
 * `log` (one new line) events as they happen. Mounted behind the same
 * Bearer auth as every other route in server.mjs — note that means the
 * browser can't use the native EventSource API here (it can't set custom
 * headers), so the UI opens this with fetch + a manual SSE reader instead
 * (see ui/src/api.ts's watchRunEvents).
 */
export async function runEventsSseHandler(req, res) {
  const { runId } = req.params;
  const run = await getRun(runId);
  if (!run) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const log = (await getFullLog(runId)) ?? "";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Harmless if never fronted by nginx; prevents proxy buffering from
    // delaying delivery if it ever is.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  writeEvent(res, "init", { run, log });

  const unsubscribe = subscribe(runId, (message) => {
    try {
      if (message.type === "run") writeEvent(res, "run", message.run);
      else if (message.type === "log") writeEvent(res, "log", message.entry);
    } catch (err) {
      // A write to an already-closing response can still throw here even
      // with the "close" cleanup below (timing) — never let that surface as
      // an unhandled error on the underlying run-events EventEmitter.
      console.error(`run-events-sse: write failed for run ${runId}:`, err.message);
    }
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  function cleanup() {
    clearInterval(heartbeat);
    unsubscribe();
  }
  req.on("close", cleanup);
  res.on("error", cleanup);
}
