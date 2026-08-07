import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHeroFit } from "../src/verify/check-hero-visibility.mjs";
import { serveHtml, hasChromium } from "./helpers/static-server.mjs";

const chromiumAvailable = await hasChromium();
const skip = chromiumAvailable ? false : "chromium not installed/launchable in this environment";

function page(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${bodyHtml}</body></html>`;
}

test("passes when title/media/form all fit above the fold", { skip }, async (t) => {
  const server = await serveHtml(
    page(`
      <h1 data-hero-title>Save 50% today</h1>
      <div data-hero-media style="height:100px">video</div>
      <form data-hero-form style="height:100px"><input /></form>
    `)
  );
  t.after(server.close);

  const result = await checkHeroFit({ url: server.url });
  assert.equal(result.ok, true);
});

test("fails with a specific overflow message when the form is pushed below the fold", { skip }, async (t) => {
  const server = await serveHtml(
    page(`
      <h1 data-hero-title>Save 50% today</h1>
      <div data-hero-media style="height:100px">video</div>
      <div style="height:1200px">spacer pushing the form down</div>
      <form data-hero-form style="height:100px"><input /></form>
    `)
  );
  t.after(server.close);

  const result = await checkHeroFit({ url: server.url });
  assert.equal(result.ok, false);
  assert.match(result.report, /overflows the visible viewport/i);
  assert.match(result.report, /lead form/i);
});

test("fails with a clear message when a required data-hero-* attribute is missing", { skip }, async (t) => {
  const server = await serveHtml(
    page(`
      <h1 data-hero-title>Save 50% today</h1>
      <form data-hero-form><input /></form>
    `)
  );
  t.after(server.close);

  const result = await checkHeroFit({ url: server.url });
  assert.equal(result.ok, false);
  assert.match(result.report, /missing required "data-hero-media"/i);
});
