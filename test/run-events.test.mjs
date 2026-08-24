import test from "node:test";
import assert from "node:assert/strict";
import { publish, subscribe } from "../src/state/run-events.mjs";

test("subscribe receives messages published for its own runId only", () => {
  const receivedA = [];
  const receivedB = [];
  const unsubA = subscribe("run-a", (m) => receivedA.push(m));
  const unsubB = subscribe("run-b", (m) => receivedB.push(m));

  publish("run-a", { type: "run", run: { runId: "run-a" } });
  publish("run-b", { type: "log", entry: { ts: "t", level: "info", message: "hi" } });

  assert.deepEqual(receivedA, [{ type: "run", run: { runId: "run-a" } }]);
  assert.deepEqual(receivedB, [{ type: "log", entry: { ts: "t", level: "info", message: "hi" } }]);

  unsubA();
  unsubB();
});

test("multiple subscribers on the same runId all receive the message", () => {
  const received1 = [];
  const received2 = [];
  const unsub1 = subscribe("run-multi", (m) => received1.push(m));
  const unsub2 = subscribe("run-multi", (m) => received2.push(m));

  publish("run-multi", { type: "run", run: { status: "running" } });

  assert.equal(received1.length, 1);
  assert.equal(received2.length, 1);

  unsub1();
  unsub2();
});

test("unsubscribe stops further delivery", () => {
  const received = [];
  const unsubscribe = subscribe("run-unsub", (m) => received.push(m));
  publish("run-unsub", { type: "run", run: { status: "queued" } });
  unsubscribe();
  publish("run-unsub", { type: "run", run: { status: "running" } });

  assert.equal(received.length, 1);
});

test("publish with no subscribers is a no-op, not an error", () => {
  assert.doesNotThrow(() => publish("run-nobody-listening", { type: "run", run: {} }));
});

test("publish never throws even if a listener throws", () => {
  const unsubscribe = subscribe("run-broken-listener", () => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() => publish("run-broken-listener", { type: "run", run: {} }));
  unsubscribe();
});
