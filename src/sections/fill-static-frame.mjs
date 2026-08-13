import { LEAD_FORM_HREF, LEAD_FORM_ANCHOR_ID } from "../leadform/contract.mjs";

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

/* Every generated wrapper is a Client Component, unconditionally.
 *
 * A real run failed the build on this: the wrapper for `SyllabusAccordionFrame`
 * rendered a frame that calls `useState` but carries no `"use client"` of its
 * own, so with the wrapper and the composed page both Server Components there
 * was no client boundary anywhere in the chain:
 *
 *   You're importing a component that needs useState. It only works in a
 *   Client Component but none of its parents are marked with "use client".
 *
 * Detecting this properly means resolving what each frame transitively imports
 * — `FaqAccordionFrame` doesn't call a hook itself, it imports `Accordion`,
 * which does — so a one-level scan would have missed half the cases. The
 * asymmetry settles it: marking a section client-side that didn't need it costs
 * a slightly larger client bundle, while missing one costs a failed build and a
 * wasted retry cycle. These wrappers are always the same shape — a synchronous
 * component rendering a frame with inline literal data, never async and never
 * server-only — so there is nothing here that `"use client"` can break. */
const USE_CLIENT = '"use client";\n\n';

function defaultMerge(defaultData, overrides) {
  return { ...defaultData, ...overrides };
}

/** RiskListWithImageFrame's button is a dead `<Button>` with no href/onClick.
 *  Emitting the stock frame would leave "GET INSTANT ACCESS" unclickable.
 *  Re-implement the layout here with the same data shape, linking the CTA to
 *  the hero lead form (`#regForm` — LEAD_FORM_HREF). */
function buildRiskListWithWorkingCta(componentName, dataUsed) {
  return `${USE_CLIENT}import Image from "next/image";
import DummyImage from "@assets/images/frames/landing/frame-3-image-1.png";

const data = ${JSON.stringify(dataUsed, null, 2)};

export default function ${componentName}() {
  return (
    <section className="flex flex-col md:flex-row items-center justify-between gap-8 px-6 md:px-16 lg:px-32 py-16 md:py-20">
      <Image src={DummyImage} alt="" className="max-w-full h-auto" />
      <div className="flex flex-col gap-8 max-w-xl">
        <h3 className="text-2xl md:text-3xl font-bold">{data.heading}</h3>
        <ul className="text-lg md:text-xl flex flex-col gap-4">
          {data.items.map((item, index) => (
            <li key={index}>
              <span className="font-bold">{item.label}</span>
              {item.description}
            </li>
          ))}
        </ul>
        <a
          href="${LEAD_FORM_HREF}"
          className="inline-flex w-fit items-center justify-center rounded-md bg-[#004aad] px-8 py-4 text-xl font-semibold text-white hover:opacity-90"
        >
          {data.buttonText}
        </a>
      </div>
    </section>
  );
}
`;
}

/** ProcessExplainerFrame requires `image: StaticImageData` on every item.
 *  JSON defaultData cannot carry a Next image import, so the stock wrapper
 *  (`data={JSON}`) always type-fails. Attach a stock side image at emit time;
 *  fillable copy (title/description/steps) stays campaign-specific. */
function buildProcessExplainerWithImage(componentName, importPath, dataUsed) {
  const item = Array.isArray(dataUsed) ? dataUsed[0] : dataUsed;
  if (!item || typeof item !== "object") {
    throw new Error("buildProcessExplainerWithImage: expected array/object data");
  }
  const copy = {
    title: item.title,
    description: item.description,
    processSteps: item.processSteps,
  };
  return `${USE_CLIENT}import ProcessExplainerFrame from "${importPath}";
import SideImage from "@assets/images/frames/landing/frame-4-image-1.png";

const copy = ${JSON.stringify(copy, null, 2)};

export default function ${componentName}() {
  return <ProcessExplainerFrame data={[{ ...copy, image: SideImage }]} />;
}
`;
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

  // Frames whose built-in CTA is a dead button (no href) get a custom emit
  // that links to the hero lead form. CtaSectionFrame already uses
  // href="#regForm" — once the hero sets id="regForm", that path works.
  if (candidate.id === "risk-list-with-image" && dataUsed) {
    return { fileContent: buildRiskListWithWorkingCta(componentName, dataUsed), dataUsed };
  }

  // Timeline frame requires a StaticImageData `image` field TypeScript cannot
  // accept from a JSON literal — wire a stock asset in at emit time.
  if (candidate.id === "process-explainer" && dataUsed) {
    return {
      fileContent: buildProcessExplainerWithImage(componentName, candidate.importPath, dataUsed),
      dataUsed,
    };
  }

  const fileContent =
    dataUsed !== null
      ? `${USE_CLIENT}import ${candidate.component} from "${candidate.importPath}";

const data = ${JSON.stringify(dataUsed, null, 2)};

export default function ${componentName}() {
  return <${candidate.component} data={data} />;
}
`
      : `${USE_CLIENT}import ${candidate.component} from "${candidate.importPath}";

export default function ${componentName}() {
  return <${candidate.component} />;
}
`;

  return { fileContent, dataUsed };
}

export { LEAD_FORM_ANCHOR_ID, LEAD_FORM_HREF };
