import { chromium } from "playwright";

/* Deterministic SEO checks (new_plan.md §4.6, Layer 1) on the actual rendered
 * page — length/presence checks only. Whether the COPY itself reads well is
 * a Layer-2 (validate/) LLM judgment call from a later phase, not this. */

const TITLE_MAX = 70;
const META_DESC_MAX = 200;

/**
 * @param {object} p
 * @param {string} p.url - already-served page URL to check
 * @returns {Promise<{ok: boolean, report: string}>}
 */
export async function checkSeo({ url }) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
    const problems = [];

    const title = await page.title();
    if (!title || title.trim().length === 0) {
      problems.push("Missing <title>.");
    } else if (title.length > TITLE_MAX) {
      problems.push(`<title> is ${title.length} chars, over the ${TITLE_MAX}-char recommended max.`);
    }

    const metaDesc = await page.locator('meta[name="description"]').first().getAttribute("content").catch(() => null);
    if (!metaDesc) {
      problems.push('Missing <meta name="description">.');
    } else if (metaDesc.length > META_DESC_MAX) {
      problems.push(`meta description is ${metaDesc.length} chars, over the ${META_DESC_MAX}-char recommended max.`);
    }

    const h1Count = await page.locator("h1").count();
    if (h1Count === 0) problems.push("No <h1> found.");
    else if (h1Count > 1) problems.push(`${h1Count} <h1> elements found — should be exactly one.`);

    const images = await page.locator("img").all();
    let missingAlt = 0;
    for (const img of images) {
      const alt = await img.getAttribute("alt");
      if (alt === null || alt.trim() === "") missingAlt++;
    }
    if (missingAlt > 0) problems.push(`${missingAlt} <img> element(s) missing alt text.`);

    const canonicalCount = await page.locator('link[rel="canonical"]').count();
    if (canonicalCount === 0) problems.push('Missing <link rel="canonical">.');

    const jsonLdCount = await page.locator('script[type="application/ld+json"]').count();
    if (jsonLdCount === 0) problems.push("Missing structured data (a <script type=\"application/ld+json\"> tag).");

    const ogTitleCount = await page.locator('meta[property="og:title"]').count();
    const ogDescCount = await page.locator('meta[property="og:description"]').count();
    if (ogTitleCount === 0 || ogDescCount === 0) problems.push("Missing Open Graph tags (og:title/og:description).");

    const viewportCount = await page.locator('meta[name="viewport"]').count();
    if (viewportCount === 0) problems.push('Missing <meta name="viewport"> — also needed for the mobile hero-fit check to be meaningful.');

    if (problems.length > 0) {
      return { ok: false, report: `SEO lint failed:\n${problems.map((p) => `- ${p}`).join("\n")}` };
    }
    return {
      ok: true,
      report: "SEO checks passed (title/meta length, single h1, alt text, canonical tag, JSON-LD, Open Graph tags, viewport meta).",
    };
  } finally {
    await browser.close();
  }
}
