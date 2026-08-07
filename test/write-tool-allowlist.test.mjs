import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWritePath } from "../src/llm/filesystem-tools.mjs";

/* The most important test in the service: proves the write-tool guard is
 * airtight offline, with no filesystem/network/LLM involved. */

const workdir = "/fake/workdir";
const allowedPrefixes = ["app/campaigns/spring-sale/"];
const pristineFiles = new Set(["app/layout.tsx", "package.json", "app/campaigns/other-camp/page.tsx"]);
const manifestPaths = new Set(["app/campaigns/spring-sale/page.tsx", "app/campaigns/spring-sale/Hero.tsx"]);

function check(requestedPath, writtenByAgent = new Set()) {
  return resolveWritePath({ requestedPath, workdir, allowedPrefixes, pristineFiles, writtenByAgent, manifestPaths });
}

test("accepts a legitimate new manifest path", () => {
  const result = check("app/campaigns/spring-sale/page.tsx");
  assert.equal(result.ok, true);
  assert.equal(result.relativePath, "app/campaigns/spring-sale/page.tsx");
});

test("rejects path traversal via .. that escapes workdir", () => {
  // 4 levels up from a 3-segment relative path pops past workdir itself.
  const result = check("app/campaigns/spring-sale/../../../../etc/passwd");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "path_traversal");
});

test("a .. traversal that stays CONTAINED within workdir is still safe (rejected by the allowlist, not misidentified as escaping)", () => {
  // 3 levels up from a 3-segment relative path lands back at workdir/etc/passwd —
  // never leaves workdir at the OS level, so it must be caught by the allowlist
  // check, not misreported as a traversal.
  const result = check("app/campaigns/spring-sale/../../../etc/passwd");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "outside_allowlist");
});

test("rejects absolute paths", () => {
  const result = check("/etc/passwd");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "path_traversal");
});

test("rejects overwriting a pristine (pre-existing) file, even if it happens to be in the manifest", () => {
  // Defense in depth: pristine check must win even in a pathological case
  // where the manifest itself is wrong.
  const manifestWithPristine = new Set(["app/layout.tsx"]);
  const result = resolveWritePath({
    requestedPath: "app/layout.tsx",
    workdir,
    allowedPrefixes: ["app/"],
    pristineFiles,
    writtenByAgent: new Set(),
    manifestPaths: manifestWithPristine,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "already_exists");
});

test("allows rewriting a file the agent itself created earlier in the same run", () => {
  const writtenByAgent = new Set(["app/campaigns/spring-sale/page.tsx"]);
  // Not in pristineFiles, so this exercises the "already written by agent" path,
  // not the pristine guard — proving iteration across turns/retries works.
  const result = check("app/campaigns/spring-sale/page.tsx", writtenByAgent);
  assert.equal(result.ok, true);
});

test("rejects a path outside the allowed prefix", () => {
  // Must NOT collide with a pristineFiles entry, or the (correctly stricter)
  // already_exists check would fire first — this isolates the allowlist check.
  const result = check("app/campaigns/other-camp/brand-new-file.tsx");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "outside_allowlist");
});

test("rejects a path inside the allowlist but not declared in the manifest", () => {
  const result = check("app/campaigns/spring-sale/random-extra-file.tsx");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_in_manifest");
});

test("rejects an empty path", () => {
  const result = check("");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "path_traversal");
});

test("rejects a sneaky traversal that re-enters the allowed prefix (still blocked: escapes workdir)", () => {
  const result = check("app/campaigns/spring-sale/../../../../app/campaigns/spring-sale/page.tsx");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "path_traversal");
});
