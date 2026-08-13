/* Turns a frame candidate's `fillableFields` Zod schema
 * (design-catalog/static-frame-catalog.mjs) into a plain descriptor list a form
 * can be rendered from.
 *
 * Why this is worth having: a "static" section's content is not code — it is a
 * plain object that fill-static-frame.mjs merges over the frame's own
 * defaultData and renders. So changing a word on one of those sections needs
 * no LLM at all. Before this, the only way to fix a typo was to ask an AI to
 * rewrite the whole section: minutes of waiting, a fresh chance to break the
 * build, and a bill, to correct one character.
 *
 * The schema is already the source of truth for what may be overridden —
 * `populateFrame` parses against it — so deriving the form from the same
 * schema means the two cannot drift, and a form that submits successfully is
 * one `populateFrame` will accept.
 *
 * Deliberately narrow. It understands exactly the three shapes the catalog
 * actually uses:
 *   - string                     -> a text field
 *   - array of string            -> a repeatable list of text fields
 *   - array of object-of-strings -> a repeatable group of named text fields
 * Anything else is reported as unsupported rather than guessed at, so an
 * unfamiliar shape degrades to "not editable here" instead of rendering a
 * control that would submit something the schema rejects. */

/** Unwraps `.partial()`'s ZodOptional (and any nesting of it) to the real type. */
function unwrap(schema) {
  let current = schema;
  // `.optional()`, `.nullable()` and `.default()` all wrap an inner type. The
  // loop rather than a single unwrap because a field may carry more than one.
  while (current?._def?.innerType) current = current._def.innerType;
  return current;
}

function typeOf(schema) {
  return unwrap(schema)?._def?.type ?? null;
}

/** A human label from a schema key: `buttonText` -> "Button text".
 *
 *  Sentence case, not Title Case — these are form field labels, and "Download
 *  Button Text" reads like a heading rather than a thing you fill in. Words
 *  that are entirely uppercase in the key are left alone so an acronym
 *  ("seoTitle" is fine, but a future "SEOTitle") doesn't get flattened. */
export function humanizeKey(key) {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()));

  if (words.length === 0) return "";
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(" ");
}

function objectShape(schema) {
  const unwrapped = unwrap(schema);
  return unwrapped?.shape ?? unwrapped?._def?.shape ?? null;
}

/**
 * @param {import("zod").ZodTypeAny | undefined} fillableFields
 * @returns {Array<
 *   | {key: string, label: string, kind: "text"}
 *   | {key: string, label: string, kind: "text-list"}
 *   | {key: string, label: string, kind: "group-list", fields: Array<{key: string, label: string}>}
 *   | {key: string, label: string, kind: "unsupported"}
 * >} empty when the candidate has no fillable fields at all (a bare-render frame)
 */
export function describeFillableFields(fillableFields) {
  const shape = objectShape(fillableFields);
  if (!shape) return [];

  const fields = [];
  for (const [key, schema] of Object.entries(shape)) {
    const label = humanizeKey(key);
    const kind = typeOf(schema);

    if (kind === "string") {
      fields.push({ key, label, kind: "text" });
      continue;
    }

    if (kind === "array") {
      const element = unwrap(schema)._def.element;
      const elementKind = typeOf(element);

      if (elementKind === "string") {
        fields.push({ key, label, kind: "text-list" });
        continue;
      }

      if (elementKind === "object") {
        const elementShape = objectShape(element) ?? {};
        // Only string members are editable. A non-string member (e.g. the
        // optional `bg_color` on some catalog items is a string, but a future
        // numeric or boolean one would not be) is left out of the form rather
        // than rendered as a text box that would fail validation on save.
        const members = Object.entries(elementShape)
          .filter(([, member]) => typeOf(member) === "string")
          .map(([memberKey]) => ({ key: memberKey, label: humanizeKey(memberKey) }));

        if (members.length > 0) {
          fields.push({ key, label, kind: "group-list", fields: members });
          continue;
        }
      }
    }

    fields.push({ key, label, kind: "unsupported" });
  }

  return fields;
}

/**
 * The values a form should start from: the frame's real defaults, overlaid
 * with whatever this campaign already set.
 *
 * Only keys the form can actually render are returned, so a round trip through
 * the UI can never silently drop a field it didn't know how to show.
 *
 * @param {object} candidate - a frameCatalog entry
 * @param {object} [current] - the data currently rendered for this section
 */
export function initialFieldValues(candidate, current = null) {
  const source = { ...(candidate?.defaultData ?? {}), ...(current ?? {}) };
  const values = {};
  for (const field of describeFillableFields(candidate?.fillableFields)) {
    if (field.kind === "unsupported") continue;
    if (field.key in source) values[field.key] = source[field.key];
  }
  return values;
}
