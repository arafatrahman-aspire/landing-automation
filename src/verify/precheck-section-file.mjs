import path from "node:path";
import { readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolveFrameFile } from "../design-catalog/resolve-frame-file.mjs";
import { HONEYPOT_FIELD_NAME, LEAD_FORM_ANCHOR_ID, LEAD_FORM_HREF } from "../leadform/contract.mjs";

/* A fast, local sanity check on ONE generated file, run before the page is
 * composed and long before Docker/`next build` is invoked.
 *
 * Why this exists: every attempt of a real run cost ~55-60s of `npm ci` plus a
 * full Next build, and three consecutive attempts were spent discovering
 * (1) an import of a file that doesn't exist, (2) an untyped destructured
 * prop, and (3) a stray `"` producing an unterminated string. All three are
 * detectable locally in milliseconds. Paying minutes to learn something that
 * costs microseconds is what made the loop unusable.
 *
 * This is a PRE-FILTER, not a replacement for the build. The real verify suite
 * still runs and is still the gate — this just stops obviously-broken files
 * from ever reaching it, and gives the repair loop an instant, unambiguous,
 * single-file error to act on.
 *
 * DESIGN RULE: false positives are worse than false negatives. Blocking valid
 * code would be a self-inflicted outage, whereas missing a defect just costs
 * what it already costs today. Every check below only reports when it is
 * certain; anything ambiguous is allowed through for the real build to judge. */

const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

/* ------------------------------------------------------------------ *
 * 1. Syntax: parse the file with the REAL TypeScript parser
 * ------------------------------------------------------------------ */

/* A hand-rolled lexer was tried first and rejected: an apostrophe in ordinary
 * JSX copy ("it's", "don't") reads as an unterminated string to anything that
 * doesn't understand JSX text, which would have blocked valid marketing pages.
 * Rather than approximate a parser, use the real one — the target repo is a
 * TypeScript project, so it ships `typescript` in its own node_modules.
 *
 * When it can't be resolved (before the first install), the syntax check is
 * SKIPPED rather than guessed at. A skipped check costs what the loop already
 * costs today; a wrong check would block correct code. */
async function loadTypeScript(workdir) {
  const roots = [
    workdir, // the run's worktree — populated once verify has installed once
    path.resolve(workdir, "..", "_base"), // the shared base clone
    process.cwd(), // this service, if typescript is ever added here
  ];
  for (const root of roots) {
    try {
      const requireFrom = createRequire(path.join(root, "noop.js"));
      return requireFrom("typescript");
    } catch {
      // not resolvable from this root — try the next
    }
  }
  return null;
}

/**
 * @param {object} p
 * @param {string} p.content
 * @param {string} p.filePath
 * @param {string} p.workdir
 * @param {object} [p.typescriptModule] - injectable for tests
 * @returns {Promise<{ok: boolean, skipped: boolean, problems: Array}>}
 */
export async function checkSyntax({ content, filePath, workdir, typescriptModule = null }) {
  const ts = typescriptModule ?? (await loadTypeScript(workdir));
  if (!ts) return { ok: true, skipped: true, problems: [] };

  const sourceFile = ts.createSourceFile(path.basename(filePath), content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // parseDiagnostics holds purely SYNTACTIC errors — no type information and
  // no node_modules needed, so this is fast and self-contained.
  const diagnostics = sourceFile.parseDiagnostics ?? [];

  const problems = diagnostics.slice(0, 5).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
    let where = "";
    if (typeof d.start === "number") {
      const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, d.start);
      where = `Line ${line + 1}:${character + 1}: `;
    }
    return { kind: "syntax", message: `${where}${message}` };
  });

  return { ok: problems.length === 0, skipped: false, problems };
}

/* ------------------------------------------------------------------ *
 * 2. Imports: does every imported path actually exist?
 * ------------------------------------------------------------------ */

// Strips comments before scanning, so a commented-out import isn't reported.
function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g;
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;

export function extractImportSpecifiers(content) {
  const clean = stripComments(content);
  const found = new Set();
  for (const re of [IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) found.add(m[1]);
  }
  return [...found];
}

async function fileExists(p) {
  return access(p).then(() => true, () => false);
}

async function resolveRelative(absBase) {
  for (const ext of SOURCE_EXTENSIONS) {
    if (await fileExists(absBase + ext)) return absBase + ext;
  }
  if (await fileExists(absBase)) return absBase;
  for (const ext of SOURCE_EXTENSIONS) {
    if (await fileExists(path.join(absBase, `index${ext}`))) return path.join(absBase, `index${ext}`);
  }
  return null;
}

/**
 * @param {object} p
 * @param {string} p.content
 * @param {string} p.filePath - repo-relative path of the file being checked
 * @param {string} p.workdir
 * @param {Set<string>} [p.declaredPackages] - names from the repo's package.json
 */
export async function checkImports({ content, filePath, workdir, declaredPackages = null }) {
  const problems = [];
  const fromDir = path.dirname(path.resolve(workdir, filePath));

  for (const spec of extractImportSpecifiers(content)) {
    // Non-code assets resolve through bundler loaders, not the filesystem
    // rules used here — out of scope, let the real build judge them.
    if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|json)$/i.test(spec)) continue;

    if (spec.startsWith(".")) {
      const resolved = await resolveRelative(path.resolve(fromDir, spec));
      if (!resolved) {
        problems.push({
          kind: "import",
          message: `Import "${spec}" does not exist. Relative to this file that resolves to ${path.relative(workdir, path.resolve(fromDir, spec))}, and no file is there. Do not import project files you have not opened with read_file — build what you need inline instead.`,
        });
      }
      continue;
    }

    // Aliased (tsconfig `paths`) — reuse the same resolver the frame catalog
    // uses so alias handling can't drift between the two.
    const aliased = await resolveFrameFile({ workdir, importPath: spec });
    if (aliased) continue;

    // Bare package. Verified against package.json rather than node_modules,
    // because this runs before install.
    const root = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (declaredPackages && !declaredPackages.has(root)) {
      problems.push({
        kind: "import",
        message: `Import "${spec}" is not a dependency of this repository (package.json has no "${root}"), and does not match any tsconfig path alias. Use only packages this repo already depends on.`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Reads dependency names from the target repo's package.json. */
export async function readDeclaredPackages(workdir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8"));
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  } catch {
    return null; // can't verify -> don't report, per the no-false-positives rule
  }
}

/* ------------------------------------------------------------------ *
 * 3. Untyped destructured props (strict TypeScript repos only)
 * ------------------------------------------------------------------ */

/* Only DECLARED functions are checked — `const X = ({ a }) => …` and
 * `function X({ a }) {}`. A destructured parameter in a callback argument,
 * e.g. `items.map(({ id }) => …)`, gets its type contextually from the array
 * and is perfectly legal under strict mode; flagging those would be a false
 * positive on extremely ordinary React code.
 *
 * A type annotation on either the variable (`const X: React.FC<P> = …`) or the
 * parameter (`({ a }: IProps)`) also supplies the type, so both are skipped. */
const DECLARED_ARROW_RE = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(:[^=]+)?=\s*(?:async\s+)?\(\s*\{([^{}]*)\}\s*(:[^)]*)?\)\s*=>/g;
const DECLARED_FUNCTION_RE = /function\s+[A-Za-z_$][\w$]*\s*\(\s*\{([^{}]*)\}\s*(:[^)]*)?\)/g;

function paramNames(params) {
  return params
    .split(",")
    .map((s) => s.split(/[:=]/)[0].trim())
    .filter(Boolean);
}

export function checkUntypedProps(content, { strict = true } = {}) {
  if (!strict) return { ok: true, problems: [] };
  const problems = [];
  const clean = stripComments(content);

  function report(index, params) {
    const names = paramNames(params);
    if (names.length === 0) return;
    const line = clean.slice(0, index).split("\n").length;
    problems.push({
      kind: "types",
      message: `Line ${line}: destructured parameter { ${names.join(", ")} } has no type annotation. This repository sets "strict": true, so each of these is an implicit "any" and the build WILL fail with "Binding element '...' implicitly has an 'any' type". Declare an interface (e.g. interface IProps { ... }) and annotate the parameter: ({ ${names.join(", ")} }: IProps).`,
    });
  }

  DECLARED_ARROW_RE.lastIndex = 0;
  let m;
  while ((m = DECLARED_ARROW_RE.exec(clean)) !== null) {
    const [, varTypeAnnotation, params, paramTypeAnnotation] = m;
    if (varTypeAnnotation || paramTypeAnnotation) continue;
    report(m.index, params);
  }

  DECLARED_FUNCTION_RE.lastIndex = 0;
  while ((m = DECLARED_FUNCTION_RE.exec(clean)) !== null) {
    const [, params, paramTypeAnnotation] = m;
    if (paramTypeAnnotation) continue;
    report(m.index, params);
  }

  return { ok: problems.length === 0, problems };
}

/* ------------------------------------------------------------------ *
 * 4. Honeypot typed as required (react-hook-form resolver mismatch)
 * ------------------------------------------------------------------ */

/* A real run failed three consecutive Docker builds on exactly this, and the
 * repair loop could not talk its way out of it:
 *
 *   interface IFormData { …; company_website: string }        // required
 *   yup.object().shape({ …, company_website: yup.string() })  // optional
 *   useForm<IFormData>({ resolver: yupResolver(schema) })
 *
 *   Type 'Resolver<{ company_website?: string | undefined; … }>' is not
 *   assignable to type 'Resolver<IFormData, any, IFormData>'.
 *
 * The honeypot is optional BY DEFINITION — a human visitor always leaves it
 * empty — so the schema will always infer it optional, and declaring it
 * required in the type can never be right. Worth noting the check holds even
 * if the agent "fixes" the mismatch the other way by making the schema require
 * it: that would make the form unsubmittable for every real visitor.
 *
 * Gated on the file actually using react-hook-form, so an ordinary marketing
 * section that happens to have a "company website" field is never touched. */
export function checkHoneypotOptional(content) {
  const clean = stripComments(content);
  if (!/\buseForm\s*[<(]/.test(clean)) return { ok: true, problems: [] };

  // Matches a required TS property (`company_website: string`) but not an
  // optional one (`company_website?: string`) — the `?` breaks the match —
  // and not a schema entry (`company_website: yup.string()`), whose value
  // side doesn't start with the `string` keyword.
  const requiredHoneypot = new RegExp(`(?:^|[{;,\\n])\\s*${HONEYPOT_FIELD_NAME}\\s*:\\s*string\\b`, "g");
  const problems = [];
  let m;
  while ((m = requiredHoneypot.exec(clean)) !== null) {
    // Counted to the field NAME, not to the match start — the match may begin
    // on the previous line, since the leading `[{;,\n]` swallows the separator
    // that ended it (`email: string;` ⏎ `company_website: string`).
    const fieldOffset = m.index + m[0].indexOf(HONEYPOT_FIELD_NAME);
    const line = clean.slice(0, fieldOffset).split("\n").length;
    problems.push({
      kind: "types",
      message:
        `Line ${line}: the honeypot field \`${HONEYPOT_FIELD_NAME}\` is declared as required (\`${HONEYPOT_FIELD_NAME}: string\`). ` +
        `It must be optional: \`${HONEYPOT_FIELD_NAME}?: string\`. A real visitor always leaves it empty, so the validation schema ` +
        `infers it as optional, and useForm<T> then rejects the resolver with "Type 'Resolver<{ ${HONEYPOT_FIELD_NAME}?: string | ` +
        `undefined; ... }>' is not assignable to type 'Resolver<T, any, T>'". Add the \`?\` — do not make the schema require it instead, ` +
        `which would stop every genuine visitor from submitting the form.`,
    });
  }

  return { ok: problems.length === 0, problems };
}

/* ------------------------------------------------------------------ *
 * 5. Hero lead form missing id="regForm" (CTA anchors go nowhere)
 * ------------------------------------------------------------------ */

/** If the file marks a lead form with data-hero-form, that same element must
 *  also declare id="regForm" — target-repo CTA frames hardcode href="#regForm". */
export function checkLeadFormAnchor(content) {
  const clean = stripComments(content);
  if (!/\bdata-hero-form\b/.test(clean)) return { ok: true, problems: [] };

  // Accept id before or after data-hero-form on the opening tag.
  const hasAnchor =
    new RegExp(`\\bid\\s*=\\s*["']${LEAD_FORM_ANCHOR_ID}["'][^>]*\\bdata-hero-form\\b`).test(clean) ||
    new RegExp(`\\bdata-hero-form\\b[^>]*\\bid\\s*=\\s*["']${LEAD_FORM_ANCHOR_ID}["']`).test(clean);

  if (hasAnchor) return { ok: true, problems: [] };

  return {
    ok: false,
    problems: [
      {
        kind: "hero-anchor",
        message:
          `The element with \`data-hero-form\` must also have \`id="${LEAD_FORM_ANCHOR_ID}"\` on the same tag ` +
          `(e.g. \`<form data-hero-form id="${LEAD_FORM_ANCHOR_ID}">\`). Without it, every CTA linking to ` +
          `\`${LEAD_FORM_HREF}\` does nothing.`,
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Runs every cheap check against one generated file.
 *
 * @returns {Promise<{ok: boolean, problems: Array<{kind: string, message: string}>, report: string}>}
 */
export async function precheckSectionFile({ content, filePath, workdir, strictTypes = false, declaredPackages = null, typescriptModule = null }) {
  const problems = [];

  // Syntax first and alone: if the file doesn't parse, every other check is
  // reading garbage and would pile noise on top of the real problem.
  const syntax = await checkSyntax({ content, filePath, workdir, typescriptModule });
  problems.push(...syntax.problems);

  if (syntax.ok) {
    const imports = await checkImports({ content, filePath, workdir, declaredPackages });
    problems.push(...imports.problems);
    problems.push(...checkUntypedProps(content, { strict: strictTypes }).problems);
    // Not gated on strictTypes: the resolver mismatch is a plain assignability
    // error that fails the build under any tsconfig, strict or not.
    problems.push(...checkHoneypotOptional(content).problems);
    problems.push(...checkLeadFormAnchor(content).problems);
  }

  const report = problems.map((p) => `- [${p.kind}] ${p.message}`).join("\n");
  return { ok: problems.length === 0, problems, report };
}
