import { config } from "../../config.mjs";
import * as runStore from "../../state/campaign-repository.mjs";
import { startPreview } from "../../preview/preview-server.mjs";
import { logStage } from "./log-helper.mjs";

// Starts a longer-lived preview server for a human to actually review.
// Non-fatal by design: a preview failure here doesn't fail the run — this is
// the last pipeline step, so the run still ends "staged for review" either
// way, since preview is a convenience on top of an already-verified draft,
// not a gate itself.
export async function previewBuild(state) {
  await runStore.heartbeat(state.runId, "preview_build");
  const pageUrlPath = config.pageUrlPathTemplate
    ? config.pageUrlPathTemplate.replaceAll("{slug}", state.request.slug)
    : null;
  const result = await startPreview({
    runId: state.runId,
    workdir: state.workdir,
    pageUrlPath,
    ttlMs: config.previewTtlMs,
    maxConcurrent: config.maxConcurrentPreviews,
    disableDocker: config.verifyDisableDocker,
  });
  if (!result.ok) {
    await logStage(state.runId, `preview_build: skipped — ${result.report}`);
    return { previewStarted: false };
  }
  await logStage(state.runId, `preview_build: started (${result.kind}) — ${result.url}, expires ${result.expiresAt}`);
  return { previewStarted: true };
}
