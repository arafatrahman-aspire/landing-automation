import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSeo } from "../src/verify/check-seo-tags.mjs";
import { serveHtml, hasChromium } from "./helpers/static-server.mjs";

const chromiumAvailable = await hasChromium();
const skip = chromiumAvailable ? false : "chromium not installed/launchable in this environment";

const COMPLIANT_PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Spring Sale — 50% Off Annual Plans</title>
  <meta name="description" content="Save 50% on annual plans this spring. Limited-time offer for small business owners.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="https://example.com/campaigns/spring-sale">
  <meta property="og:title" content="Spring Sale — 50% Off">
  <meta property="og:description" content="Save 50% on annual plans this spring.">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Offer"}</script>
</head>
<body>
  <h1>Spring Sale — 50% Off Annual Plans</h1>
  <img src="/hero.png" alt="Team celebrating a sale">
</body>
</html>`;

test("passes a fully SEO-compliant page", { skip }, async (t) => {
  const server = await serveHtml(COMPLIANT_PAGE);
  t.after(server.close);
  const result = await checkSeo({ url: server.url });
  assert.equal(result.ok, true);
});

test("reports every missing/invalid element on a non-compliant page", { skip }, async (t) => {
  const server = await serveHtml(`<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <h1>First</h1>
  <h1>Second — two h1s</h1>
  <img src="/x.png">
</body></html>`);
  t.after(server.close);

  const result = await checkSeo({ url: server.url });
  assert.equal(result.ok, false);
  assert.match(result.report, /missing <title>/i);
  assert.match(result.report, /missing.*meta name="description"/i);
  assert.match(result.report, /2 <h1> elements/i);
  assert.match(result.report, /missing alt text/i);
  assert.match(result.report, /canonical/i);
  assert.match(result.report, /json-ld/i);
  assert.match(result.report, /open graph/i);
  assert.match(result.report, /viewport/i);
});
