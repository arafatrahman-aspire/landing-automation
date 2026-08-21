import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appDirFromCampaignsParent, quarantineUnrelatedAppRoutes } from "../src/git/quarantine-unrelated-app-routes.mjs";
import { patchTsconfigInclude } from "../src/verify/narrow-tsconfig-for-campaign.mjs";
import { linkSharedInstall, baseDirNextToWorktree } from "../src/verify/reuse-base-install.mjs";

test("appDirFromCampaignsParent is the App Router root", () => {
  assert.equal(appDirFromCampaignsParent("src/app/campaigns"), "src/app");
  assert.equal(appDirFromCampaignsParent("app/campaigns"), "app");
  assert.equal(appDirFromCampaignsParent(null), null);
});

test("quarantineUnrelatedAppRoutes keeps layout and campaigns, stashes the rest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stash-app-"));
  const app = path.join(root, "src/app");
  await mkdir(path.join(app, "campaigns", "n8n-course"), { recursive: true });
  await mkdir(path.join(app, "cyber-security"), { recursive: true });
  await mkdir(path.join(app, "resources", "blog"), { recursive: true });
  await writeFile(path.join(app, "layout.tsx"), "export default function L({ children }) { return children }\n");
  await writeFile(path.join(app, "page.tsx"), "export default function Home() { return null }\n");
  await writeFile(path.join(app, "globals.css"), "body{}\n");
  await writeFile(path.join(app, "campaigns", "n8n-course", "page.tsx"), "export default function C() { return null }\n");
  await writeFile(path.join(app, "cyber-security", "page.tsx"), "export default function X() { return null }\n");

  const result = await quarantineUnrelatedAppRoutes({ workdir: root, campaignsParent: "src/app/campaigns" });
  assert.ok(result.moved.includes("src/app/cyber-security"));
  assert.ok(result.moved.includes("src/app/resources"));
  assert.ok(result.moved.includes("src/app/page.tsx"));

  await readFile(path.join(app, "layout.tsx"));
  await readFile(path.join(app, "globals.css"));
  await readFile(path.join(app, "campaigns", "n8n-course", "page.tsx"));
  await readFile(path.join(app, "_verify_skip", "cyber-security", "page.tsx"));
  await readFile(path.join(app, "_verify_skip", "page.tsx"));

  const again = await quarantineUnrelatedAppRoutes({ workdir: root, campaignsParent: "src/app/campaigns" });
  assert.deepEqual(again.moved, []);
});

test("patchTsconfigInclude keeps campaign files and root layout only", () => {
  const original = JSON.stringify({
    compilerOptions: { strict: true },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
    exclude: ["node_modules"],
  });
  const { source, changed } = patchTsconfigInclude(original, {
    campaignsParent: "src/app/campaigns",
    slug: "n8n-course-for-ai-engineers",
  });
  assert.equal(changed, true);
  const parsed = JSON.parse(source);
  assert.ok(parsed.include.includes("src/app/campaigns/n8n-course-for-ai-engineers/**/*.tsx"));
  assert.ok(parsed.include.includes("src/app/layout.tsx"));
  assert.ok(!parsed.include.includes("**/*.tsx"));
});

test("linkSharedInstall symlinks _base/node_modules into the worktree", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "shared-nm-"));
  const baseDir = path.join(scratch, "_base");
  const workdir = path.join(scratch, "run-1");
  await mkdir(path.join(baseDir, "node_modules", "next"), { recursive: true });
  await mkdir(path.join(baseDir, ".next", "cache"), { recursive: true });
  await writeFile(path.join(baseDir, "node_modules", "next", "package.json"), "{\"name\":\"next\"}\n");
  await mkdir(workdir, { recursive: true });

  assert.equal(baseDirNextToWorktree(workdir), baseDir);
  const linked = await linkSharedInstall(workdir, { baseDir });
  assert.equal(linked.nodeModules, true);
  assert.equal(linked.nextCache, true);
  const pkg = JSON.parse(await readFile(path.join(workdir, "node_modules", "next", "package.json"), "utf8"));
  assert.equal(pkg.name, "next");

  const second = await linkSharedInstall(workdir, { baseDir });
  assert.equal(second.nodeModules, false);
});
