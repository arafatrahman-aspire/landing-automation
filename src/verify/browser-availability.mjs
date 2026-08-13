import { chromium } from "playwright";

/* Is a real browser actually launchable right now?
 *
 * `playwright` the npm package is a dependency, but the BROWSER it drives is a
 * separate ~150MB download (`npx playwright install chromium`) that is not
 * installed by `npm ci`. So `import { chromium }` always succeeds while
 * `chromium.launch()` rejects with:
 *
 *   browserType.launch: Executable doesn't exist at
 *   /home/…/.cache/ms-playwright/chromium_headless_shell-…/chrome-headless-shell
 *
 * That rejection used to escape runFullVerifySuite's `Promise.all` uncaught and
 * take the whole run down at the verify step — a missing optional tool
 * presenting as a hard pipeline crash. Probing for it first turns the three
 * browser-backed checks into SKIPPED (reported as `null`, rendered "not run")
 * instead, which is what they honestly are. */

let cached = null;

/** @returns {Promise<{ok: boolean, reason?: string}>} */
export async function checkBrowserAvailable() {
  // Launching a browser is expensive and the answer cannot change inside one
  // process lifetime — an install between two verify attempts of the same run
  // isn't a case worth paying for on every attempt.
  if (cached) return cached;
  try {
    const browser = await chromium.launch();
    await browser.close();
    cached = { ok: true };
  } catch (err) {
    cached = { ok: false, reason: err?.message?.split("\n")[0] ?? String(err) };
  }
  return cached;
}

/** Test-only: forget the cached probe result. */
export function resetBrowserAvailabilityCache() {
  cached = null;
}
