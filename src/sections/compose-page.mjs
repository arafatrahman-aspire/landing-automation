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

// Deterministic composition of the classified sections into one page file —
// never agent-written, so it's always exactly consistent with what was
// actually generated.
export function composePage(orderedSections, { allowlistBase }) {
  const imports = orderedSections
    .map((s) => `import ${s.componentName} from "./sections/${s.componentName}";`)
    .join("\n");
  const renders = orderedSections.map((s) => `      <${s.componentName} />`).join("\n");
  const content = `${imports}

export default function Page() {
  return (
    <>
${renders}
    </>
  );
}
`;
  return { path: pageFilePath(allowlistBase), content };
}
