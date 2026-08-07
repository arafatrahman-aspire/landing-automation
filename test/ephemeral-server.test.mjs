import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startEphemeral } from "../src/verify/ephemeral-server.mjs";

/* No Playwright/browser needed here — just a real tiny HTTP server that
 * honors PORT, exercising startEphemeral's own port-picking/readiness-poll/
 * teardown logic in isolation from anything browser-related. */

async function makeServableFixture(root, { script = "start", honorPort = true } = {}) {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { [script]: "node server.js" } }, null, 2)
  );
  await writeFile(
    path.join(root, "server.js"),
    honorPort
      ? `const http = require("node:http");
http.createServer((req, res) => res.end("ok")).listen(process.env.PORT || 9999);`
      : `const http = require("node:http");
http.createServer((req, res) => res.end("ok")).listen(9999999);` // deliberately invalid, never binds
  );
}

test("starts the repo's own start script on a free port and reports it ready", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-server-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeServableFixture(root);

  const server = await startEphemeral({ workdir: root, timeoutMs: 10_000 });
  assert.equal(server.ok, true);
  const res = await fetch(server.baseUrl);
  assert.equal(await res.text(), "ok");
  await server.stop();
});

test("falls back to preview/dev script when there's no start script", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-server-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeServableFixture(root, { script: "preview" });

  const server = await startEphemeral({ workdir: root, timeoutMs: 10_000 });
  assert.equal(server.ok, true);
  await server.stop();
});

test("fails clearly when no start/preview/dev script exists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-server-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { build: "echo ok" } }));

  const server = await startEphemeral({ workdir: root, timeoutMs: 2_000 });
  assert.equal(server.ok, false);
  assert.match(server.report, /no.*script found/i);
});

test("times out clearly when the server doesn't bind to the given PORT", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-server-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeServableFixture(root, { honorPort: false });

  const server = await startEphemeral({ workdir: root, timeoutMs: 2_000 });
  assert.equal(server.ok, false);
  assert.match(server.report, /did not respond/i);
});
