import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { cleanEnvForChildProcess } from "../src/spawn-env.mjs";

/* The bug these guard against, in full:
 *
 * `npm run dev` runs the service under `node --watch`, which sets
 * WATCH_REPORT_DEPENDENCIES=1. Every spawned child inherits it, including the
 * jest-worker processes `next build` uses — which then push Node's internal
 * `{ 'watch:require': … }` messages into jest-worker's own IPC channel. The
 * parent dies with "Unexpected response from worker: undefined" and prints
 * nothing else. Verified against a real worktree: the build takes 71s normally
 * and fails in 1.9s with that variable set. */

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("strips WATCH_REPORT_DEPENDENCIES", () => {
  withEnv({ WATCH_REPORT_DEPENDENCIES: "1" }, () => {
    assert.equal("WATCH_REPORT_DEPENDENCIES" in cleanEnvForChildProcess(), false);
  });
});

test("strips --watch out of NODE_OPTIONS but keeps the rest", () => {
  withEnv({ NODE_OPTIONS: "--max-old-space-size=4096 --watch --enable-source-maps" }, () => {
    assert.equal(cleanEnvForChildProcess().NODE_OPTIONS, "--max-old-space-size=4096 --enable-source-maps");
  });
});

test("removes NODE_OPTIONS entirely when nothing survives", () => {
  // An empty string is not the same as absent to everything that reads it.
  withEnv({ NODE_OPTIONS: "--watch" }, () => {
    assert.equal("NODE_OPTIONS" in cleanEnvForChildProcess(), false);
  });
});

test("does not touch a NODE_OPTIONS that merely contains the word", () => {
  // `--watch-path` is a watch flag and goes; a value that happens to embed the
  // substring is not, and must survive.
  withEnv({ NODE_OPTIONS: "--require=/opt/watchdog/init.js" }, () => {
    assert.equal(cleanEnvForChildProcess().NODE_OPTIONS, "--require=/opt/watchdog/init.js");
  });
  withEnv({ NODE_OPTIONS: "--watch-path=./src --enable-source-maps" }, () => {
    assert.equal(cleanEnvForChildProcess().NODE_OPTIONS, "--enable-source-maps");
  });
});

test("passes everything else through, and applies overrides", () => {
  withEnv({ SOME_UNRELATED_VAR: "keep-me" }, () => {
    const env = cleanEnvForChildProcess({ PORT: "4321" });
    assert.equal(env.SOME_UNRELATED_VAR, "keep-me");
    assert.equal(env.PORT, "4321");
    assert.equal(env.PATH, process.env.PATH);
  });
});

test("an override wins over the inherited value", () => {
  withEnv({ PORT: "1111" }, () => {
    assert.equal(cleanEnvForChildProcess({ PORT: "2222" }).PORT, "2222");
  });
});

/** Spawns a child that prints whether it can see the variable. */
function spawnAndReadEnv(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write(String(process.env.WATCH_REPORT_DEPENDENCIES))"], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
  });
}

test("a real spawned child genuinely cannot see it", async () => {
  // The unit tests above check the object; this checks the thing that actually
  // matters — that the variable does not survive into a child process.
  await withEnv({ WATCH_REPORT_DEPENDENCIES: "1" }, async () => {
    assert.equal(await spawnAndReadEnv(process.env), "1", "sanity: it IS inherited without sanitising");
    assert.equal(await spawnAndReadEnv(cleanEnvForChildProcess()), "undefined");
  });
});
