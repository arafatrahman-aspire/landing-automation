import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

/* Deterministic accessibility gate (new_plan.md §4.6, Layer 1) — WCAG 2A/2AA
 * via axe-core: contrast, ARIA misuse, unlabeled form fields, etc. */

/**
 * @param {object} p
 * @param {string} p.url - already-served page URL to check
 * @returns {Promise<{ok: boolean, report: string}>}
 */
export async function checkAccessibility({ url }) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();

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
