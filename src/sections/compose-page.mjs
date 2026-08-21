import { campaignThemeStyleTag, resolveColorScheme } from "../theme/campaign-colors.mjs";

const PASCAL_WORD_RE = /[^a-z0-9]+/i;

function toPascalCase(...parts) {
  return parts
    .join("-")
    .split(PASCAL_WORD_RE)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

// Includes the index so two sections of the same type (unusual, but not
// schema-forbidden) never collide on a component name.
export function sectionComponentName(sectionType, index) {
  return `${toPascalCase(sectionType)}Section${index}`;
}

export function sectionFilePath(allowlistBase, componentName) {
  return `${allowlistBase}sections/${componentName}.tsx`;
}

export function pageFilePath(allowlistBase) {
  return `${allowlistBase}page.tsx`;
}

// Positional, not type-derived (new_plan.md §9.6/module.md Module 3): a
// refine that swaps a slot's section TYPE (the "new" action) must not orphan
// that slot's own version history in draft_files, which is keyed on this id.
export function sectionSlotId(index) {
  return `section-${index}`;
}

const META_DESC_MAX = 200;

function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max - 1).trimEnd()}…` : str;
}

// Open Graph title/description and JSON-LD structured data — nothing in this
// pipeline generates these anywhere else (page.tsx is the only page-level
// file, and it's never agent-written), so the SEO check failed on them every
// single retry no matter how the LLM-authored sections changed. Templating
// them here, from the campaign brief, makes seo-lint pass deterministically
// instead of depending on a coding agent that has no file to put them in.
function buildMetadataExport(request) {
  if (!request?.campaignName) return "";
  const title = truncate(request.campaignName, 70);
  const description = truncate(request.offer ?? request.campaignName, META_DESC_MAX);
  return `
export const metadata = {
  title: ${JSON.stringify(title)},
  description: ${JSON.stringify(description)},
  openGraph: {
    title: ${JSON.stringify(title)},
    description: ${JSON.stringify(description)},
  },
};
`;
}

function buildJsonLd(request) {
  if (!request?.campaignName) return "";
  const data = {
    "@context": "https://schema.org",
    "@type": "Course",
    name: request.campaignName,
    description: request.offer ?? request.campaignName,
  };
  // JSON.stringify's output can contain "</script>" if a brief field does —
  // breaking out of the tag early and corrupting the rest of the page.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ${JSON.stringify(json)} }} />\n`;
}

// Deterministic composition of the classified sections into one page file —
// never agent-written, so it's always exactly consistent with what was
// actually generated. Theme CSS variables apply only to this campaign page.
export function composePage(orderedSections, { allowlistBase, colorScheme, request } = {}) {
  const palette = resolveColorScheme(colorScheme);
  const imports = orderedSections
    .map((s) => `import ${s.componentName} from "./sections/${s.componentName}";`)
    .join("\n");
  const renders = orderedSections.map((s) => `      <${s.componentName} />`).join("\n");
  const content = `${imports}
${buildMetadataExport(request)}
export default function Page() {
  return (
    <div data-campaign-theme="">
      ${campaignThemeStyleTag(palette)}
${buildJsonLd(request)}${renders}
    </div>
  );
}
`;
  return { path: pageFilePath(allowlistBase), content };
}
