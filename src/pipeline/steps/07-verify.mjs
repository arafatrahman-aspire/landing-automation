import { config } from "../../config.mjs";
import * as runStore from "../../state/campaign-repository.mjs";
import { runFullVerifySuite } from "../../verify/run-full-verify-suite.mjs";
import { summarizeVerifyReport } from "../../verify/summarize-report.mjs";
import { logStage } from "./log-helper.mjs";

export async function verify(state) {
  if (!state.codeFinished) {
    // 06-generate-sections.mjs already recorded why; nothing to build.
    return {};
  }
  await runStore.heartbeat(state.runId, "verify");
  await logStage(state.runId, "verify: validating the new files (build/lint + hero-fit/seo/a11y, ecosystem-aware)");
  const changedPaths = [...state.writtenByAgent];
  const pageUrlPath = config.pageUrlPathTemplate
    ? config.pageUrlPathTemplate.replaceAll("{slug}", state.request.slug)
    : null;
  const result = await runFullVerifySuite({
    workdir: state.workdir,
    installTimeoutMs: config.verifyInstallTimeoutMs,
    buildTimeoutMs: config.verifyBuildTimeoutMs,
    changedPaths,
    pageUrlPath,
    serverTimeoutMs: config.verifyServerTimeoutMs,
    packageManagerOverride: config.packageManagerOverride,
    disableDocker: config.verifyDisableDocker,
  });
  const verifyAttempts = state.verifyAttempts + 1;

  // Mirrors routeAfterVerify's decision in run-campaign-pipeline.mjs: this is
  // the last attempt, it failed, and CONTINUE_ON_VERIFY_FAILURE says to stage
  // it anyway. Recorded on the run so the review UI can warn that this draft
  // is NOT known to build.
  const willRetry = !result.ok && state.codeAttempts < config.maxCodeAttempts;
  const verifyBypassed = !result.ok && !willRetry && config.continueOnVerifyFailure;

  await runStore.updateRun(state.runId, { verifyAttempts, verifyChecks: result.checks, verifyBypassed });

  // Keep the FULL report per attempt. The scratch worktree is disposable and
  // a failing run never reaches stage_draft, so without this the only surviving
  // copy of a failure was runs.error — and that's written only once retries are
  // exhausted, losing the report from every earlier attempt.
  await runStore.recordVerifyReport({ runId: state.runId, attempt: verifyAttempts, ok: result.ok, report: result.report, checks: result.checks });

  // Log the meaningful part, not the first 500 characters — a failing
  // `npm ci && npm run build` puts ~1.4KB of install chatter ahead of the
  // actual compiler error, which made every logged failure look identical.
  await logStage(
    state.runId,
    `verify: ${result.ok ? "PASSED" : "FAILED"} — ${result.ok ? result.report.slice(0, 300) : summarizeVerifyReport(result.report)}`
  );
  if (verifyBypassed) {
    await logStage(
      state.runId,
      "verify: CONTINUE_ON_VERIFY_FAILURE=true — staging this draft for review anyway. THE PAGE IS NOT KNOWN TO BUILD; do not approve it without checking the errors above."
    );
  }
  return { verifyPassed: result.ok, verifyReport: result.ok ? null : result.report, verifyAttempts, verifyBypassed };
}
