/* Static section population (new_plan.md §9.4 — Hybrid Section Assembly).
 *
 * Pure templating for "static" sections. No LLM call, no coding-agent tool
 * loop — validate whatever campaign copy the guide produced against a
 * frame candidate's fillableFields schema, merge it over the candidate's
 * full real defaultData, and emit a small wrapper component that imports
 * the frame verbatim and renders it with the merged literal.
 *
 * Candidates with no fillableFields/defaultData (see design-catalog/static-frame-catalog.mjs
 * — photo-dependent frames like testimonials/instructor) always render bare,
 * with no `data` prop at all, letting the frame's own real default apply. */

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

function defaultMerge(defaultData, overrides) {
  return { ...defaultData, ...overrides };
}

/**
 * @param {object} p
 * @param {import("../design-catalog/static-frame-catalog.mjs").frameCatalog[string][number]} p.candidate
 * @param {object} [p.overrides] - guide-produced content for this slot's fillable fields
 * @param {string} p.componentName - PascalCase name for the generated wrapper component
 * @returns {{ fileContent: string, dataUsed: unknown }}
 */
export function populateFrame({ candidate, overrides = {}, componentName }) {
  if (!candidate) throw new Error("populateFrame: candidate is required");
  if (typeof componentName !== "string" || !PASCAL_CASE.test(componentName)) {
    throw new Error(`populateFrame: componentName must be PascalCase, got ${JSON.stringify(componentName)}`);
  }

  let dataUsed = null;
  if (candidate.fillableFields && candidate.defaultData !== undefined) {
    const parsed = candidate.fillableFields.parse(overrides ?? {});
    const merge = candidate.mergeStrategy ?? defaultMerge;
    dataUsed = merge(candidate.defaultData, parsed);
  }

  const fileContent =
    dataUsed !== null
      ? `import ${candidate.component} from "${candidate.importPath}";

const data = ${JSON.stringify(dataUsed, null, 2)};

export default function ${componentName}() {
  return <${candidate.component} data={data} />;
}
`
      : `import ${candidate.component} from "${candidate.importPath}";

export default function ${componentName}() {
  return <${candidate.component} />;
}
`;

  return { fileContent, dataUsed };
}
