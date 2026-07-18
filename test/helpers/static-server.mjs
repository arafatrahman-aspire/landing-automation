import http from "node:http";

/** Serves a single in-memory HTML string on a free local port — for testing
 *  the Playwright-based checks against small, precisely-controlled fixture
 *  pages without needing a real framework build. */
export function serveHtml(html) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

let cachedChromiumAvailable;

/** Chromium's download is blocked in some sandboxes/CI (no network egress to
 *  the CDN) — these tests are real (no mocks) but must skip gracefully
 *  rather than fail the whole suite when the browser genuinely isn't
 *  installed. They run for real wherever `npx playwright install chromium`
 *  has actually succeeded (a real dev machine, most CI). */
export async function hasChromium() {
  if (cachedChromiumAvailable !== undefined) return cachedChromiumAvailable;
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    await browser.close();
    cachedChromiumAvailable = true;
  } catch {
    cachedChromiumAvailable = false;
  }
  return cachedChromiumAvailable;
}
