import { verifyBuild } from "./build-and-lint.mjs";
import { findPackageJsonDir } from "./detect-package-manager.mjs";
import { startEphemeral, warmUpRoute } from "./ephemeral-server.mjs";
import { checkHeroFit } from "./check-hero-visibility.mjs";
import { checkSeo } from "./check-seo-tags.mjs";
import { checkAccessibility } from "./check-accessibility.mjs";
import { checkBrowserAvailable } from "./browser-availability.mjs";

/* Coordinates the full deterministic verify suite (new_plan.md §4.6, Layer 1):
 * build/lint first (fail fast — no point measuring the layout of something
 * that doesn't even build), then — only if that passes, and only for a
 * Node-servable repo with a configured page URL — hero-fit/seo-lint/a11y-lint
 * together against one ephemeral server, so a single retry round trip
 * surfaces every failing dimension at once instead of one at a time. */

/**
 * @param {object} p
 * @param {string} p.workdir
 * @param {number} p.installTimeoutMs
 * @param {number} p.buildTimeoutMs
 * @param {string[]} [p.changedPaths]
 * @param {string|null} [p.pageUrlPath] - e.g. "/campaigns/spring-sale" (already slug-resolved)
 * @param {number} [p.serverTimeoutMs]
 * @param {string|null} [p.packageManagerOverride] see package-manager.mjs's detectPackageManager
 * @param {boolean} [p.disableDocker] skip the Docker-based build path even if usable — see build.mjs
 * @param {string} [p.campaignSlug]
 * @param {string|null} [p.campaignsParent]
 * @param {boolean} [p.enableHeroFitCheck] - set false to never run/fail on hero-fit
 * @param {boolean} [p.enableA11yCheck] - set false to never run/fail on a11y-lint
 * @returns {Promise<{ok: boolean, report: string, checks: {build: boolean, hero: boolean|null, seo: boolean|null, a11y: boolean|null}}>}
 */
export async function runFullVerifySuite({
  workdir,
  installTimeoutMs,
  buildTimeoutMs,
  changedPaths = [],
  pageUrlPath = null,
  serverTimeoutMs = 30_000,
  packageManagerOverride = null,
  disableDocker = false,
  logger = () => {},
  campaignSlug = null,
  campaignsParent = null,
  enableHeroFitCheck = true,
  enableA11yCheck = true,
}) {
  const base = await verifyBuild({
    workdir,
    installTimeoutMs,
    buildTimeoutMs,
    changedPaths,
    packageManagerOverride,
    disableDocker,
    logger,
    campaignSlug,
    campaignsParent,
  });
  if (!base.ok) {
    return { ok: false, report: base.report, checks: { build: false, hero: null, seo: null, a11y: null } };
  }

  const pkgDir = await findPackageJsonDir(workdir);
  // All three remaining checks drive a real browser against a real server. Any
  // of these three preconditions missing means they can't run — which is a
  // SKIP, not a failure: the build gate already passed, and reporting `null`
  // ("not run") is the honest answer. Crashing here instead would fail a run
  // over an optional tool that was never installed.
  const browser = !pkgDir || !pageUrlPath ? { ok: false } : await checkBrowserAvailable();
  if (!pkgDir || !pageUrlPath || !browser.ok) {
    let reason;
    if (!pkgDir) reason = "not a Node-servable repo";
    else if (!pageUrlPath) reason = "PAGE_URL_PATH_TEMPLATE is not configured";
    else reason = `no browser available — ${browser.reason}. Run \`npx playwright install chromium\` to enable them`;
    return {
      ok: true,
      report: `${base.report}\n(Layout/SEO/accessibility checks skipped — ${reason}.)`,
      checks: { build: true, hero: null, seo: null, a11y: null },
    };
  }

  logger("verify: build passed — starting the page to check hero-fit / SEO / accessibility");
  const server = await startEphemeral({ workdir: pkgDir, timeoutMs: serverTimeoutMs, packageManagerOverride });
  if (!server.ok) {
    return {
      ok: false,
      report: `${base.report}\n\nBuild/lint passed, but could not start a server to check layout/SEO/accessibility:\n${server.report}`,
      checks: { build: true, hero: false, seo: false, a11y: false },
    };
  }

  try {
    const url = `${server.baseUrl}${pageUrlPath}`;

    // Pre-warm the campaign route so Next.js (or any other lazy-compiling
    // framework) finishes its cold compilation ONCE before three Playwright
    // tabs all try to navigate to the same uncached page simultaneously.
    // Without this, only one of the three wins the compilation race; the other
    // two time out.
    logger(`verify: warming up ${pageUrlPath} (waiting for first non-5xx response before opening browsers)…`);
    const warmed = await warmUpRoute(server.baseUrl, pageUrlPath, 90_000);
    if (!warmed) {
      logger(`verify: warm-up timed out for ${pageUrlPath} — browsers will attempt to navigate anyway`);
    }

    // Disabled checks are skipped entirely, not run-and-ignored: `checks.hero`/
    // `checks.a11y` land as `null` ("not run"), same convention already used
    // above when no browser is available, so a disabled check can never
    // itself fail a run or masquerade as a genuine PASS.
    const heroPromise = enableHeroFitCheck
      ? checkHeroFit({ url })
      : Promise.resolve({ ok: true, report: "SKIPPED — ENABLE_HERO_FIT_CHECK=false." });
    const a11yPromise = enableA11yCheck
      ? checkAccessibility({ url })
      : Promise.resolve({ ok: true, report: "SKIPPED — ENABLE_A11Y_CHECK=false." });

    const [hero, seo, a11y] = await Promise.all([heroPromise, checkSeo({ url }), a11yPromise]);

    const report = [
      base.report,
      `\nhero-fit: ${!enableHeroFitCheck ? "SKIPPED" : hero.ok ? "PASS" : "FAIL"} — ${hero.report}`,
      `seo-lint: ${seo.ok ? "PASS" : "FAIL"} — ${seo.report}`,
      `a11y-lint: ${!enableA11yCheck ? "SKIPPED" : a11y.ok ? "PASS" : "FAIL"} — ${a11y.report}`,
    ].join("\n");

    return {
      ok: hero.ok && seo.ok && a11y.ok,
      report,
      checks: { build: true, hero: enableHeroFitCheck ? hero.ok : null, seo: seo.ok, a11y: enableA11yCheck ? a11y.ok : null },
    };
  } finally {
    await server.stop();
  }
}
