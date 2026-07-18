import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccessibility } from "../src/verify/a11y-lint.mjs";
import { serveHtml, hasChromium } from "./helpers/static-server.mjs";

const chromiumAvailable = await hasChromium();
const skip = chromiumAvailable ? false : "chromium not installed/launchable in this environment";

test("passes a clean, labeled, well-contrasted page", { skip }, async (t) => {
  const server = await serveHtml(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Spring Sale</title></head>
<body>
  <h1>Spring Sale</h1>
  <form>
    <label for="email">Email</label>
    <input id="email" type="email" name="email">
  </form>
</body>
</html>`);
  t.after(server.close);

  const result = await checkAccessibility({ url: server.url });
  assert.equal(result.ok, true);
});

test("fails and reports a violation for an unlabeled form field", { skip }, async (t) => {
  const server = await serveHtml(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Spring Sale</title></head>
<body>
  <h1>Spring Sale</h1>
  <form>
    <input type="email" name="email" placeholder="Email">
  </form>
</body>
</html>`);
  t.after(server.close);

  const result = await checkAccessibility({ url: server.url });
  assert.equal(result.ok, false);
  assert.match(result.report, /violations found/i);
});
