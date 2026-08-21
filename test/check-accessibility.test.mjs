import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccessibility } from "../src/verify/check-accessibility.mjs";
import { serveHtml, hasChromium } from "./helpers/static-server.mjs";

const chromiumAvailable = await hasChromium();
const skip = chromiumAvailable ? false : "chromium not installed/launchable in this environment";

test("passes a clean, labeled, well-contrasted page", { skip }, async (t) => {
  const server = await serveHtml(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Spring Sale</title></head>
<body>
  <div data-campaign-theme="">
    <h1>Spring Sale</h1>
    <form>
      <label for="email">Email</label>
      <input id="email" type="email" name="email">
    </form>
  </div>
</body>
</html>`);
  t.after(server.close);

  const result = await checkAccessibility({ url: server.url });
  assert.equal(result.ok, true);
});

test("fails and reports a violation for an unlabeled, unnamed form field", { skip }, async (t) => {
  const server = await serveHtml(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Spring Sale</title></head>
<body>
  <div data-campaign-theme="">
    <h1>Spring Sale</h1>
    <form>
      <input type="email">
    </form>
  </div>
</body>
</html>`);
  t.after(server.close);

  const result = await checkAccessibility({ url: server.url });
  assert.equal(result.ok, false);
  assert.match(result.report, /violations found/i);
});

test("ignores a violation outside [data-campaign-theme] (the target repo's own header/footer)", { skip }, async (t) => {
  const server = await serveHtml(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Spring Sale</title></head>
<body>
  <nav><a href="https://example.com"><img src="x.png"></a></nav>
  <div data-campaign-theme="">
    <h1>Spring Sale</h1>
    <form>
      <label for="email">Email</label>
      <input id="email" type="email" name="email">
    </form>
  </div>
</body>
</html>`);
  t.after(server.close);

  const result = await checkAccessibility({ url: server.url });
  assert.equal(result.ok, true);
});
