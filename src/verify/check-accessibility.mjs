import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

/* Deterministic accessibility gate (new_plan.md §4.6, Layer 1) — WCAG 2A/2AA
 * via axe-core: contrast, ARIA misuse, unlabeled form fields, etc. */

// compose-page.mjs wraps every generated section in this attribute — it's the
// one reliable boundary between "content this campaign generated" and the
// target repo's own shared header/footer/nav, which the campaign page renders
// inside of but never wrote. Scanning the whole document blamed THIS campaign
// for a real run's pre-existing, unrelated header/footer bugs (icon-only nav
// buttons, mailto/tel links with no text, a decorative logo with alt="") —
// bugs no amount of regenerating our own sections could ever fix, since
// they live in src/components/, outside this campaign's allowlist entirely.
const CAMPAIGN_CONTENT_SELECTOR = "[data-campaign-theme]";

/**
 * @param {object} p
 * @param {string} p.url - already-served page URL to check
 * @returns {Promise<{ok: boolean, report: string}>}
 */
export async function checkAccessibility({ url }) {
  const browser = await chromium.launch();
  try {
    // axe-core's finishRun() opens a blank page via page.context().newPage()
    // to stitch cross-frame results together. browser.newPage() creates an
    // implicit single-page context that disallows this, throwing "Please use
    // browser.newContext()" — so we create an explicit context up front.
    const context = await browser.newContext();
    const page = await context.newPage();
    // "networkidle" never resolves on Next.js pages that keep open connections
    // (analytics, RSC polling, etc.). "load" is sufficient for axe-core to
    // analyze the fully rendered DOM.
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .include(CAMPAIGN_CONTENT_SELECTOR)
      .analyze();

    if (results.violations.length > 0) {
      const report = results.violations
        .map((v) => `- [${v.impact ?? "unknown"}] ${v.id}: ${v.help} (${v.nodes.length} element(s))`)
        .join("\n");
      return { ok: false, report: `Accessibility violations found (axe-core, WCAG 2A/2AA):\n${report}` };
    }
    return { ok: true, report: "No WCAG 2A/2AA accessibility violations found (axe-core)." };
  } finally {
    await browser.close();
  }
}
