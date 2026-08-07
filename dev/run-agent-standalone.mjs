/* Manual harness: drive the agentic coding loop against a small local
 * fixture folder — NOT a git clone, no GitHub involved — so the tool
 * schemas/prompts can be iterated on cheaply against the real LLM API while
 * watching the transcript, before paying for a full clone+verify+push cycle.
 * Uses whichever provider CODING_AGENT_PROVIDER selects (gemini|claude).
 *
 * Run: node --env-file=.env dev/run-agent-standalone.mjs   (from new_approach/) */

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCodingAgent } from "../src/llm/coding-agent.mjs";

const root = await mkdtemp(path.join(tmpdir(), "agent-harness-"));
console.log(`Fixture repo: ${root}`);

// A tiny fake "existing repo" so the agent has something to explore.
await mkdir(path.join(root, "app", "about"), { recursive: true });
await mkdir(path.join(root, "components"), { recursive: true });
await writeFile(
  path.join(root, "package.json"),
  JSON.stringify({ name: "fixture-frontend", scripts: { build: "echo ok" }, dependencies: { react: "^19.0.0" } }, null, 2)
);
await writeFile(
  path.join(root, "app", "about", "page.tsx"),
  `export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-bold text-slate-900">About us</h1>
      <p className="mt-4 text-slate-600">We build things.</p>
    </main>
  );
}
`
);
await writeFile(
  path.join(root, "components", "Button.tsx"),
  `export function Button({ children }: { children: React.ReactNode }) {
  return <button className="rounded bg-blue-600 px-4 py-2 text-white">{children}</button>;
}
`
);

const slug = "harness-test-campaign";
const allowedPrefixes = [`app/campaigns/${slug}/`];
const pristineFiles = new Set(["package.json", "app/about/page.tsx", "components/Button.tsx"]);
const fileManifest = {
  slug,
  summary: "A test landing page for harness verification.",
  designNotes: "Mirror the existing About page's Tailwind style.",
  filesToCreate: [{ path: `app/campaigns/${slug}/page.tsx`, purpose: "Landing page route" }],
};
const manifestPaths = new Set(fileManifest.filesToCreate.map((f) => f.path));

const systemPrompt = `You are a coding agent adding a new landing page to an existing frontend repository.

GUARDRAILS:
- You may ONLY create files under: ${allowedPrefixes.join(", ")}
- You may ONLY create files declared in the plan below.
- You can NEVER modify or overwrite a file that already existed.
- No shell access. Explore with list_files/read_file, write with write_file, call finish_coding when done.

Explore first (package.json, app/about/page.tsx, components/Button.tsx) so your new code matches conventions.

FILE PLAN:
${JSON.stringify(fileManifest, null, 2)}

CONTENT GUIDE:
Headline: "Harness Test Campaign — Free Trial"
Subheadline: "Just a fixture page for testing the coding agent loop."
Include: hero, 3 pain points, a lead form placeholder, FAQ (3 items).`;

const result = await runCodingAgent({
  workdir: root,
  allowedPrefixes,
  pristineFiles,
  manifestPaths,
  systemPrompt,
  taskPrompt: "Explore the repository, then implement the file plan. Call finish_coding when done.",
  logger: (msg) => console.log(`  ${msg}`),
});

console.log("\n--- RESULT ---");
console.log(JSON.stringify({ finished: result.finished, summary: result.summary, iterations: result.iterations, writtenFiles: [...result.writtenFiles] }, null, 2));
console.log(`\nInspect the written files under: ${root}`);
console.log("(not auto-deleted — remove manually when done inspecting)");
