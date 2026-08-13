import { test } from "node:test";
import assert from "node:assert/strict";
import { frameCatalog, listFrameCandidates, getFrameCandidate } from "../src/design-catalog/static-frame-catalog.mjs";
import { SECTION_TYPES } from "../src/design-catalog/section-types.mjs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("frame catalog has no entry for hero (always ai-required, never static)", () => {
  assert.equal("hero" in frameCatalog, false);
});

test("every catalog key is a recognized section type", () => {
  for (const key of Object.keys(frameCatalog)) {
    assert.ok(SECTION_TYPES.includes(key), `"${key}" is not a recognized section type`);
  }
});

test("every candidate's defaultData satisfies its own fillableFields schema", () => {
  for (const [sectionType, candidates] of Object.entries(frameCatalog)) {
    for (const candidate of candidates) {
      if (!candidate.fillableFields) continue;
      const target = candidate.mergeStrategy ? candidate.defaultData[0] : candidate.defaultData;
      const result = candidate.fillableFields.safeParse(target);
      assert.equal(result.success, true, `${sectionType}/${candidate.id}: ${result.success ? "" : result.error.message}`);
    }
  }
});

test("candidates without fillableFields also have no defaultData (bare-render only)", () => {
  for (const candidates of Object.values(frameCatalog)) {
    for (const candidate of candidates) {
      if (!candidate.fillableFields) {
        assert.equal(candidate.defaultData, undefined);
      }
    }
  }
});

test("listFrameCandidates returns [] for a type with no static candidates", () => {
  assert.deepEqual(listFrameCandidates("hero"), []);
});

test("getFrameCandidate finds a real candidate by id and returns null for an unknown one", () => {
  const [expected] = listFrameCandidates("faq");
  assert.equal(getFrameCandidate("faq", expected.id), expected);
  assert.equal(getFrameCandidate("faq", "not-a-real-id"), null);
  assert.equal(getFrameCandidate("hero", "not-a-real-id"), null);
});

/* ---------------- defaultData completeness, against the REAL frames ---------------- */

/* The invariant this guards, from the catalog's own file header: `defaultData`
 * must be a FULL copy of the frame's default data object, never a partial one,
 * because these components take `data` as an all-or-nothing prop with no
 * internal deep-merge.
 *
 * Two entries violated it and shipped: `trainer-profiles` omitted the required
 * `profiles`, and `pricing-packages-grid` omitted `packages`/`consultationUrl`.
 * Both broke the build of any campaign whose plan included that section —
 *   Property 'profiles' is missing in type '{ heading: string; }'
 * — and neither was caught, because the frames live in the TARGET repo and
 * nothing here had ever read them.
 *
 * So this reads them. It needs the shared base clone, which only exists once
 * the service has cloned the target repo at least once; without it the check
 * skips rather than passing vacuously. */
const BASE_FRAMES_DIR = path.resolve("data/.scratch/_base/src/components/frames/landing/analyze");

/** Required (non-`?`) keys of the `*Data` interface a frame's `data` prop takes. */
function requiredDataKeys(source) {
  const match = /interface\s+\w*Data\s*\{([\s\S]*?)\n\}/.exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/^\s*(\w+)(\??):/gm)].filter((m) => m[2] !== "?").map((m) => m[1]);
}

test("every candidate's defaultData covers every required prop of its real frame", async (t) => {
  if (!existsSync(BASE_FRAMES_DIR)) {
    t.skip(`no base clone at ${BASE_FRAMES_DIR} — run the service once so the target repo is available`);
    return;
  }

  const problems = [];
  for (const [sectionType, candidates] of Object.entries(frameCatalog)) {
    for (const candidate of candidates) {
      // Bare-render candidates pass no `data` at all, so the frame's own
      // defaults apply and there is nothing to be incomplete.
      if (!candidate.defaultData) continue;

      const file = path.join(BASE_FRAMES_DIR, `${candidate.importPath.split("/").pop()}.tsx`);
      if (!existsSync(file)) {
        problems.push(`${sectionType}/${candidate.id}: frame file not found at ${file}`);
        continue;
      }

      const required = requiredDataKeys(await readFile(file, "utf8"));
      if (required === null) continue; // frame takes no *Data interface — nothing to check

      const missing = required.filter((key) => !(key in candidate.defaultData));
      if (missing.length > 0) {
        problems.push(
          `${sectionType}/${candidate.id}: defaultData is missing required prop(s) ${missing.join(", ")} — ` +
            `this fails the build with "Property '${missing[0]}' is missing". Either complete defaultData, or drop ` +
            `defaultData/fillableFields entirely so the frame renders bare with its own defaults.`
        );
      }
    }
  }

  assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});
