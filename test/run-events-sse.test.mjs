import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv({ DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "run-events-sse-")), "test.db") });

// Dynamic imports: config.mjs (pulled in transitively via state/database-connection.mjs)
// must see the env above before its first import — same requirement as
// sqlite-campaign-repository.test.mjs.
const repo = await import("../src/state/campaign-repository.mjs");
const { runEventsSseHandler } = await import("../src/state/run-events-sse.mjs");

// Real HTTP server + real `fetch`, mirroring exactly how the browser client
// (ui/src/api.ts's watchRunEvents) reads this endpoint — auth middleware is
// deliberately not mounted here, since that's server.mjs's concern, not this
// handler's; server.mjs wires isAuthorized in front of the same handler.
const app = express();
app.get("/campaigns/:runId/events", runEventsSseHandler);
const server = app.listen(0);
const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
const baseUrl = `http://127.0.0.1:${port}`;

test.after(() => server.close());

/** Pulls parsed {event, data} frames off an SSE response body, one at a
 *  time, regardless of how the underlying stream happens to chunk them. */
async function* sseFrames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        const dataLines = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue; // heartbeat comment lines
        yield { event, data: JSON.parse(dataLines.join("\n")) };
      }
    }
  } finally {
    // Cancelling through the reader that holds the lock (rather than
    // response.body.cancel(), which throws "ReadableStream is locked" while
    // this generator hasn't released it) closes the underlying connection
    // AND releases the lock in one step.
    await reader.cancel().catch(() => {});
  }
}

test("GET /campaigns/:runId/events 404s (plain JSON, not a stream) for an unknown run", async () => {
  const res = await fetch(`${baseUrl}/campaigns/no-such-run/events`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("streams an init snapshot, then a run event on updateRun and a log event on appendLog", async () => {
  const runId = "sse-run-1";
  await repo.createRun({ runId, slug: "spring-sale", campaignName: "Spring Sale", request: {} });

  const res = await fetch(`${baseUrl}/campaigns/${runId}/events`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  const frames = sseFrames(res);

  const init = (await frames.next()).value;
  assert.equal(init.event, "init");
  assert.equal(init.data.run.runId, runId);
  assert.equal(init.data.run.status, "queued");
  assert.match(init.data.log, /run created/);

  await repo.updateRun(runId, { status: "running", stage: "research" });
  const runFrame = (await frames.next()).value;
  assert.equal(runFrame.event, "run");
  assert.equal(runFrame.data.status, "running");
  assert.equal(runFrame.data.stage, "research");

  await repo.appendLog(runId, "info", "hello from the pipeline");
  const logFrame = (await frames.next()).value;
  assert.equal(logFrame.event, "log");
  assert.equal(logFrame.data.level, "info");
  assert.equal(logFrame.data.message, "hello from the pipeline");

  // Closing the generator (rather than res.body.cancel() — see sseFrames'
  // own comment) triggers the request's "close" event server-side; exercised
  // here mostly to confirm it doesn't throw/hang the test process.
  await frames.return();
});

test("two concurrent subscribers on the same run both receive the same events", async () => {
  const runId = "sse-run-2";
  await repo.createRun({ runId, slug: "x", campaignName: "X", request: {} });

  const [res1, res2] = await Promise.all([
    fetch(`${baseUrl}/campaigns/${runId}/events`),
    fetch(`${baseUrl}/campaigns/${runId}/events`),
  ]);
  const frames1 = sseFrames(res1);
  const frames2 = sseFrames(res2);

  await frames1.next(); // init
  await frames2.next(); // init

  await repo.updateRun(runId, { status: "failed", error: "boom" });

  const f1 = (await frames1.next()).value;
  const f2 = (await frames2.next()).value;
  assert.equal(f1.event, "run");
  assert.equal(f2.event, "run");
  assert.equal(f1.data.status, "failed");
  assert.equal(f2.data.status, "failed");

  await frames1.return();
  await frames2.return();
});
