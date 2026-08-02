import { test } from "node:test";
import assert from "node:assert/strict";
import {
  leadFormFields,
  buildLeadFormPromptFragment,
  HONEYPOT_FIELD_NAME,
  BASE_FIELDS,
  JOB_TITLE_FIELD,
  PREVIEW_LEAD_SINK_PATH,
} from "../src/leadform/contract.mjs";

test("leadFormFields returns just the base fields by default", () => {
  const fields = leadFormFields();
  assert.deepEqual(fields, BASE_FIELDS);
  assert.equal(fields.some((f) => f.name === "jobTitle"), false);
});

test("leadFormFields adds jobTitle only when requiresJobField is true", () => {
  const fields = leadFormFields({ requiresJobField: true });
  assert.deepEqual(fields, [...BASE_FIELDS, JOB_TITLE_FIELD]);
});

test("every base field is required and has a name/label/type", () => {
  for (const field of BASE_FIELDS) {
    assert.ok(field.name && field.label && field.type);
    assert.equal(field.required, true);
  }
});

test("buildLeadFormPromptFragment lists every field by name, the honeypot, and the sink URL", () => {
  const url = "http://localhost:4300" + PREVIEW_LEAD_SINK_PATH;
  const fragment = buildLeadFormPromptFragment({ requiresJobField: false, previewLeadSinkUrl: url });
  assert.match(fragment, /`name`/);
  assert.match(fragment, /`phone`/);
  assert.match(fragment, /`email`/);
  assert.doesNotMatch(fragment, /`jobTitle`/);
  assert.match(fragment, new RegExp(HONEYPOT_FIELD_NAME));
  assert.match(fragment, /never reveal detection/i);
  assert.match(fragment, new RegExp(url.replaceAll("/", "\\/")));
});

test("buildLeadFormPromptFragment includes jobTitle when requiresJobField is true", () => {
  const fragment = buildLeadFormPromptFragment({ requiresJobField: true, previewLeadSinkUrl: "http://x/y" });
  assert.match(fragment, /`jobTitle`/);
});

test("buildLeadFormPromptFragment tells the agent not to use display:none/type=hidden for the honeypot (some bots skip those)", () => {
  const fragment = buildLeadFormPromptFragment({ previewLeadSinkUrl: "http://x/y" });
  assert.match(fragment, /display: none/);
  assert.match(fragment, /type="hidden"/);
  assert.match(fragment, /some bots skip/);
});
