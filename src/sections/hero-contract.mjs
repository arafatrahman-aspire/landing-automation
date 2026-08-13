import { buildLeadFormPromptFragment, LEAD_FORM_ANCHOR_ID, LEAD_FORM_HREF } from "../leadform/contract.mjs";

// The hero is the one section that's always ai-required, so this is the only
// place the lead-form contract (fields/honeypot/submission target,
// leadform/contract.mjs) needs threading into a section prompt.
export function buildHeroContract({ requiresJobField, previewLeadSinkUrl }) {
  // The three data-hero-* attributes are what verify's hero-fit check looks
  // for to find and measure these elements — they must stay exactly as named.
  // id="regForm" is what every other section's CTA links to (target-repo
  // frames hardcode href="#regForm"; without this id those buttons go nowhere).
  return `HERO REQUIREMENT (above the fold, no scrolling, at BOTH desktop and mobile widths): one block containing the shortened campaign title, a video-or-details block, and the lead-capture form. Video-or-details and the form sit side by side on desktop, stacked vertically on mobile. Use responsive sizing (e.g. CSS clamp() or the repo's existing type scale) so the title shrinks gracefully rather than overflowing. Mark these three elements with these EXACT attributes (an automated check looks for them to verify placement — plain HTML attributes, not classes): \`data-hero-title\` on the title element, \`data-hero-media\` on the video-or-details block, \`data-hero-form\` on the lead form. These attributes are invisible to visitors and don't affect styling.

CRITICAL — LEAD FORM ANCHOR: the SAME element that has \`data-hero-form\` MUST also have \`id="${LEAD_FORM_ANCHOR_ID}"\` (exactly that id, no other spelling). Every CTA button elsewhere on the page links to \`${LEAD_FORM_HREF}\`; if this id is missing, those buttons do nothing. Example: \`<form data-hero-form id="${LEAD_FORM_ANCHOR_ID}">…</form>\` or \`<div data-hero-form id="${LEAD_FORM_ANCHOR_ID}">…</div>\`.

${buildLeadFormPromptFragment({ requiresJobField, previewLeadSinkUrl })}`;
}

/** Prompt fragment for ANY section that renders a call-to-action button —
 *  links must scroll to the hero lead form, never be dead buttons. */
export function buildCtaLinkPromptFragment() {
  return `CALL-TO-ACTION LINKS: any primary CTA button/link in this section (enroll, register, get started, book a demo, reserve a spot, download, etc.) MUST navigate to the hero lead form via \`href="${LEAD_FORM_HREF}"\` (or an \`<a href="${LEAD_FORM_HREF}">\` wrapping the button). Do not use a bare \`<button>\` with no onClick/href, do not invent other URLs, and do not open a new tab. Prefer: \`<a href="${LEAD_FORM_HREF}"><button type="button">…</button></a>\` or a styled \`<a href="${LEAD_FORM_HREF}">\`.`;
}
