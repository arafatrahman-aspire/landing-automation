import { buildLeadFormPromptFragment } from "../leadform/contract.mjs";

// The hero is the one section that's always ai-required, so this is the only
// place the lead-form contract (fields/honeypot/submission target,
// leadform/contract.mjs) needs threading into a section prompt.
export function buildHeroContract({ requiresJobField, previewLeadSinkUrl }) {
  // The three data-hero-* attributes are what verify's hero-fit check looks
  // for to find and measure these elements — they must stay exactly as named.
  return `HERO REQUIREMENT (above the fold, no scrolling, at BOTH desktop and mobile widths): one block containing the shortened campaign title, a video-or-details block, and the lead-capture form. Video-or-details and the form sit side by side on desktop, stacked vertically on mobile. Use responsive sizing (e.g. CSS clamp() or the repo's existing type scale) so the title shrinks gracefully rather than overflowing. Mark these three elements with these EXACT attributes (an automated check looks for them to verify placement — plain HTML attributes, not classes): \`data-hero-title\` on the title element, \`data-hero-media\` on the video-or-details block, \`data-hero-form\` on the lead form. These attributes are invisible to visitors and don't affect styling.

${buildLeadFormPromptFragment({ requiresJobField, previewLeadSinkUrl })}`;
}
