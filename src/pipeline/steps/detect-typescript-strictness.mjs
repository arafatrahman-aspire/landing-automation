import path from "node:path";
import { readFile } from "node:fs/promises";

/* Detects how strictly the TARGET repo type-checks, so the section prompt can
 * demand code that will actually compile there.
 *
 * Why: a real run failed with "Binding element 'children' implicitly has an
 * 'any' type" because the agent wrote plain-JS-style React —
 * `({ children, onClick }) => ...` — into a `.tsx` file in a repo with
 * `"strict": true`. Nothing in the prompt told it the repo type-checks
 * strictly, or that its own components already use an `interface IProps`
 * convention. `next build` runs tsc, so an untyped prop is a hard build
 * failure, not a warning. */

/** Reads a tsconfig/jsconfig, tolerating the JSONC (comments, trailing commas)
 *  these files are usually written in. Returns null rather than throwing. */
async function readConfigFile(workdir, name) {
  try {
    const raw = await readFile(path.join(workdir, name), "utf8");
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{isTypeScript: boolean, strict: boolean}>}
 */
export async function detectTypeScriptStrictness(workdir) {
  const tsconfig = await readConfigFile(workdir, "tsconfig.json");
  if (!tsconfig) return { isTypeScript: false, strict: false };

  const opts = tsconfig.compilerOptions ?? {};

  // Only treat it as lenient when the config explicitly says so. If strictness
  // is inherited via `extends` (which isn't followed here) we can't see it —
  // and assuming strict is the safe default in both directions: writing typed
  // props in a loose repo is harmless, omitting them in a strict one is fatal.
  const explicitlyLoose = opts.strict === false && opts.noImplicitAny === false;

  return { isTypeScript: true, strict: !explicitlyLoose };
}

/** Prompt text describing what the target repo's type checker will accept.
 *  Empty string for a non-TypeScript repo, so it costs nothing there. */
export function buildTypeScriptPromptFragment({ isTypeScript, strict }) {
  if (!isTypeScript) return "";
  if (!strict) {
    return `\nThis repository is TypeScript. Prefer explicit types on component props and function parameters.\n`;
  }
  return `
THIS REPOSITORY TYPE-CHECKS STRICTLY ("strict": true), AND THE BUILD RUNS THE TYPE CHECKER — an untyped parameter is a BUILD FAILURE, not a warning. A real past run failed here with "Binding element 'children' implicitly has an 'any' type."
- EVERY function parameter and EVERY destructured prop must have an explicit type. Never write \`({ children, onClick }) => ...\` — that is an implicit \`any\` and will fail.
- Follow this repo's existing convention: declare \`interface IProps { ... }\` above the component and annotate the parameter with it, e.g. \`const Thing = ({ title, children }: IProps) => ...\`. Read a real component in this repo first and copy how it does this.
- Type React event handlers explicitly, e.g. \`(e: React.FormEvent<HTMLFormElement>)\`, \`(e: React.ChangeEvent<HTMLInputElement>)\`.
- If you define a small helper component inside your file, it needs typed props too — the strict check applies to every declaration in the file, not just the exported one.
- Mark optional props with \`?\` rather than leaving them untyped, and give \`useState\` an explicit type argument whenever its initial value doesn't imply one (e.g. \`useState<string[]>([])\`).
`;
}
