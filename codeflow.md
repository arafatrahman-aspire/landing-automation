# Code Flow — a guided walk through the codebase

This is an onboarding doc, not a reference doc. It walks through the files
**in the order the code actually runs**, one campaign request at a time, so
you can read it top to bottom and end up with a real mental model instead of
a folder listing. For *why* things are built this way, see `new_plan.md`.
For a version-by-version history of what changed and when, see
`documentation.md`.

Every file path below is exact and current as of this writing (`src/`
layout as of the v0.22 restructure). If a path looks wrong, the codebase
moved on and this doc needs an update, not the other way around.

---

## 0. The one thing to get straight before anything else: what LangChain actually does here

This project depends on `@langchain/langgraph`, and it's tempting to assume
that means "LangChain handles talking to the LLM." **It doesn't.** LangGraph
is used for exactly one thing: [`src/pipeline/run-campaign-pipeline.mjs`](src/pipeline/run-campaign-pipeline.mjs)'s
`StateGraph` — the state machine that decides which step runs next and what
data flows between steps. That's it.

Every actual LLM call in this codebase — research, content planning, and the
coding agent — is a **hand-rolled `fetch()` call** straight to the
Anthropic or Gemini HTTP API, in [`src/llm/generate-text.mjs`](src/llm/generate-text.mjs) and
[`src/llm/coding-agent.mjs`](src/llm/coding-agent.mjs). There's no LangChain model wrapper, no
LangChain tool-calling abstraction, no LangChain memory. Keep this
separation in your head as you read: **LangGraph = "what runs next."
Plain fetch = "what the LLM actually says."**

---

## 1. Where a request enters the system

[`src/server.mjs`](src/server.mjs) is the only HTTP entry point (Express). The route that
matters for this walkthrough:

```
POST /campaigns  →  validateBrief() [schemas/campaign-brief-schema.mjs]
                  →  runStore.createRun()  (writes a row, status "queued")
                  →  runCodegen({ runId, request })   ← fire-and-forget, NOT awaited
                  →  responds 202 immediately with a statusUrl
```

`runCodegen` is imported from `pipeline/run-campaign-pipeline.mjs` — this is
the handoff into the actual pipeline. Everything from here until "staged for
review" happens inside one LangGraph `graph.invoke()` call, running in the
background while the HTTP response has already gone back to the caller.
Progress is polled via `GET /campaigns/:runId`, which just reads the current
row out of the database (see §9) — there's no websocket, no SSE, just polling.

[`src/config.mjs`](src/config.mjs) is worth a skim before anything else: it loads and
validates every env var *once*, at import time, and every other module reads
from `config` (the loaded object), never from `process.env` directly. If
`.env` is missing something required, the process refuses to start — you'll
never see a mysterious `undefined` three files deep.

---

## 2. The pipeline shell — `pipeline/run-campaign-pipeline.mjs`

This file defines the graph and nothing else — no business logic lives here,
just wiring:

```
intake → research → clone → generate_guide → classify_sections
       → generate_sections → verify ──┬─(fail, retries left)─→ back to generate_sections
                                       └─(pass)─→ stage_draft → preview_build → END
```

Each node name maps to one function, imported as `import * as steps from
"./steps/index.mjs"`. The graph's state (`CodegenState`, a LangGraph
`Annotation.Root`) is just a plain object that accumulates fields as each
step returns its partial update — `workdir`, `guide`, `classifiedSections`,
`writtenByAgent`, `verifyPassed`, etc. Nothing exotic; treat it as one shared
object every step reads from and adds to.

**Important:** the graph ends at `preview_build`, always — success or a
retry-exhausted verify failure both reach `END`. It does **not** commit,
push, or open a PR. That happens later, from a separate HTTP request, once a
human approves (§10). `runCodegen()` (bottom of this same file) wraps
`graph.invoke()` and sets the run's final status (`staged_for_review` or
`failed_verification`) based on `state.verifyPassed` — not on which node was
reached, since both success and terminal failure exit the same way.

Now walk the actual steps, in order, in [`src/pipeline/steps/`](src/pipeline/steps/):

---

## 3. `01-intake.mjs`

The smallest possible step: marks the run's heartbeat/stage as `"intake"`
and logs the campaign name. Nothing to understand here beyond "this is where
the graph starts."

## 4. `02-research.mjs` — first LLM call

Calls `generateText()` from [`src/llm/generate-text.mjs`](src/llm/generate-text.mjs) with
`webSearch: true`, asking for keywords/pain points/FAQ questions as JSON.
Skippable entirely via `SKIP_RESEARCH=true` for fast local iteration.

This is your first look at `generate-text.mjs`'s shape: `generateText()`
picks Claude or Gemini based on `config.aiProvider`, both branches are plain
`fetch()` to the provider's HTTP API, and `extractJson()` pulls a JSON object
out of the reply (handles ```` ```json ```` fences or bare braces). Every
one-shot (non-agentic) LLM call in this codebase — research and guide — goes
through this same function.

## 5. `04-clone-target-repo.mjs` — getting a working copy of the target repo

Runs before the guide step (not after — see the comment at the top of this
file for why: the guide needs to see the *real* repo before it can plan
realistic sections). Two ideas worth understanding:

- **Shared base clone.** Every run doesn't clone fresh — there's one
  persistent clone at `WORKDIR_ROOT/_base`, kept in sync with a cheap
  fetch+reset, and each run gets its own isolated `git worktree` off that
  base. `withBaseCloneLock()` in this file serializes the sync step so two
  runs starting close together don't race on `_base`.
- **Pristine file snapshot.** Right after the worktree is created,
  `listTrackedFiles()` snapshots every file that existed *before* this run
  touched anything. That snapshot (`pristineFiles`) is what the write guard
  (§8) checks against later — it's how the system knows "this file already
  existed, never let the agent overwrite it."

The actual git primitives (`cloneShallow`, `syncBaseToLatest`, `addWorktree`,
`listTrackedFiles`, `commitPaths`, `push`, `removeWorktree`) all live in
[`src/git/clone-and-commit.mjs`](src/git/clone-and-commit.mjs) — plain `spawn("git", [...])` calls, no
git library.

## 6. `03-generate-guide.mjs` — the content/section plan (second LLM call)

This is where the campaign brief becomes an actual page plan: a hero title,
SEO fields, and an ordered list of sections (each just `{type, summary}`).
Two things feed into the prompt that are easy to miss:

- `detectRepoConventions()` (private helper, top of this file) does a
  cheap scan of the freshly-cloned repo — reads `package.json`/
  `composer.json`, lists top-level directories — so the prompt describes
  what the repo *actually is* (Next.js? Laravel? something else?) instead of
  assuming React.
- `resolveSectionReferences()`, imported from
  [`src/design-catalog/resolve-references.mjs`](src/design-catalog/resolve-references.mjs), pulls real file content
  out of the cloned repo for every section type in the fixed catalog (see
  next paragraph), so the model is choosing sections having actually *seen*
  real examples, not guessing blind.

The fixed section-type list itself — `SECTION_TYPES` — lives in
[`src/design-catalog/section-types.mjs`](src/design-catalog/section-types.mjs) as a Zod enum. This is
deliberate: the model can only ever choose from `["hero", "details",
"timeline", "testimonials", "faq", "curriculum", "pricing", "instructor",
"footer-cta"]` — it cannot invent a new section type, because the response
is validated (`validateGuide`, `schemas/content-guide-schema.mjs`) against that
enum and retried once on failure.

[`src/design-catalog/reference-examples.mjs`](src/design-catalog/reference-examples.mjs) is the human-curated map this
all reads from: `{ [sectionType]: { referenceFiles: [...], note: "..." } }`
— real paths inside the target repo. **This file needs to be hand-edited
per target repo** (see module.md Module 7) — it currently has placeholder
paths and needs walking against whatever repo this service actually targets.

## 7. `05-classify-sections.mjs` — no LLM call at all

This is the step people most often assume is another AI call, and it isn't.
[`src/sections/classify-sections.mjs`](src/sections/classify-sections.mjs)'s `classifySections()` is pure,
deterministic code: for each section the guide chose, decide `"static"` or
`"ai-required"`:

- `hero` is **always** ai-required (no static candidate ever exists for it).
- Anything in the campaign brief's `aiRequiredSections` list is ai-required.
- Otherwise: static if [`src/design-catalog/static-frame-catalog.mjs`](src/design-catalog/static-frame-catalog.mjs) has a
  real component candidate for that type, ai-required if it doesn't.

`static-frame-catalog.mjs` is the other design-catalog file — don't confuse
it with `reference-examples.mjs` above. `reference-examples.mjs` gives the
LLM *inspiration* (real files to read, never reused verbatim).
`static-frame-catalog.mjs` gives static sections an *actual reusable
component* (`{id, component, importPath, defaultData, fillableFields}` per
candidate) that gets templated with zero LLM involvement — see the next step.

## 8. `06-generate-sections.mjs` — the fan-out, and this is where guardrails matter most

This step wraps the real dispatcher, [`src/sections/generate-sections.mjs`](src/sections/generate-sections.mjs)'s
`generateSections()`. Every classified section is generated **independently
and concurrently** (`Promise.all`) — this replaced an older design where one
LLM call wrote the whole page in one pass:

- **Static sections** → [`src/sections/fill-static-frame.mjs`](src/sections/fill-static-frame.mjs)'s
  `populateFrame()`. No LLM. Pure templating: campaign copy (from the guide)
  is validated against the candidate's `fillableFields` Zod schema, merged
  over the candidate's `defaultData`, and a small wrapper component is
  emitted that imports the real frame component and renders it with that
  merged data. If a candidate has no `fillableFields`/`defaultData` at all
  (e.g. a testimonials block that depends on photos), it renders bare.
- **Ai-required sections** (always includes the hero) → one independent call
  to `runCodingAgent()` (§8a below), scoped to write **exactly one file**.

Both paths converge on [`src/sections/compose-page.mjs`](src/sections/compose-page.mjs)'s `composePage()`,
which deterministically writes the final `page.tsx` importing every section
in order — this composition step is never agent-written, so it's always
exactly consistent with what actually got generated.

Two more files worth knowing about here:
- [`src/sections/section-agent-prompt.mjs`](src/sections/section-agent-prompt.mjs) builds the system prompt for one
  section's agent run. For the hero specifically, it pulls in
  [`src/sections/hero-contract.mjs`](src/sections/hero-contract.mjs), which threads the lead-capture form
  contract (`src/leadform/contract.mjs` — fields, honeypot, submission
  target) into the prompt, since the hero is the one section that always
  needs a working lead form.
- [`src/pipeline/steps/find-existing-imports.mjs`](src/pipeline/steps/find-existing-imports.mjs) only does anything on a
  **retry** (i.e. `verifyReport` is set from a previous failed attempt): it
  greps the cloned repo for real, working import lines of whatever package
  the last verify failure said couldn't be resolved, and hands those over
  as ground truth — "don't guess the import path, here's exactly how this
  repo already imports this package elsewhere."

### 8a. The coding agent loop — `src/llm/coding-agent.mjs`

This is the "agentic" part of the codebase: a multi-turn tool-calling loop,
provider-switchable (`CODING_AGENT_PROVIDER=claude|gemini`, independent of
the one-shot provider), implemented twice (`runClaudeCodingAgent` /
`runGeminiCodingAgent`) behind one shared `runCodingAgent()` entry point.
Both implementations follow the identical shape:

1. Send the system prompt + task prompt, with the tool definitions
   (`TOOL_DEFINITIONS`, from `filesystem-tools.mjs`) attached.
2. The model responds with zero or more tool calls (`list_files`,
   `read_file`, `write_file`, or `finish_coding`).
3. Each tool call is executed for real via `createToolExecutor()`'s
   `execute()` (§8b) and the result is fed back as the next turn's input.
4. Repeat until the model calls `finish_coding`, or `maxIterations` (default
   40, from `MAX_AGENT_ITERATIONS`) is hit — hitting the cap without
   `finish_coding` is treated as a hard failure by the caller, never
   silently proceeds to verify.

Termination is **only** the explicit `finish_coding` tool call — never "the
model just stopped calling tools," which would be fragile and give no
structured summary for the PR body.

### 8b. The write guard — `src/llm/filesystem-tools.mjs` (read this file carefully)

This is the single most safety-critical file in the service — it's the
LLM's *entire* interface to the filesystem, and it's what makes it safe to
let an LLM write files into someone else's real repository unsupervised.
There is deliberately no shell-exec tool at all.

`resolveWritePath()` is a pure function (no I/O — fully unit-tested in
`test/write-tool-allowlist.test.mjs`) that every `write_file` call must pass
through **four independent layers**, checked in this exact order:

1. **Containment** — the requested path must resolve inside the workdir; no
   absolute paths, no `..` traversal out of the repo.
2. **Pristine-file protection** — if the path existed *before this run*
   (the `pristineFiles` snapshot from §5's clone step) and the agent hasn't
   written it itself earlier in this same run, it's rejected outright. The
   agent can only ever create new files, never modify what was already there.
3. **Allowlist** — the path must start with one of the human-configured
   `WRITE_PATH_ALLOWLIST` prefixes (`.env`, resolved per-slug in
   `config.resolveAllowlist()`). This is the operator-set boundary, not
   something a campaign brief or the model can widen.
4. **Manifest match** — if a specific set of expected file paths was
   declared for this call (`manifestPaths`), the write must match one of
   them exactly.

Each layer is independent on purpose — a hole in one doesn't defeat the
others. `createToolExecutor()` in the same file wraps this guard plus
`list_files`/`read_file` into the actual tool implementations the agent
loop calls.

**This same guard is reused, not duplicated, by non-agent writers.**
[`src/sections/write-guarded-file.mjs`](src/sections/write-guarded-file.mjs)'s `writeGuardedFile()` calls
`resolveWritePath()` directly so that static section files and the composed
`page.tsx` — neither of which the LLM writes — go through the identical
containment/pristine/allowlist checks as the agent's own writes, for
consistency rather than because they need it.

## 9. `07-verify.mjs` — the deterministic gate, and the retry loop

Once `codeFinished` is true (every section either templated or finished by
its agent), this step runs [`src/verify/run-full-verify-suite.mjs`](src/verify/run-full-verify-suite.mjs), which
coordinates, in order:

1. **Build + lint** ([`src/verify/build-and-lint.mjs`](src/verify/build-and-lint.mjs)) — installs deps and
   runs the target repo's own build/lint scripts. Fails fast here before
   bothering with anything else. Ecosystem detection
   (npm/yarn/pnpm) lives in [`src/verify/detect-package-manager.mjs`](src/verify/detect-package-manager.mjs);
   Docker-vs-host build selection lives in `verify/docker-build.mjs`.
2. Only if that passes, and only if the repo is Node-servable with a
   configured `PAGE_URL_PATH_TEMPLATE`: an ephemeral server is started
   ([`src/verify/ephemeral-server.mjs`](src/verify/ephemeral-server.mjs) — request-scoped, always torn
   down, distinct from the longer-lived preview in §11) and three checks run
   against it together, in parallel, against one real page load:
   [`check-hero-visibility.mjs`](src/verify/check-hero-visibility.mjs) (hero fits above the fold, both
   viewport sizes), [`check-seo-tags.mjs`](src/verify/check-seo-tags.mjs), and
   [`check-accessibility.mjs`](src/verify/check-accessibility.mjs) (axe-core).

If verify fails and `codeAttempts < MAX_CODE_ATTEMPTS`, the graph's
conditional edge (`routeAfterVerify` in `run-campaign-pipeline.mjs`) routes
straight back to `generate_sections` — **not** back to classify or guide,
since mode/frameId don't change just because a build broke — carrying the
failure report forward so §8's `find-existing-imports.mjs` and the retry
prompt can react to it. Exhausting retries routes to `END` with
`status: "failed_verification"`.

## 10. `08-stage-draft.mjs` and `09-start-preview.mjs` — the last two graph nodes

`stage-draft` writes every generated file's content into the database as a
new version ([`src/staging/draft-versions.mjs`](src/staging/draft-versions.mjs)'s `stageNewVersion()`) —
**this, not the scratch worktree on disk, is the durable record** a human
review reads from. Each file is tagged with its `sectionSlot` (a positional
id like `"section-0"`) so a later per-section refine (§12) can version just
one slot.

`start-preview` boots a longer-lived server a human can actually click
through in a browser ([`src/preview/preview-server.mjs`](src/preview/preview-server.mjs) — Docker-first,
process-fallback, DB-tracked with an idle-timeout sweep). This step is
non-fatal by design: if it fails, the run still ends up `staged_for_review`,
since preview is a convenience on top of an already-verified draft, not a
gate.

**The graph ends here.** `runCodegen()` back in `run-campaign-pipeline.mjs`
sets the run's status to `"staged_for_review"` and returns. Nothing has been
committed, pushed, or opened as a PR yet.

---

## 11. Human review — outside the graph entirely

Two things can happen to a `staged_for_review` run, both driven by separate,
later HTTP requests (`server.mjs`):

- **Refine one section**: `POST /campaigns/:runId/sections/:slot/refine` →
  [`src/pipeline/refine-section.mjs`](src/pipeline/refine-section.mjs)'s `refineSection()`. Four actions
  (`use-different-frame`, `modify`, `redesign`, `new`) — each touches only
  the one slot, then **re-runs the full verify suite against the whole
  page** (a section swap can affect page-wide hero-fit/SEO/a11y), and only
  on success stages a new draft version and restarts the preview. Reuses
  the exact same building blocks as §8 (`runCodingAgent`,
  `buildSectionAgentSystemPrompt`, `writeGuardedFile`, `composePage`) —
  nothing here is a separate code path, just a different entry point into
  the same pieces.
- **Approve or abandon**: `POST /campaigns/:runId/approve` or `/abandon` →
  [`src/pipeline/approve-or-abandon-run.mjs`](src/pipeline/approve-or-abandon-run.mjs). `approveRun()`
  reconstructs a graph-shaped state object from the database (the original
  LangGraph in-process state is long gone by now — no checkpointer) and
  calls `commit()` → `push()` → `openPr()`, imported from
  [`src/pipeline/steps/commit-push-and-open-pr.mjs`](src/pipeline/steps/commit-push-and-open-pr.mjs) — the same functions
  that used to be graph nodes before the review gate existed. `commitPaths`/
  `push` are `git/clone-and-commit.mjs`; `createPullRequest` is
  [`src/github/open-pull-request.mjs`](src/github/open-pull-request.mjs), a plain GitHub REST call.
  `abandonRun()` just stops the preview and tears down the worktree —
  nothing is ever committed.

**Nothing reaches git before one of these two calls happens.** That's the
whole point of splitting this out of the graph.

---

## 12. Persistence — where all of this actually gets stored

Every step above calls `runStore.heartbeat()` / `.updateRun()` /
`.appendLog()` throughout — that's [`src/state/campaign-repository.mjs`](src/state/campaign-repository.mjs), a
one-line re-export of the real implementation,
[`src/state/sqlite-campaign-repository.mjs`](src/state/sqlite-campaign-repository.mjs). Every other module imports
the re-export, never the concrete file directly — swapping storage backends
later means changing that one export line, not every call site.

[`src/state/database-schema.mjs`](src/state/database-schema.mjs) defines the tables (idempotent
`CREATE TABLE IF NOT EXISTS`, no migration framework): `campaigns`, `runs`,
`run_logs`, `draft_files`, `verify_reports`, `validation_reports`,
`previews`, `review_decisions`, `token_usage`.
[`src/state/database-connection.mjs`](src/state/database-connection.mjs) opens the one shared `node:sqlite`
connection (WAL mode) the whole process uses.

---

## 13. The UI (separate app, not part of this flow)

`ui/` is a standalone React + Vite SPA that talks to `server.mjs` purely
over HTTP — it never imports anything from `src/` directly. `NewCampaignPage`
posts a brief, `RunDetailPage` polls run status and exposes the sections
gallery (refine) and approve/abandon buttons, `CampaignListPage` lists runs.
Worth a skim once the backend flow above makes sense, but it's a consumer of
the API, not part of the pipeline itself.

---

## Quick-reference: "I want to see the code for X"

| You want to understand... | Start here |
|---|---|
| How a request comes in | `src/server.mjs` |
| The state machine / step order | `src/pipeline/run-campaign-pipeline.mjs` |
| Research / content planning prompts | `src/pipeline/steps/02-research.mjs`, `03-generate-guide.mjs` |
| How git cloning/branching works | `src/pipeline/steps/04-clone-target-repo.mjs`, `src/git/clone-and-commit.mjs` |
| Static vs AI section decision | `src/sections/classify-sections.mjs` |
| The coding agent's tool loop | `src/llm/coding-agent.mjs` |
| **The write-safety guardrails** | `src/llm/filesystem-tools.mjs` |
| Static section templating | `src/sections/fill-static-frame.mjs`, `src/design-catalog/static-frame-catalog.mjs` |
| Build/lint/hero/SEO/a11y checks | `src/verify/run-full-verify-suite.mjs` and its imports |
| Draft versioning / what a human reviews | `src/staging/draft-versions.mjs` |
| Live preview server | `src/preview/preview-server.mjs` |
| Per-section refine (the review UI's core) | `src/pipeline/refine-section.mjs` |
| Approve → commit → push → PR | `src/pipeline/approve-or-abandon-run.mjs`, `src/pipeline/steps/commit-push-and-open-pr.mjs` |
| Database schema | `src/state/database-schema.mjs` |
| Env vars / config | `src/config.mjs`, `.env.example` |
