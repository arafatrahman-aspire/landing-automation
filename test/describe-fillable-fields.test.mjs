import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { describeFillableFields, initialFieldValues, humanizeKey } from "../src/sections/describe-fillable-fields.mjs";
import { frameCatalog } from "../src/design-catalog/static-frame-catalog.mjs";
import { populateFrame } from "../src/sections/fill-static-frame.mjs";

/* The contract these tests defend: a form built from describeFillableFields()
 * submits data that populateFrame() accepts. Both read the same
 * `fillableFields` Zod schema, so they cannot drift — and that is exactly what
 * makes editing a static section's copy possible with no LLM call. */

test("recognises the three shapes the real catalog uses", () => {
  const schema = z
    .object({
      heading: z.string().min(1),
      steps: z.array(z.string().min(1)).min(1),
      items: z.array(z.object({ label: z.string(), description: z.string() })).min(1),
    })
    .partial();

  assert.deepEqual(describeFillableFields(schema), [
    { key: "heading", label: "Heading", kind: "text" },
    { key: "steps", label: "Steps", kind: "text-list" },
    {
      key: "items",
      label: "Items",
      kind: "group-list",
      fields: [
        { key: "label", label: "Label" },
        { key: "description", label: "Description" },
      ],
    },
  ]);
});

test("an unfamiliar shape is reported as unsupported, never guessed at", () => {
  // Rendering a text box for a number would produce data the schema rejects on
  // save. Degrading to "not editable here" is the honest answer.
  const schema = z.object({ count: z.number(), when: z.date() }).partial();
  assert.deepEqual(
    describeFillableFields(schema).map((f) => f.kind),
    ["unsupported", "unsupported"]
  );
});

test("a bare-render / missing schema yields no fields at all", () => {
  assert.deepEqual(describeFillableFields(undefined), []);
});

test("keys become readable labels", () => {
  assert.equal(humanizeKey("buttonText"), "Button text");
  assert.equal(humanizeKey("downloadButtonText"), "Download button text");
  assert.equal(humanizeKey("bg_color"), "Bg color");
  assert.equal(humanizeKey("heading"), "Heading");
});

test("every real catalog candidate produces a usable form", () => {
  // A guard against a future catalog entry using a shape the editor can't
  // render: it would silently become an uneditable section.
  for (const [type, candidates] of Object.entries(frameCatalog)) {
    for (const candidate of candidates) {
      const fields = describeFillableFields(candidate.fillableFields);
      if (!candidate.fillableFields) {
        assert.equal(fields.length, 0, `${type}/${candidate.id}: bare-render candidate should have no fields`);
        continue;
      }
      assert.ok(fields.length > 0, `${type}/${candidate.id}: has fillableFields but produced no form fields`);
      const unsupported = fields.filter((f) => f.kind === "unsupported").map((f) => f.key);
      assert.deepEqual(unsupported, [], `${type}/${candidate.id}: unrenderable field(s) ${unsupported.join(", ")}`);
    }
  }
});

test("initial values start from the frame's real defaults", () => {
  const candidate = frameCatalog.faq[0];
  const values = initialFieldValues(candidate);
  assert.deepEqual(Object.keys(values).sort(), ["heading", "items"]);
  assert.equal(values.heading, candidate.defaultData.heading);
});

test("an existing edit wins over the default, per key", () => {
  const candidate = frameCatalog.faq[0];
  const values = initialFieldValues(candidate, { heading: "Questions about the bootcamp" });
  assert.equal(values.heading, "Questions about the bootcamp");
  // Untouched keys still come from the frame's own defaults rather than
  // vanishing — these components take `data` as all-or-nothing.
  assert.deepEqual(values.items, candidate.defaultData.items);
});

test("keys the form can't render are excluded from its starting values", () => {
  // Otherwise a round trip through the UI would resubmit a field it never
  // showed, or drop one it did.
  const candidate = { fillableFields: z.object({ heading: z.string(), count: z.number() }).partial(), defaultData: { heading: "H", count: 3 } };
  assert.deepEqual(initialFieldValues(candidate), { heading: "H" });
});

test("what the form produces is what populateFrame accepts", () => {
  // The whole point: no LLM, and no way to submit something invalid.
  const candidate = frameCatalog.details[0];
  const edited = {
    ...initialFieldValues(candidate),
    heading: "Why your Splunk deployment is costing you more than it should",
  };

  const { fileContent, dataUsed } = populateFrame({ candidate, overrides: edited, componentName: "DetailsSection1" });
  assert.equal(dataUsed.heading, edited.heading);
  assert.match(fileContent, /Why your Splunk deployment is costing you more than it should/);
  // Fields the edit didn't touch survive from the frame's own defaults.
  assert.deepEqual(dataUsed.items, candidate.defaultData.items);
});
