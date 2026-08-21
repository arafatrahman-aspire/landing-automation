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

MOBILE FIT IS THE HARD CONSTRAINT (checked at a 390x844 viewport — real above-the-fold budget, not just "narrow"): title + media block + the FULL lead form, stacked, must fit within 844px of height with NO scrolling. This is the most common reason this check fails, because a full-size lead form (several inputs + submit button) stacked under a title and a details/video block on mobile easily runs past 844px. To stay inside that budget on mobile specifically (use \`md:\` variants to keep desktop spacious):
- Keep vertical padding/gaps tight (e.g. \`py-3\`/\`py-4\`/\`gap-2\`/\`gap-3\`, not \`py-12\`/\`gap-8\`).
- Keep the title to 1-2 short lines at mobile size (e.g. \`text-2xl\`/\`text-3xl\` on mobile, larger only at \`md:\`).
- Keep form inputs compact (e.g. \`py-2\`/\`h-10\`, not tall padded inputs) and skip extra helper/legal text under the form on mobile if it pushes the submit button out of view.
- If the video/details block is tall (e.g. a 16:9 video), give it a capped mobile height (e.g. \`max-h-40\` or \`aspect-video\` inside a height-capped wrapper) rather than letting it take a full-width aspect ratio's worth of height before the form even starts.
- Body/description paragraph copy is the most common overflow cause because its height varies with word count, which is hard to predict while writing it. Don't guess — cap it with a hard mobile clamp so it can never blow the budget regardless of length: \`className="... line-clamp-3 md:line-clamp-none"\` (shows the full paragraph at md+, clips it on mobile). Apply this defensively any time the hero has body copy above the media/form, even if the copy looks short while you're writing it.

CRITICAL — LEAD FORM ANCHOR: the SAME element that has \`data-hero-form\` MUST also have \`id="${LEAD_FORM_ANCHOR_ID}"\` (exactly that id, no other spelling). Every CTA button elsewhere on the page links to \`${LEAD_FORM_HREF}\`; if this id is missing, those buttons do nothing. Example: \`<form data-hero-form id="${LEAD_FORM_ANCHOR_ID}">…</form>\` or \`<div data-hero-form id="${LEAD_FORM_ANCHOR_ID}">…</div>\`.

${buildLeadFormPromptFragment({ requiresJobField, previewLeadSinkUrl })}`;
}

/** Prompt fragment for ANY section that renders a call-to-action button —
 *  links must scroll to the hero lead form, never be dead buttons. */
export function buildCtaLinkPromptFragment() {
  return `CALL-TO-ACTION LINKS: any primary CTA button/link in this section (enroll, register, get started, book a demo, reserve a spot, download, etc.) MUST navigate to the hero lead form via \`href="${LEAD_FORM_HREF}"\` (or an \`<a href="${LEAD_FORM_HREF}">\` wrapping the button). Do not use a bare \`<button>\` with no onClick/href, do not invent other URLs, and do not open a new tab. Prefer: \`<a href="${LEAD_FORM_HREF}"><button type="button">…</button></a>\` or a styled \`<a href="${LEAD_FORM_HREF}">\`.`;
}
