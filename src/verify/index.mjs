import { verifyBuild } from "./build.mjs";
import { findPackageJsonDir } from "./package-manager.mjs";
import { startEphemeral } from "./local-server.mjs";
import { checkHeroFit } from "./hero-fit.mjs";
import { checkSeo } from "./seo-lint.mjs";
import { checkAccessibility } from "./a11y-lint.mjs";

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
 * @returns {Promise<{ok: boolean, report: string, checks: {build: boolean, hero: boolean|null, seo: boolean|null, a11y: boolean|null}}>}
 */
export async function runFullVerifySuite({
  workdir,
  installTimeoutMs,
  buildTimeoutMs,
  changedPaths = [],
  pageUrlPath = null,
  serverTimeoutMs = 30_000,
}) {
  const base = await verifyBuild({ workdir, installTimeoutMs, buildTimeoutMs, changedPaths });
  if (!base.ok) {
    return { ok: false, report: base.report, checks: { build: false, hero: null, seo: null, a11y: null } };
  }

  const pkgDir = await findPackageJsonDir(workdir);
  if (!pkgDir || !pageUrlPath) {
    const reason = !pkgDir ? "not a Node-servable repo" : "PAGE_URL_PATH_TEMPLATE is not configured";
    return {
      ok: true,
      report: `${base.report}\n(Layout/SEO/accessibility checks skipped — ${reason}.)`,
      checks: { build: true, hero: null, seo: null, a11y: null },
    };
  }

  const server = await startEphemeral({ workdir: pkgDir, timeoutMs: serverTimeoutMs });
  if (!server.ok) {
    return {
      ok: false,
      report: `${base.report}\n\nBuild/lint passed, but could not start a server to check layout/SEO/accessibility:\n${server.report}`,
      checks: { build: true, hero: false, seo: false, a11y: false },
    };
  }

  try {
    const url = `${server.baseUrl}${pageUrlPath}`;
    const [hero, seo, a11y] = await Promise.all([checkHeroFit({ url }), checkSeo({ url }), checkAccessibility({ url })]);

    const report = [
      base.report,
      `\nhero-fit: ${hero.ok ? "PASS" : "FAIL"} — ${hero.report}`,
      `seo-lint: ${seo.ok ? "PASS" : "FAIL"} — ${seo.report}`,
      `a11y-lint: ${a11y.ok ? "PASS" : "FAIL"} — ${a11y.report}`,
    ].join("\n");

    return {
      ok: hero.ok && seo.ok && a11y.ok,
      report,
      checks: { build: true, hero: hero.ok, seo: seo.ok, a11y: a11y.ok },
    };
  } finally {
    await server.stop();
  }
}
