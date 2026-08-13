import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  campaignsParentFromAllowlistTemplate,
  quarantineSiblingCampaigns,
} from "../src/git/quarantine-sibling-campaigns.mjs";

test("campaignsParentFromAllowlistTemplate strips the {slug} segment", () => {
  assert.equal(campaignsParentFromAllowlistTemplate("src/app/campaigns/{slug}/"), "src/app/campaigns");
  assert.equal(campaignsParentFromAllowlistTemplate("app/campaigns/{slug}"), "app/campaigns");
  assert.equal(campaignsParentFromAllowlistTemplate("src/app/{slug}/"), "src/app");
  assert.equal(campaignsParentFromAllowlistTemplate("no-slug-here/"), null);
  assert.equal(campaignsParentFromAllowlistTemplate(""), null);
});

test("quarantineSiblingCampaigns removes every campaign dir except the current slug", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "quarantine-"));
  const parent = "src/app/campaigns";
  await mkdir(path.join(root, parent, "soc-analyst-fast-track-bootcamp", "sections"), { recursive: true });
  await mkdir(path.join(root, parent, "weekend-photo-course"), { recursive: true });
  await writeFile(
    path.join(root, parent, "soc-analyst-fast-track-bootcamp", "sections", "DetailsSection1.tsx"),
    "export default function Broken() { return null }\n"
  );
  await writeFile(path.join(root, parent, "weekend-photo-course", "page.tsx"), "export default function P() { return null }\n");
  // Non-directory noise must be left alone.
  await writeFile(path.join(root, parent, "README.md"), "campaigns\n");

  const result = await quarantineSiblingCampaigns({
    workdir: root,
    slug: "weekend-photo-course",
    campaignsParent: parent,
  });

  assert.deepEqual(result.removed, ["src/app/campaigns/soc-analyst-fast-track-bootcamp"]);
  assert.equal(result.kept, "src/app/campaigns/weekend-photo-course");

  await assert.rejects(() => access(path.join(root, parent, "soc-analyst-fast-track-bootcamp")), /ENOENT/);
  await access(path.join(root, parent, "weekend-photo-course", "page.tsx"));
  await access(path.join(root, parent, "README.md"));
});

test("quarantineSiblingCampaigns is a no-op when the campaigns parent is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "quarantine-missing-"));
  const result = await quarantineSiblingCampaigns({
    workdir: root,
    slug: "anything",
    campaignsParent: "src/app/campaigns",
  });
  assert.deepEqual(result, { removed: [], kept: null });
});
