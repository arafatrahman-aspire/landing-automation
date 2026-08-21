import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASPIRE_PALETTE,
  resolveColorScheme,
  rewritePaletteInSource,
  campaignThemeStyleTag,
  isAspirePalette,
} from "../src/theme/campaign-colors.mjs";

test("omitted colorScheme resolves to Aspire TSS", () => {
  assert.deepEqual(resolveColorScheme(undefined), ASPIRE_PALETTE);
  assert.deepEqual(resolveColorScheme({ preset: "aspire" }), ASPIRE_PALETTE);
  assert.equal(isAspirePalette(undefined), true);
});

test("custom colorScheme uses the provided hex, lowercased", () => {
  const resolved = resolveColorScheme({
    preset: "custom",
    primary: "#AABBCC",
    secondary: "#112233",
    accent: "#FF6600",
  });
  assert.equal(resolved.preset, "custom");
  assert.equal(resolved.primary, "#aabbcc");
  assert.equal(resolved.secondary, "#112233");
  assert.equal(resolved.accent, "#ff6600");
  assert.equal(isAspirePalette(resolved), false);
});

test("rewritePaletteInSource replaces Aspire hex case-insensitively", () => {
  const source = `className="bg-[#125B80] text-[#004AAD] border-[#ea4b0c]"`;
  const next = rewritePaletteInSource(source, ASPIRE_PALETTE, {
    preset: "custom",
    primary: "#111111",
    secondary: "#222222",
    accent: "#333333",
  });
  assert.equal(next, `className="bg-[#111111] text-[#222222] border-[#333333]"`);
});

test("campaignThemeStyleTag emits CSS variables for the resolved palette", () => {
  const tag = campaignThemeStyleTag(undefined);
  assert.match(tag, /--campaign-primary:#125B80/);
  assert.match(tag, /--campaign-secondary:#004aad/);
  assert.match(tag, /--campaign-accent:#ea4b0c/);
  assert.match(tag, /data-campaign-theme/);
});
