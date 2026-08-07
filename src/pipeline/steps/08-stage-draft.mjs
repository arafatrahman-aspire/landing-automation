import path from "node:path";
import { readFile } from "node:fs/promises";
import * as runStore from "../../state/campaign-repository.mjs";
import * as draftStore from "../../staging/draft-versions.mjs";
import { logStage } from "./log-helper.mjs";

// Records exactly what the agent wrote for this run in the database
// (staging/draft-versions.mjs), before anything touches git — a durable,
// queryable copy of the generated files that the review UI can read/diff
// without needing the scratch worktree to still exist.
export async function stageDraft(state) {
  await runStore.heartbeat(state.runId, "stage_draft");
  const paths = [...state.writtenByAgent];

  // Every section file gets tagged with its slot (new_plan.md §9.6/module.md
  // Module 3) so a per-section refine can version just one slot without
  // touching the rest. The composed page.tsx isn't in sectionResults (it's
  // the one extra path generate_sections writes) — it has no single slot, so
  // it's tagged null, same convention as the schema's own comment.
  const slotByPath = new Map(state.sectionResults.map((r) => [r.path, r.slot]));
  const files = await Promise.all(
    paths.map(async (p) => ({
      path: p,
      content: await readFile(path.join(state.workdir, p), "utf8"),
      sectionSlot: slotByPath.get(p) ?? null,
    }))
  );
  const { version } = await draftStore.stageNewVersion({ runId: state.runId, files });
  await logStage(state.runId, `stage_draft: staged version ${version} (${files.length} file(s), ${slotByPath.size} section slot(s))`);
  return {};
}
