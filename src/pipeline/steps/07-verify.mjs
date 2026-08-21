import { config, resolveAllowlist } from "../../config.mjs";
import * as runStore from "../../state/campaign-repository.mjs";
import { runFullVerifySuite } from "../../verify/run-full-verify-suite.mjs";
import { summarizeVerifyReport } from "../../verify/summarize-report.mjs";
import { extractFailingFiles, extractAllBlamedFiles } from "../../verify/failing-files.mjs";
import { isNextEslintToolingMismatch } from "../../verify/build-and-lint.mjs";
import { campaignsParentFromAllowlistTemplate } from "../../git/quarantine-sibling-campaigns.mjs";
import { logStage } from "./log-helper.mjs";

export async function verify(state) {
  if (!state.codeFinished) {
    // 06-generate-sections.mjs already recorded why; nothing to build.
    return {};
  }
  await runStore.heartbeat(state.runId, "verify");
  await logStage(
    state.runId,
    `verify: validating the new files (build/lint + hero-fit/seo/a11y). ` +
      `Reuses _base/node_modules when present and compiles this campaign route only (not the whole site).`
  );
  const changedPaths = [...state.writtenByAgent];
  const pageUrlPath = config.pageUrlPathTemplate
    ? config.pageUrlPathTemplate.replaceAll("{slug}", state.request.slug)
    : null;
  const campaignsParent = campaignsParentFromAllowlistTemplate(config.writePathAllowlistTemplates[0] ?? "");
  const result = await runFullVerifySuite({
    workdir: state.workdir,
    installTimeoutMs: config.verifyInstallTimeoutMs,
    buildTimeoutMs: config.verifyBuildTimeoutMs,
    changedPaths,
    pageUrlPath,
    serverTimeoutMs: config.verifyServerTimeoutMs,
    packageManagerOverride: config.packageManagerOverride,
    disableDocker: config.verifyDisableDocker,
    logger: (msg) => logStage(state.runId, msg),
    campaignSlug: state.request.slug,
    campaignsParent,
    enableHeroFitCheck: config.enableHeroFitCheck,
    enableA11yCheck: config.enableA11yCheck,
  });
  const verifyAttempts = state.verifyAttempts + 1;

  // Distinguish "our generated code is broken" from "the target repo doesn't
  // build". If a failure blames files but NONE of them are ours, regenerating
  // sections cannot possibly help — a real run spent days looking like a
  // codegen bug when the repo's own src/app/soc-health-check/page.tsx had a
  // type error committed weeks earlier. Also used to skip the retry loop:
  // burning MAX_CODE_ATTEMPTS on a foreign defect only delays the same failure.
  let verifyForeignFailure = false;
  if (!result.ok) {
    const allowlistBase = resolveAllowlist(config.writePathAllowlistTemplates, state.request.slug)[0];
    const ours = extractFailingFiles(result.report, { allowlistBase });
    const everything = extractAllBlamedFiles(result.report);
    // Blamed files elsewhere, OR a tooling crash that names no source file at
    // all (Next 14 `next lint` + ESLint 9 Invalid Options) — neither is fixed
    // by regenerating this campaign's sections.
    verifyForeignFailure =
      (everything.size > 0 && ours.size === 0) || isNextEslintToolingMismatch(result.report);
  }

  // Mirrors decideAfterVerify in pipeline/decide-after-verify.mjs: last attempt
  // (or foreign-only), failed, and CONTINUE_ON_VERIFY_FAILURE says to stage
  // anyway. Recorded on the run so the review UI can warn that this draft is
  // NOT known to build.
  const willRetry =
    !result.ok && !verifyForeignFailure && state.codeAttempts < config.maxCodeAttempts;
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
  if (verifyForeignFailure) {
    const everything = extractAllBlamedFiles(result.report);
    await logStage(
      state.runId,
      `verify: NOT CAUSED BY THIS RUN — the build failed only in files this campaign did not create: ${[...everything].join(", ")}. ` +
        `The target repository does not build on its own, so regenerating sections cannot fix it. Skipping further code retries. Fix those files in the target repo (or on its base branch) and re-run.`
    );
  }

  if (verifyBypassed) {
    await logStage(
      state.runId,
      "verify: CONTINUE_ON_VERIFY_FAILURE=true — staging this draft for review anyway. THE PAGE IS NOT KNOWN TO BUILD; do not approve it without checking the errors above."
    );
  }
  return {
    verifyPassed: result.ok,
    verifyReport: result.ok ? null : result.report,
    verifyAttempts,
    verifyBypassed,
    verifyForeignFailure,
  };
}
