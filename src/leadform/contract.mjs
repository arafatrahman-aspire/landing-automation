/* Lead form contract (new_plan.md §4.8/§6 Phase 8). Defines the fields,
 * honeypot convention, and client-side validation every generated hero's
 * lead-capture form must implement, plus the prompt fragment that gets
 * threaded into the coding agent's hero-section prompt
 * (sections/generate-sections.mjs's HERO_CONTRACT).
 *
 * Deliberately NOT built here: real delivery to the parent landing-page
 * platform's lead-intake pipeline — that's a separate, external dependency
 * (new_plan.md §4.8), blocked on that platform exposing a receiving
 * endpoint, not something this service can build standalone. What ships
 * instead is `PREVIEW_LEAD_SINK_PATH`: a no-op endpoint
 * (server.mjs's POST /internal/preview-lead-sink) so a reviewer can click
 * through the generated form during preview without a real lead going
 * anywhere, and the honeypot/validation contract real delivery will
 * eventually plug into unchanged. */

export const HONEYPOT_FIELD_NAME = "company_website";

export const BASE_FIELDS = [
  { name: "name", label: "Full name", type: "text", required: true },
  { name: "phone", label: "Phone number", type: "tel", required: true },
  { name: "email", label: "Email address", type: "email", required: true },
];

export const JOB_TITLE_FIELD = { name: "jobTitle", label: "Job title", type: "text", required: true };

export const PREVIEW_LEAD_SINK_PATH = "/internal/preview-lead-sink";

/** @param {{requiresJobField?: boolean}} [opts] */
export function leadFormFields({ requiresJobField = false } = {}) {
  return requiresJobField ? [...BASE_FIELDS, JOB_TITLE_FIELD] : BASE_FIELDS;
}

/**
 * Prompt text for the coding agent building the hero's lead-capture form —
 * threaded into generate-sections.mjs's HERO_CONTRACT for the hero section
 * only (the one section that's always ai-required).
 *
 * @param {object} p
 * @param {boolean} [p.requiresJobField]
 * @param {string} p.previewLeadSinkUrl - absolute URL (config.servicePublicBaseUrl + PREVIEW_LEAD_SINK_PATH)
 */
export function buildLeadFormPromptFragment({ requiresJobField = false, previewLeadSinkUrl }) {
  const fields = leadFormFields({ requiresJobField });
  const fieldList = fields.map((f) => `  - \`${f.name}\` (${f.label}, type="${f.type}", required)`).join("\n");

  return `LEAD FORM CONTRACT — the form inside data-hero-form must implement this exactly:
Fields, in this order:
${fieldList}

Honeypot (bot defense): include one EXTRA hidden text input named \`${HONEYPOT_FIELD_NAME}\`, styled so it's invisible to real visitors (e.g. \`position: absolute; left: -9999px\` or a visually-hidden utility class — never \`display: none\`/\`type="hidden"\`, which some bots skip) and never focusable (\`tabIndex={-1}\`, \`autoComplete="off"\`). Do not label it or mention it to the user. On submit, if this field is non-empty, still show the normal success state to the visitor (never reveal detection) but do not include it as meaningful data.

Client-side validation before submit (basic format checks only, not a replacement for server-side validation): \`email\` must match a standard email shape; \`phone\` must contain at least 7 digits. Show inline errors, don't submit until valid.

Submission target: on valid submit, POST a JSON body of the fields above (plus \`${HONEYPOT_FIELD_NAME}\`) to exactly this URL: \`${previewLeadSinkUrl}\` — this is a preview-mode endpoint that safely no-ops (a real campaign's production form target is wired up separately, outside this generated page). Use a plain \`fetch\` call; on success show a clear thank-you state in place of the form, on failure show an inline error without losing the visitor's entered values.`;
}
