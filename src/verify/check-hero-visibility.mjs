import { chromium } from "playwright";

/* Deterministic, non-negotiable check (new_plan.md §4.5): the hero — title,
 * video-or-details block, and lead form — must be visible without
 * scrolling, on both desktop and mobile. Locating these three elements
 * reliably on an arbitrary generated page needs a hook the coding agent is
 * told to add (steps.mjs's code() system prompt requires exactly these three
 * data attributes) — guessing via heuristics (first <form>, biggest <video>,
 * ...) would be fragile and give confusing failures. A missing attribute is
 * itself reported as a structured, fixable error, same as an overflow. */

export const HERO_HOOKS = [
  { attr: "data-hero-title", label: "hero title" },
  { attr: "data-hero-media", label: "hero video-or-details block" },
  { attr: "data-hero-form", label: "lead form" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/**
 * @param {object} p
 * @param {string} p.url - already-served page URL to check
 * @returns {Promise<{ok: boolean, report: string}>}
 */
export async function checkHeroFit({ url }) {
  const browser = await chromium.launch();
  try {
    const problems = [];
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
        for (const hook of HERO_HOOKS) {
          const locator = page.locator(`[${hook.attr}]`).first();
          const count = await page.locator(`[${hook.attr}]`).count();
          if (count === 0) {
            problems.push(`[${viewport.name}] missing required "${hook.attr}" attribute on the ${hook.label} — cannot verify its placement.`);
            continue;
          }
          const box = await locator.boundingBox();
          if (!box) {
            problems.push(`[${viewport.name}] ${hook.label} ("${hook.attr}") exists but isn't visible/rendered.`);
            continue;
          }
          const overflowBottom = box.y + box.height - viewport.height;
          if (overflowBottom > 0) {
            problems.push(
              `[${viewport.name}] ${hook.label} overflows the visible viewport by ${Math.round(overflowBottom)}px ` +
                `(bottom edge at ${Math.round(box.y + box.height)}px, viewport height ${viewport.height}px) — requires scrolling to see.`
            );
          }
        }
      } finally {
        await page.close();
      }
    }
    if (problems.length > 0) {
      return { ok: false, report: `Hero above-the-fold check failed:\n${problems.join("\n")}` };
    }
    return { ok: true, report: "Hero (title, video-or-details, lead form) fits above the fold at both desktop (1440x900) and mobile (390x844)." };
  } finally {
    await browser.close();
  }
}
