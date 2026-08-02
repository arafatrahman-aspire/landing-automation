import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasDocker, parseDockerBuildStage, verifyBuildInDocker } from "../src/verify/docker-build.mjs";

// Cached locally in dev (used to build the real target repo's own image) —
// picking an already-pulled image keeps these tests fast and offline-safe
// when it's present; they still work via a real pull if it's not.
const TEST_NODE_IMAGE = "node:14.18.2";

const dockerAvailable = await hasDocker();
const skip = dockerAvailable ? false : "docker not available/reachable in this environment";

async function makeFixture({ dockerfile, packageJson, extraFiles = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "docker-build-test-"));
  if (dockerfile !== null) {
    await writeFile(path.join(dir, "Dockerfile"), dockerfile ?? "");
  }
  if (packageJson !== null) {
    await writeFile(path.join(dir, "package.json"), JSON.stringify(packageJson ?? { name: "fixture" }));
  }
  for (const [rel, content] of Object.entries(extraFiles)) {
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}

test("parseDockerBuildStage returns null when there's no Dockerfile", async () => {
  const dir = await makeFixture({ dockerfile: null });
  assert.equal(await parseDockerBuildStage(dir), null);
  await rm(dir, { recursive: true, force: true });
});

test("parseDockerBuildStage returns null when the first stage isn't a node: image", async () => {
  const dir = await makeFixture({ dockerfile: "FROM nginx:latest\nRUN echo hi\n" });
  assert.equal(await parseDockerBuildStage(dir), null);
  await rm(dir, { recursive: true, force: true });
});

test("parseDockerBuildStage extracts the node image and first-stage RUN commands only", async () => {
  const dockerfile = [
    "FROM node:14.18.2 AS builder",
    "WORKDIR /app",
    "COPY package.json ./",
    "RUN npm cache clean --force",
    "RUN npm install --force",
    "#RUN npm install",
    "COPY . ./",
    "RUN npm run build",
    "",
    "FROM nginx:latest",
    "RUN echo this must not appear",
  ].join("\n");
  const dir = await makeFixture({ dockerfile });
  const result = await parseDockerBuildStage(dir);
  assert.deepEqual(result, {
    nodeImage: "node:14.18.2",
    commands: ["npm cache clean --force", "npm install --force", "npm run build"],
  });
  await rm(dir, { recursive: true, force: true });
});

test("parseDockerBuildStage returns null when the first stage has no RUN commands at all", async () => {
  const dir = await makeFixture({ dockerfile: "FROM node:18\nWORKDIR /app\nCOPY . .\n" });
  assert.equal(await parseDockerBuildStage(dir), null);
  await rm(dir, { recursive: true, force: true });
});

test("hasDocker reflects real daemon reachability", async () => {
  // Whatever the real answer is here, it must be a boolean and must not throw.
  assert.equal(typeof dockerAvailable, "boolean");
});

test("verifyBuildInDocker runs real install+build commands inside a real container and passes", { skip }, async () => {
  const dir = await makeFixture({
    dockerfile: null,
    packageJson: { name: "fixture", version: "1.0.0", scripts: { build: "node -e \"console.log('build ok')\"" } },
  });
  const result = await verifyBuildInDocker({
    workdir: dir,
    nodeImage: TEST_NODE_IMAGE,
    commands: ["npm run build"],
    installTimeoutMs: 60_000,
    buildTimeoutMs: 60_000,
  });
  assert.equal(result.ok, true, result.report);
  assert.match(result.report, /passed/);
  await rm(dir, { recursive: true, force: true });
});

test("verifyBuildInDocker reports failure with real container output when a command fails", { skip }, async () => {
  const dir = await makeFixture({
    dockerfile: null,
    packageJson: { name: "fixture", version: "1.0.0", scripts: { build: "node -e \"process.exit(1)\"" } },
  });
  const result = await verifyBuildInDocker({
    workdir: dir,
    nodeImage: TEST_NODE_IMAGE,
    commands: ["npm run build"],
    installTimeoutMs: 60_000,
    buildTimeoutMs: 60_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.report, /failed/);
  await rm(dir, { recursive: true, force: true });
});

test("verifyBuildInDocker times out and kills the container instead of hanging forever", { skip }, async () => {
  const dir = await makeFixture({ dockerfile: null, packageJson: { name: "fixture" } });
  const start = Date.now();
  const result = await verifyBuildInDocker({
    workdir: dir,
    nodeImage: TEST_NODE_IMAGE,
    commands: ["sleep 30"],
    installTimeoutMs: 1000,
    buildTimeoutMs: 0,
  });
  assert.equal(result.ok, false);
  assert.match(result.report, /timed out/);
  assert.ok(Date.now() - start < 15_000, "should not have waited anywhere near the full 30s sleep");
  await rm(dir, { recursive: true, force: true });
});

test("verifyBuildInDocker writes files owned by the current host user, not root (bind-mount safety)", { skip }, async () => {
  const dir = await makeFixture({
    dockerfile: null,
    packageJson: { name: "fixture", version: "1.0.0", scripts: { build: "true" } },
  });
  await verifyBuildInDocker({
    workdir: dir,
    nodeImage: TEST_NODE_IMAGE,
    commands: ["touch created-by-container.txt", "npm run build"],
    installTimeoutMs: 60_000,
    buildTimeoutMs: 60_000,
  });
  const { stat } = await import("node:fs/promises");
  const s = await stat(path.join(dir, "created-by-container.txt"));
  assert.equal(s.uid, process.getuid());
  await rm(dir, { recursive: true, force: true });
});
