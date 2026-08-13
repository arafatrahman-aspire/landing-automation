import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { checkSyntax, checkUntypedProps, checkImports, checkHoneypotOptional, checkLeadFormAnchor, extractImportSpecifiers, precheckSectionFile } from "../src/verify/precheck-section-file.mjs";

/* The syntax check uses the target repo's own TypeScript. In this service's
 * test environment the only copy available is the UI package's, so it's
 * injected explicitly — that keeps these tests deterministic instead of
 * silently passing when no parser can be found. */
let ts = null;
try {
  ts = createRequire(import.meta.url)("../ui/node_modules/typescript");
} catch {
  // no parser here — the syntax tests below skip themselves
}
const syntaxTest = ts ? test : test.skip;
async function syntaxOf(content) {
  return checkSyntax({ content, filePath: "T.tsx", workdir: "/nonexistent", typescriptModule: ts });
}

/* Every "catches" case below is a VERBATIM reproduction of a defect that cost
 * a real run a full ~60s npm ci + Next build to discover. */

/* ---------------- no false positives (the design rule) ---------------- */

const VALID_COMPONENT = `"use client";

import React, { useState } from "react";

interface IProps {
  title?: string;
  children?: React.ReactNode;
}

const Button = ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
  <button onClick={onClick}>{children}</button>
);

export default function HeroSection0({ title = "Hi" }: IProps) {
  const [value, setValue] = useState<string>("");
  const ratio = 10 / 2;
  const label = \`count: \${value.length} / \${ratio}\`;
  const re = /^[a-z]+\\/[0-9]+$/;
  return (
    <section>
      <h1>{title} — it's "quoted" text</h1>
      <Button onClick={() => setValue("x")}>Go</Button>
      <p>{re.test(label) ? "yes" : "no"}</p>
    </section>
  );
}
`;

syntaxTest("valid component with regex, division, templates, apostrophes and quotes passes cleanly", async () => {
  const syntax = await syntaxOf(VALID_COMPONENT);
  assert.equal(syntax.ok, true, `should not flag valid code: ${JSON.stringify(syntax.problems)}`);
  assert.equal(checkUntypedProps(VALID_COMPONENT, { strict: true }).ok, true, "annotated params must not be flagged");
});

syntaxTest("JSX prose with apostrophes is NOT mistaken for an unterminated string", async () => {
  // The exact false positive that killed the hand-rolled scanner.
  const src = `export default function X() {\n  return <p>it's a thing, don't worry</p>;\n}\n`;
  const result = await syntaxOf(src);
  assert.equal(result.ok, true, `false positive on JSX prose: ${JSON.stringify(result.problems)}`);
});

/* ---------------- 1. syntax (real failure: stray trailing quote) ---------------- */

syntaxTest("catches the real 'Unterminated string constant' — a stray quote after the last statement", async () => {
  // Verbatim shape of the attempt-3 failure: `export default HeroSection0;"`
  const src = `const HeroSection0 = () => (\n  <section />\n);\n\nexport default HeroSection0;"\n`;
  const result = await syntaxOf(src);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /Unterminated string/i);
  assert.equal(result.problems[0].kind, "syntax");
});

syntaxTest("catches a file that ends mid-template-literal", async () => {
  const src = "const a = `hello ${name}\nexport default a;\n";
  assert.equal((await syntaxOf(src)).ok, false);
});

syntaxTest("catches an unclosed brace", async () => {
  const result = await syntaxOf(`export default function X() {\n  return <p>hi</p>;\n`);
  assert.equal(result.ok, false);
});

syntaxTest("catches a mismatched bracket", async () => {
  assert.equal((await syntaxOf(`const a = [1, 2, 3};\n`)).ok, false);
});

syntaxTest("with no parser available the syntax check SKIPS rather than guessing", async () => {
  const result = await checkSyntax({ content: `export default X;"\n`, filePath: "T.tsx", workdir: "/nonexistent", typescriptModule: null });
  assert.equal(result.skipped, true);
  assert.equal(result.ok, true, "a skipped check must never block a file");
});

/* ---------------- 2. imports (real failures: invented local files) ---------------- */

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "precheck-"));
  await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@*": ["./src/*"] } } }));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^18", next: "^14" } }));
  await mkdir(path.join(dir, "src/app/campaigns/x/sections"), { recursive: true });
  await mkdir(path.join(dir, "src/components"), { recursive: true });
  await writeFile(path.join(dir, "src/components/Real.tsx"), "export default function Real(){return null}\n");
  return dir;
}

test("extractImportSpecifiers finds imports and ignores commented-out ones", () => {
  const src = `import a from "./a";\n// import b from "./ghost";\nimport { c } from "@components/Real";\nconst d = require("pkg");\n`;
  const specs = extractImportSpecifiers(src);
  assert.ok(specs.includes("./a"));
  assert.ok(specs.includes("@components/Real"));
  assert.ok(specs.includes("pkg"));
  assert.ok(!specs.includes("./ghost"), "a commented-out import must not be reported");
});

test("catches the real invented relative import ('../../../../../components/SectionLine')", async () => {
  const dir = await makeRepo();
  try {
    const result = await checkImports({
      content: `import SectionLine from "../../../../../components/SectionLine";\n`,
      filePath: "src/app/campaigns/x/sections/CurriculumSection2.tsx",
      workdir: dir,
      declaredPackages: new Set(["react", "next"]),
    });
    assert.equal(result.ok, false);
    assert.match(result.problems[0].message, /does not exist/);
    assert.match(result.problems[0].message, /build what you need inline/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a relative import that DOES exist is accepted", async () => {
  const dir = await makeRepo();
  try {
    const result = await checkImports({
      content: `import Real from "../../../../components/Real";\n`,
      filePath: "src/app/campaigns/x/sections/Section0.tsx",
      workdir: dir,
      declaredPackages: new Set(["react"]),
    });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an aliased import resolves through tsconfig paths, and a missing one is caught", async () => {
  const dir = await makeRepo();
  try {
    const good = await checkImports({
      content: `import R from "@components/Real";\n`,
      filePath: "src/app/campaigns/x/sections/S.tsx",
      workdir: dir,
      declaredPackages: new Set(["react"]),
    });
    assert.equal(good.ok, true, JSON.stringify(good.problems));

    // The real analyze/-frames failure: alias is valid, file isn't there.
    const bad = await checkImports({
      content: `import F from "@components/frames/landing/analyze/FaqAccordionFrame";\n`,
      filePath: "src/app/campaigns/x/sections/S.tsx",
      workdir: dir,
      declaredPackages: new Set(["react"]),
    });
    assert.equal(bad.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("real dependencies pass; an invented package is caught", async () => {
  const dir = await makeRepo();
  try {
    const declaredPackages = new Set(["react", "next"]);
    const ok = await checkImports({ content: `import React from "react";\nimport Link from "next/link";\n`, filePath: "src/app/x.tsx", workdir: dir, declaredPackages });
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));

    const bad = await checkImports({ content: `import { Swiper } from "swiper/react";\n`, filePath: "src/app/x.tsx", workdir: dir, declaredPackages });
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0].message, /not a dependency/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stylesheet and asset imports are left to the bundler, never flagged", async () => {
  const dir = await makeRepo();
  try {
    const result = await checkImports({
      content: `import "./styles.css";\nimport logo from "./logo.svg";\n`,
      filePath: "src/app/x.tsx",
      workdir: dir,
      declaredPackages: new Set(["react"]),
    });
    assert.equal(result.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------- 3. implicit any (real failure) ---------------- */

test("catches the real untyped destructured props ('Binding element children implicitly has an any type')", () => {
  const src = `const Button = ({ children, type = 'button', onClick, disabled, className }) => (\n  <button>{children}</button>\n);\n`;
  const result = checkUntypedProps(src, { strict: true });
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /implicit "any"/);
  assert.match(result.problems[0].message, /interface IProps/);
  assert.match(result.problems[0].message, /children/);
});

test("annotated params are accepted, in both inline and interface form", () => {
  assert.equal(checkUntypedProps(`const A = ({ a, b }: IProps) => null;\n`, { strict: true }).ok, true);
  assert.equal(checkUntypedProps(`function B({ a }: { a: string }) { return null; }\n`, { strict: true }).ok, true);
});

test("a non-strict repo skips the type check entirely", () => {
  const src = `const Button = ({ children }) => <button>{children}</button>;\n`;
  assert.equal(checkUntypedProps(src, { strict: false }).ok, true);
});

/* ---------------- entry point ---------------- */

syntaxTest("precheckSectionFile reports syntax alone, without piling on downstream noise", async () => {
  const dir = await makeRepo();
  try {
    const result = await precheckSectionFile({
      content: `import Ghost from "./ghost";\nconst A = ({ x }) => null;\nexport default A;"\n`,
      filePath: "src/app/campaigns/x/sections/S.tsx",
      workdir: dir,
      strictTypes: true,
      declaredPackages: new Set(["react"]),
      typescriptModule: ts,
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].kind, "syntax", "a file that doesn't parse should report the syntax error first");
    assert.equal(result.problems[0].kind, "syntax");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("precheckSectionFile passes a genuinely good file", async () => {
  const dir = await makeRepo();
  try {
    const result = await precheckSectionFile({
      content: VALID_COMPONENT,
      filePath: "src/app/campaigns/x/sections/HeroSection0.tsx",
      workdir: dir,
      strictTypes: true,
      declaredPackages: new Set(["react", "next"]),
      typescriptModule: ts,
    });
    assert.equal(result.ok, true, `false positive: ${result.report}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a callback's destructured param is NOT flagged — it is contextually typed", () => {
  // items.map(({ id }) => ...) is legal under strict mode. Flagging it would
  // be a false positive on completely ordinary React code.
  const src = `export default function X({ items }: IProps) {
  return <ul>{items.map(({ id, label }) => <li key={id}>{label}</li>)}</ul>;
}
`;
  assert.equal(checkUntypedProps(src, { strict: true }).ok, true);
});

test("a variable type annotation supplies the type, so the param is not flagged", () => {
  const src = `const Card: React.FC<CardProps> = ({ title, children }) => <div>{title}{children}</div>;\n`;
  assert.equal(checkUntypedProps(src, { strict: true }).ok, true);
});

test("an untyped exported function component is flagged", () => {
  const result = checkUntypedProps(`export default function Hero({ title, subtitle }) {\n  return <h1>{title}</h1>;\n}\n`, { strict: true });
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /title/);
});

/* ---------------- Honeypot typed as required ---------------- */

/* Lifted from the real generated file that failed three consecutive Docker
 * builds (run f2fa8b7d, HeroSection0.tsx) — the honeypot is required in the
 * interface but optional in the yup schema, so yupResolver's inferred type
 * isn't assignable to Resolver<IFormData>. */
const REAL_FAILING_HERO = `'use client';

import { useForm } from 'react-hook-form';
import { yupResolver } from '@hookform/resolvers/yup';
import * as yup from 'yup';

interface IFormData {
  name: string;
  phone: string;
  email: string;
  company_website: string; // Honeypot
}

const schema = yup.object().shape({
  name: yup.string().required('Full name is required'),
  phone: yup.string().required('Phone number is required'),
  email: yup.string().email('Invalid email address').required('Email address is required'),
  company_website: yup.string(), // Honeypot, not validated for content
});

const HeroSection0 = ({ data }: HeroSection0Props) => {
  const { register, handleSubmit } = useForm<IFormData>({
    resolver: yupResolver(schema),
  });
  return <form onSubmit={handleSubmit(() => {})} />;
};
`;

test("catches the real resolver mismatch that cost three Docker builds", () => {
  const result = checkHoneypotOptional(REAL_FAILING_HERO);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0].message, /company_website\?: string/);
  // Points at the interface line, not the schema line.
  assert.match(result.problems[0].message, /^Line 11:/);
});

test("the same file with the honeypot made optional passes", () => {
  const fixed = REAL_FAILING_HERO.replace("company_website: string;", "company_website?: string;");
  assert.equal(checkHoneypotOptional(fixed).ok, true);
});

test("the schema entry itself is never mistaken for a type declaration", () => {
  // `company_website: yup.string()` is the correct optional schema entry — the
  // value side is a call, not the `string` keyword.
  const src = `import { useForm } from 'react-hook-form';
const schema = yup.object().shape({ company_website: yup.string() });
const X = () => { useForm<T>({}); };
`;
  assert.equal(checkHoneypotOptional(src).ok, true);
});

test("a zod schema's optional honeypot passes", () => {
  const src = `import { useForm } from 'react-hook-form';
type FormData = { email: string; company_website?: string };
const schema = z.object({ email: z.string(), company_website: z.string().optional() });
const X = () => useForm<FormData>({ resolver: zodResolver(schema) });
`;
  assert.equal(checkHoneypotOptional(src).ok, true);
});

test("a section with no form is left alone entirely", () => {
  // A testimonials/pricing section could legitimately carry a company website
  // field. Without react-hook-form there is no resolver to mismatch, so the
  // check must not fire — false positives are worse than false negatives.
  const src = `interface ITestimonial {
  author: string;
  company_website: string;
}
export default function Testimonials({ items }: { items: ITestimonial[] }) {
  return <ul>{items.map((t) => <li key={t.author}>{t.company_website}</li>)}</ul>;
}
`;
  assert.equal(checkHoneypotOptional(src).ok, true);
});

test("a commented-out required honeypot is not reported", () => {
  const src = `import { useForm } from 'react-hook-form';
// interface Old { company_website: string }
interface IFormData { company_website?: string }
const X = () => useForm<IFormData>({});
`;
  assert.equal(checkHoneypotOptional(src).ok, true);
});

test("hero form missing id=regForm is reported", () => {
  const src = `export default function Hero() {
  return <form data-hero-form><input name="email" /></form>;
}
`;
  const result = checkLeadFormAnchor(src);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /id="regForm"/);
});

test("hero form with id=regForm on the same tag passes", () => {
  const a = `export default function Hero() {
  return <form data-hero-form id="regForm"><input /></form>;
}
`;
  const b = `export default function Hero() {
  return <div id="regForm" data-hero-form><form /></div>;
}
`;
  assert.equal(checkLeadFormAnchor(a).ok, true);
  assert.equal(checkLeadFormAnchor(b).ok, true);
});

test("sections without data-hero-form skip the anchor check", () => {
  assert.equal(checkLeadFormAnchor(`export default function Cta() { return <a href="#regForm">Go</a>; }`).ok, true);
});
