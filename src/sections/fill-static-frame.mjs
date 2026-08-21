import { LEAD_FORM_HREF, LEAD_FORM_ANCHOR_ID } from "../leadform/contract.mjs";
import { imageForSlot } from "../assets/campaign-images.mjs";
import { resolveColorScheme } from "../theme/campaign-colors.mjs";

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

function jsxString(value) {
  return JSON.stringify(value ?? "");
}

/**
 * Emit a Next.js <Image> that fills a sized container div.
 * Using `fill` + `object-cover` instead of explicit width/height prevents
 * the raw Pexels intrinsic dimensions (e.g. 4912x3264) from blowing out
 * the layout when the image is placed inside a flex/grid column.
 *
 * @param {object}  image          - campaign image record (publicUrl, alt, …)
 * @param {string}  containerClass - Tailwind classes for the wrapper div
 */
function remoteImageJsx(
  image,
  containerClass = "relative w-full md:w-1/2 aspect-[4/3] rounded-xl overflow-hidden flex-shrink-0"
) {
  return (
    `<div className="${containerClass}">` +
    `<Image src=${jsxString(image.publicUrl)} alt=${jsxString(image.alt || "illustration")} fill className="object-cover" />` +
    `</div>`
  );
}

/** RiskListWithImageFrame's button is a dead `<Button>` with no href/onClick.
 *  Emitting the stock frame would leave "GET INSTANT ACCESS" unclickable.
 *  Re-implement the layout here with the same data shape, linking the CTA to
 *  the hero lead form (`#regForm` — LEAD_FORM_HREF). */
function buildRiskListWithWorkingCta(componentName, dataUsed, { image, palette }) {
  const imageImport = image
    ? `import Image from "next/image";\n`
    : `import Image from "next/image";\nimport DummyImage from "@assets/images/frames/landing/frame-3-image-1.png";\n`;
  // Dummy image uses a fixed-size wrapper so it also doesn't overflow.
  // alt must be non-empty — the SEO check flags `alt=""` as missing alt text
  // even though it's a legitimate "decorative" marker in plain HTML/a11y terms.
  const dummyEl =
    `<div className="relative w-full md:w-1/2 aspect-[4/3] rounded-xl overflow-hidden flex-shrink-0">` +
    `<Image src={DummyImage} alt=${jsxString(dataUsed?.heading || "illustration")} fill className="object-cover" />` +
    `</div>`;
  const imageEl = image ? remoteImageJsx(image) : dummyEl;
  return `${USE_CLIENT}${imageImport}
const data = ${JSON.stringify(dataUsed, null, 2)};

export default function ${componentName}() {
  return (
    <section className="flex flex-col md:flex-row items-center justify-between gap-8 px-6 md:px-16 lg:px-32 py-16 md:py-20">
      ${imageEl}
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
          className="inline-flex w-fit items-center justify-center rounded-md bg-[${palette.secondary}] px-8 py-4 text-xl font-semibold text-white hover:opacity-90"
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
 *  (`data={JSON}`) always type-fails. A remote campaign URL also cannot be
 *  typed as StaticImageData — inline the layout when we have one. Otherwise
 *  attach a stock side image at emit time; fillable copy stays campaign-specific. */
function buildProcessExplainerWithImage(componentName, importPath, dataUsed, { image }) {
  const item = Array.isArray(dataUsed) ? dataUsed[0] : dataUsed;
  if (!item || typeof item !== "object") {
    throw new Error("buildProcessExplainerWithImage: expected array/object data");
  }
  const copy = {
    title: item.title,
    description: item.description,
    processSteps: item.processSteps,
  };

  if (image) {
    return `${USE_CLIENT}import Image from "next/image";

const copy = ${JSON.stringify(copy, null, 2)};

export default function ${componentName}() {
  return (
    <section className="flex flex-col md:flex-row items-center justify-between gap-8 px-6 md:px-16 lg:px-32 py-16 md:py-20">
      ${remoteImageJsx(image, "relative w-full md:w-5/12 aspect-[4/3] rounded-xl overflow-hidden flex-shrink-0")}
      <div className="flex flex-col gap-6 max-w-xl">
        <h3 className="text-2xl md:text-3xl font-bold">{copy.title}</h3>
        <p className="text-lg md:text-xl">{copy.description}</p>
        <ol className="text-lg md:text-xl flex flex-col gap-3 list-decimal list-inside">
          {copy.processSteps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      </div>
    </section>
  );
}
`;
  }

  return `${USE_CLIENT}import ProcessExplainerFrame from "${importPath}";
import SideImage from "@assets/images/frames/landing/frame-4-image-1.png";

const copy = ${JSON.stringify(copy, null, 2)};

export default function ${componentName}() {
  return <ProcessExplainerFrame data={[{ ...copy, image: SideImage }]} />;
}
`;
}

/** Custom palettes cannot recolor shared analyze/ frames. Inline the FAQ
 *  accordion so hex comes from the campaign scheme. */
/** Redesigned FAQ layout: a responsive 2-column card grid (1 column on
 * mobile) instead of a single stacked list, using native <details>/<summary>
 * for the accordion — free keyboard/ARIA semantics from the browser, no
 * useState needed. An inline SVG chevron marks open/closed state instead of
 * a literal glyph: axe's color-contrast rule checks TEXT nodes, and the
 * accent color is borderline against white at small text sizes (~3.8:1,
 * under the 4.5:1 normal-text minimum) — a vector path sidesteps that rule
 * entirely rather than needing a large/bold carve-out.
 *
 * Colors are set directly on each element (heading, summary, body text),
 * never left to inherit from a wrapper: this repo's globals.css fixes
 * `h1`-`h6` to a dark navy in @layer base, which always wins over an
 * inherited color regardless of Tailwind's layer order — see
 * buildCtaSectionInlined below for the real run that failed on exactly this. */
function buildFaqAccordionInlined(componentName, dataUsed, { palette }) {
  return `${USE_CLIENT}const data = ${JSON.stringify(dataUsed, null, 2)};

export default function ${componentName}() {
  return (
    <section className="px-6 md:px-16 lg:px-32 py-16 md:py-20">
      <h3 className="text-2xl md:text-3xl font-bold mb-10 text-center" style={{ color: "${palette.primary}" }}>
        {data.heading}
      </h3>
      <div className="grid gap-4 max-w-5xl mx-auto md:grid-cols-2">
        {data.items.map((item, index) => (
          <details
            key={index}
            className="group rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm open:shadow-md transition-shadow duration-200"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-gray-900">
              {item.title}
              <svg
                className="h-5 w-5 shrink-0 transition-transform duration-200 group-open:rotate-180"
                style={{ color: "${palette.accent}" }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <p className="mt-3 text-base text-gray-600">{item.content}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
`;
}

/** Reimplements CtaSectionFrame instead of importing it verbatim: its own
 * baked colors (white text on the accent button, text-green-400 on a dark
 * background) fail WCAG AA contrast, and custom palettes can't recolor it
 * anyway. text-xl font-bold on the button is deliberate, not decorative — at
 * 20px/700-weight it clears WCAG's "large text" 3:1 threshold with the
 * default Aspire accent (#ea4b0c on white is ~3.8:1, under the 4.5:1 normal-
 * text minimum but over 3:1 for large/bold text).
 *
 * text-white is repeated directly on the <h3>, not left to inherit from the
 * section: the target repo's own globals.css sets `h3 { color: ... }` in
 * @layer base, and a directly-targeted rule always wins over an inherited
 * one regardless of Tailwind's layer order — `text-white` on an ancestor
 * does nothing for a heading tag. A real run rendered this h3 in the site's
 * fixed dark navy on this same dark-blue background, failing contrast. */
function buildCtaSectionInlined(componentName, dataUsed, { palette }) {
  return `${USE_CLIENT}const data = ${JSON.stringify(dataUsed, null, 2)};

export default function ${componentName}() {
  return (
    <section className="px-6 md:px-16 lg:px-32 py-16 md:py-20 text-center text-white bg-[${palette.primary}]">
      <h3 className="text-2xl md:text-3xl font-bold text-white">{data.headings}</h3>
      <p className="mt-4 text-lg md:text-xl max-w-3xl mx-auto">{data.contents}</p>
      <a
        href="${LEAD_FORM_HREF}"
        className="inline-flex mt-8 items-center justify-center rounded-md bg-[${palette.accent}] px-8 py-4 text-xl font-bold text-white hover:opacity-90"
      >
        {data.btnName}
      </a>
      <p className="mt-3 text-sm md:text-base opacity-90">{data.btnDis}</p>
    </section>
  );
}
`;
}

/**
 * @param {object} p
 * @param {import("../design-catalog/static-frame-catalog.mjs").frameCatalog[string][number]} p.candidate
 * @param {object} [p.overrides] - guide-produced content for this slot's fillable fields
 * @param {string} p.componentName - PascalCase name for the generated wrapper component
 * @param {Array} [p.images] - researchNotes.images public URLs
 * @param {object} [p.colorScheme] - brief.colorScheme (omitted = Aspire)
 * @returns {{ fileContent: string, dataUsed: unknown }}
 */
export function populateFrame({ candidate, overrides = {}, componentName, images = [], colorScheme }) {
  if (!candidate) throw new Error("populateFrame: candidate is required");
  if (typeof componentName !== "string" || !PASCAL_CASE.test(componentName)) {
    throw new Error(`populateFrame: componentName must be PascalCase, got ${JSON.stringify(componentName)}`);
  }

  const palette = resolveColorScheme(colorScheme);

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
    return {
      fileContent: buildRiskListWithWorkingCta(componentName, dataUsed, {
        image: imageForSlot(images, "details"),
        palette,
      }),
      dataUsed,
    };
  }

  // Timeline frame requires a StaticImageData `image` field TypeScript cannot
  // accept from a JSON literal — wire a stock asset (or a remote URL via an
  // inlined layout) in at emit time.
  if (candidate.id === "process-explainer" && dataUsed) {
    return {
      fileContent: buildProcessExplainerWithImage(componentName, candidate.importPath, dataUsed, {
        image: imageForSlot(images, "timeline"),
      }),
      dataUsed,
    };
  }

  // Always inlined (not just for custom themes) — a redesigned 2-column card
  // grid, requested to replace the raw FaqAccordionFrame's plain stacked
  // white/checkmark rows. Also sidesteps a real defect in the raw frame's
  // free-text per-item `bg_color` field: static content authoring picked
  // "--campaign-primary" (a bare custom-property NAME, not a valid
  // background value) for it in a real run, which is silently a no-op —
  // this design has no per-item bg_color at all.
  if (candidate.id === "faq-accordion" && dataUsed) {
    return { fileContent: buildFaqAccordionInlined(componentName, dataUsed, { palette }), dataUsed };
  }

  // Always inlined (not just for custom themes): the raw CtaSectionFrame's
  // baked colors (white text on its orange button, text-green-400 on its
  // dark-blue background) are a real WCAG AA contrast failure — a real run's
  // a11y-lint failed on exactly this, every attempt, because it's baked into
  // the frame's own markup, not anything a coding agent retry could reach.
  if (candidate.id === "cta-section" && dataUsed) {
    return { fileContent: buildCtaSectionInlined(componentName, dataUsed, { palette }), dataUsed };
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
