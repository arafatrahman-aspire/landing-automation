/* Campaign color scheme (Aspire TSS by default). Theme is applied only to
 * campaign-scoped files under src/app/campaigns/{slug}/ — never to shared
 * analyze/ frames in the target repo. */

export const ASPIRE_PALETTE = {
  preset: "aspire",
  primary: "#125B80",
  secondary: "#004aad",
  accent: "#ea4b0c",
};

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

export function isHexColor(value) {
  return typeof value === "string" && HEX_RE.test(value);
}

function normalizeHex(value, fallback) {
  if (!isHexColor(value)) return fallback;
  return `#${value.slice(1).toLowerCase()}`;
}

/**
 * Omitted / invalid / preset "aspire" → Aspire TSS. Custom uses the three
 * provided hex values, falling back to Aspire for any missing channel.
 *
 * @param {object|null|undefined} colorScheme
 * @returns {{ preset: "aspire"|"custom", primary: string, secondary: string, accent: string }}
 */
export function resolveColorScheme(colorScheme) {
  if (!colorScheme || typeof colorScheme !== "object" || colorScheme.preset !== "custom") {
    return { ...ASPIRE_PALETTE };
  }
  return {
    preset: "custom",
    primary: normalizeHex(colorScheme.primary, ASPIRE_PALETTE.primary),
    secondary: normalizeHex(colorScheme.secondary, ASPIRE_PALETTE.secondary),
    accent: normalizeHex(colorScheme.accent, ASPIRE_PALETTE.accent),
  };
}

export function isAspirePalette(palette) {
  const resolved = resolveColorScheme(palette);
  return (
    resolved.primary.toLowerCase() === ASPIRE_PALETTE.primary.toLowerCase() &&
    resolved.secondary.toLowerCase() === ASPIRE_PALETTE.secondary.toLowerCase() &&
    resolved.accent.toLowerCase() === ASPIRE_PALETTE.accent.toLowerCase()
  );
}

/** Inline `<style>` that sets campaign CSS variables on the page wrapper. */
export function campaignThemeStyleTag(colorScheme) {
  const palette = resolveColorScheme(colorScheme);
  return `<style>{\`[data-campaign-theme]{--campaign-primary:${palette.primary};--campaign-secondary:${palette.secondary};--campaign-accent:${palette.accent};}\`}</style>`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic replace of one palette's hex values with another's.
 * Case-insensitive; used to recolor an existing draft without an LLM.
 *
 * @param {string} source
 * @param {object} fromScheme
 * @param {object} toScheme
 * @returns {string}
 */
export function rewritePaletteInSource(source, fromScheme, toScheme) {
  if (typeof source !== "string") return source;
  const from = resolveColorScheme(fromScheme);
  const to = resolveColorScheme(toScheme);
  const pairs = [
    [from.primary, to.primary],
    [from.secondary, to.secondary],
    [from.accent, to.accent],
  ];
  // Skip a channel when from === to so we don't churn identical hex.
  // If two "from" colors collide, the later pair wins — palettes are 3 distinct Aspire defaults.
  let next = source;
  for (const [oldHex, newHex] of pairs) {
    if (oldHex.toLowerCase() === newHex.toLowerCase()) continue;
    next = next.replace(new RegExp(escapeRegExp(oldHex), "gi"), newHex);
  }
  return next;
}
