import { test } from "node:test";
import assert from "node:assert/strict";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv();
const { config } = await import("../src/config.mjs");

test("ENABLE_HERO_FIT_CHECK / ENABLE_A11Y_CHECK default to true (unset = on)", () => {
  assert.equal(config.enableHeroFitCheck, true);
  assert.equal(config.enableA11yCheck, true);
});

test("imageGen defaults include generator order and model URLs", () => {
  assert.equal(config.imageGen.order, "cloudflare,nanobanana,leonardo,promptgone,journey");
  assert.equal(config.imageGen.cloudflareModel, "@cf/black-forest-labs/flux-1-schnell");
  assert.equal(config.imageGen.nanoBananaModel, "gemini-2.5-flash-image");
  assert.ok(config.imageGen.googleApiKey);
});
