import { test } from "node:test";
import assert from "node:assert/strict";
import { setTestConfigEnv } from "./helpers/test-config-env.mjs";

setTestConfigEnv();
const { config } = await import("../src/config.mjs");

test("ENABLE_HERO_FIT_CHECK / ENABLE_A11Y_CHECK default to true (unset = on)", () => {
  assert.equal(config.enableHeroFitCheck, true);
  assert.equal(config.enableA11yCheck, true);
});
