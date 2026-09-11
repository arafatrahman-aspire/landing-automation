# Full Documentation — Campaign Codegen PR Service

Everything a new developer needs to understand, run, debug, and extend this
project, starting from zero knowledge.
---

## Table of contents

1. [What this project actually is](#1-what-this-project-actually-is)
2. [The safety model (read this before touching anything)](#2-the-safety-model)
3. [Setup from zero](#3-setup-from-zero)
4. [Running the project](#4-running-the-project)
5. [Architecture and the request lifecycle](#5-architecture-and-the-request-lifecycle)
6. [Complete file map](#6-complete-file-map)
7. [Implementation phases, 0 → 10](#7-implementation-phases-0--10)
8. [Configuration reference](#8-configuration-reference)
9. [HTTP API reference](#9-http-api-reference)
10. [Database schema](#10-database-schema)
11. [How to do common tasks](#11-how-to-do-common-tasks)
12. [Debugging a failed run](#12-debugging-a-failed-run)
13. [Testing conventions](#13-testing-conventions)
14. [Known gaps and deliberate non-goals](#14-known-gaps-and-deliberate-non-goals)

---

## 1. What this project actually is

This service takes a **marketing campaign brief** (a form: campaign name,
offer, audience, call-to-action) and produces a **pull request on a different
repository** containing a complete, working landing page for that campaign.

It is a standalone service. It never modifies its own codebase. The repository
it writes into — "the target repo", currently `atss-frontend` — is a separate
Next.js project that it clones, writes new files into, builds, and opens a PR
against.

**The one-sentence mental model:** *a brief goes in one end, a reviewed pull
request comes out the other, and a human must click approve before anything
touches git.*

### The three things that make this non-trivial

1. **An LLM writes real code into someone else's repository.** That demands
   hard guardrails, not prompt politeness. See §2.
2. **Generated code must actually build.** An LLM confidently produces code
   that doesn't compile. A deterministic verify suite (build, lint, layout,
   SEO, accessibility) is the gate, plus a targeted repair loop.
3. **Not everything should be AI-generated.** Most sections are assembled from
   real, existing components in the target repo with no LLM involved at all.
   Only the hero (and anything explicitly flagged) is written by an agent. This
   is the "Hybrid Section Assembly" design and it's the single most important
   architectural idea in the project.

### Vocabulary you need

| Term | Meaning |
|---|---|
| **Target repo** | The external repo we write into (`atss-frontend`). Never this repo. |
| **Run** | One execution of the pipeline for one campaign brief. Identified by a `runId` (UUID). |
| **Brief** | The human-submitted campaign input. Validated by `campaign-brief-schema.mjs`. |
| **Guide** | The LLM-produced content/section plan: hero title, SEO fields, ordered section list. |
| **Section** | One block of the page (hero, faq, pricing…). Drawn from a fixed enum of 9 types. |
| **Static section** | Assembled from an existing component ("frame") in the target repo. **No LLM.** |
| **AI-required section** | Written from scratch by the coding agent. Always includes the hero. |
| **Frame** | A real, reusable component in the target repo that a static section wraps. |
| **Slot** | A section's positional identity (`section-0`, `section-1`…). Stable across type changes. |
| **Worktree** | The run's private checkout of the target repo (a `git worktree`, not a full clone). |
| **Pristine files** | Snapshot of every file that existed before the run started. Never writable. |
| **Allowlist** | Human-configured path prefixes the agent may write inside. Nothing else. |
| **Draft** | The generated files stored **in the database**, versioned. This — not the worktree — is what gets committed. |
| **Staged for review** | Terminal-ish state: generation is done, waiting for a human to approve or abandon. |

---

## 2. The safety model

**Read this section before changing any code.** The whole project rests on it.

An LLM is given filesystem tools and told to write code into a real repository.
The only thing standing between that and disaster is
[`src/llm/filesystem-tools.mjs`](src/llm/filesystem-tools.mjs). It is the most
safety-critical file in the service.

### There is deliberately no shell tool

The agent has exactly four tools: `list_files`, `read_file`, `write_file`,
`finish_coding`. It cannot run commands. Build/lint verification is something
the orchestrator does *to* the agent's output, never something the agent can
invoke or influence.

### The four-layer write guard

`resolveWritePath()` is a **pure function** (no I/O — fully unit-testable).
Every write passes all four layers, in this order:

| # | Layer | Rejects |
|---|---|---|
| 1 | **Containment** | Absolute paths, `..` traversal — anything resolving outside the worktree. |
| 2 | **Pristine protection** | Any file that existed before this run started. The agent may only ever *create* files, never modify existing ones. (Exception: files it created itself earlier in the same run, so it can iterate.) |
| 3 | **Allowlist** | Anything outside the operator-configured `WRITE_PATH_ALLOWLIST` prefixes. Not derivable by the AI, not settable by a brief. |
| 4 | **Manifest** | Anything not in the exact set of file paths declared for this specific agent run (each section agent may write exactly ONE file). |

Each layer is independent on purpose: a hole in one does not defeat the others.

**The same guard is reused, never duplicated.** Static sections and the composed
`page.tsx` aren't agent-written, but they go through
[`write-guarded-file.mjs`](src/sections/write-guarded-file.mjs), which calls the
identical `resolveWritePath()`.

`test/write-tool-allowlist.test.mjs` is the most important test in the
repository. **Never weaken it.**

### Nothing reaches git without a human

The pipeline graph *cannot* commit, push, or open a PR. Those functions were
deliberately removed from the state machine (Phase 7). They live in
[`commit-push-and-open-pr.mjs`](src/pipeline/steps/commit-push-and-open-pr.mjs)
and are only ever called by `approveRun()`, triggered by a separate,
later HTTP request after a human clicks approve.

### The database is the source of truth, not the worktree

`commit()` reads the files it commits from the `draft_files` **table**, not from
disk. This means a failed or half-finished run leaves junk in the scratch
worktree harmlessly — it was never staged, so it can never be committed.

---

## 3. Setup from zero

### Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 22** | Developed on **v24.16.0**. Requires `node:sqlite` (Node 22+) and `--env-file`. |
| **git** | Used via `spawn`, no git library. |
| **Docker** *(not used by default)* | Since v0.32 verify and preview run plain host `npm`. Set `VERIFY_DISABLE_DOCKER=false` to build inside the repo's own declared Node image instead. |
| **An LLM API key** | Gemini or Anthropic. Both providers are supported and switchable. |
| **A GitHub token** | Only needed to open real PRs. Not needed in dry-run mode. |

### Install

```bash
git clone <this repo>
cd new_approach
npm install
cd ui && npm install && cd ..
```

Playwright's browser is needed for the layout/SEO/accessibility checks:

```bash
npx playwright install --with-deps chromium
```

If this fails (restricted network), the service still runs — build and lint
still gate, and the browser checks report as skipped.

### Configure

```bash
cp .env.example .env
```

Then edit `.env`. The **minimum** to boot:

```bash
API_SHARED_SECRET=<any string, 16+ chars>
GEMINI_API_KEY=<your key>          # or ANTHROPIC_API_KEY
GITHUB_TARGET_OWNER=<owner>
GITHUB_TARGET_REPO=<repo>
WRITE_PATH_ALLOWLIST=src/app/campaigns/{slug}/
```

Config is validated by Zod at import time — a missing or malformed variable
**refuses to start** with a precise message, rather than failing mysteriously
mid-run. Full reference in §8.

> **Critical setup step:** `WRITE_PATH_ALLOWLIST` must match the target repo's
> real structure. A real production bug (v0.18) was caused by it saying
> `app/campaigns/{slug}/` when the repo actually uses `src/app/`. The generated
> page landed outside the App Router tree and Next.js failed with *"doesn't have
> a root layout"*. **Look at the real repo before setting this.**

---

## 4. Running the project

### The safe way to run it first (dry run, no GitHub)

Do this before ever pointing it at a real repository. It exercises the entire
pipeline — including a real LLM coding session — against a throwaway local repo.

```bash
# 1. Turn any small repo with a package.json "build" script into a local "remote"
git init --bare -b main /tmp/fixture.git
git push /tmp/fixture.git main      # from a working copy with an initial commit

# 2. In .env:
TARGET_REPO_CLONE_URL=/tmp/fixture.git   # overrides the github.com URL
DRY_RUN_NO_PR=true                       # skips the real GitHub API call
GITHUB_TOKEN=                            # not needed in this mode
```

`DRY_RUN_NO_PR=true` still clones, generates, verifies, commits and **pushes for
real** — it only skips the PR API call. Combined with a local fixture URL,
nothing can reach a real repository.

### Start the backend

```bash
npm start          # node --env-file=.env src/server.mjs
npm run dev        # same, with --watch for auto-restart
```

Listens on `PORT` (default **4300**). Confirm with:

```bash
curl localhost:4300/healthz          # {"ok":true}
```

### Start the UI

```bash
cd ui
npm run dev        # Vite dev server, separate port
```

The UI is a standalone React SPA that talks to the backend purely over HTTP. It
will prompt for the `API_SHARED_SECRET` and keeps it in `sessionStorage`.

### Fire a campaign

Via the UI ("New campaign"), or:

```bash
./post.sh                      # uses the brief hardcoded in the script
./post.sh my-campaign-slug     # override just the slug
```

Or raw:

```bash
curl -X POST http://localhost:4300/campaigns \
  -H "Authorization: Bearer $API_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"slug":"test-campaign","campaignName":"Test","offer":"...","audience":"...","cta":"..."}'
```

Returns `202` immediately with a `runId`; the pipeline runs in the background.
Poll `GET /campaigns/:runId` or watch the UI's live log.

### Run the tests

```bash
npm test           # node --test — 33 files, ~206 tests, no network, no LLM
```

Expect **8 skips** — they're environment-dependent (Playwright browser, PHP,
Docker) and pre-existing, not failures.

### Iterate on the agent alone

```bash
node --env-file=.env dev/run-agent-standalone.mjs
```

Runs the coding loop against a temp fixture folder and prints the transcript
plus which files it wrote. No git, no GitHub.

---

## 5. Architecture and the request lifecycle

### What LangChain does here — and what it does not

The project depends on `@langchain/langgraph`, used for **exactly one thing**:
the `StateGraph` in
[`run-campaign-pipeline.mjs`](src/pipeline/run-campaign-pipeline.mjs) that
decides which step runs next.

**Every actual LLM call is a hand-rolled `fetch()`** to the Anthropic or Gemini
HTTP API, in [`llm/generate-text.mjs`](src/llm/generate-text.mjs) and
[`llm/coding-agent.mjs`](src/llm/coding-agent.mjs). No LangChain model wrapper,
no LangChain tool abstraction, no LangChain memory.

> **LangGraph = "what runs next." Plain fetch = "what the LLM says."**

### The pipeline

```
intake → research → clone → generate_guide → classify_sections
       → generate_sections → verify ──┬─ fail, retries left ──→ back to generate_sections
                                       │
                                       ├─ pass ──────────────→ stage_draft → preview_build → END
                                       │
                                       └─ fail, exhausted ───→ END  (or stage_draft, if
                                                                     CONTINUE_ON_VERIFY_FAILURE)
```

The graph **ends at `preview_build`**, always. Status becomes
`staged_for_review`. Commit/push/PR happen later, from a separate request, only
after human approval.

### Step by step

| # | Step | LLM? | What it does |
|---|---|---|---|
| 1 | `01-intake` | no | Marks the run started. |
| 2 | `02-research` | **yes** | Web-search research → keywords, pain points, FAQ questions. Skippable (`SKIP_RESEARCH`). Cached for crash resume. |
| 3 | `04-clone-target-repo` | no | `git worktree` off a shared base clone. Snapshots **pristine files**. |
| 4 | `03-generate-guide` | **yes** | Produces the content/section plan. Sections constrained to a fixed Zod enum — the model *cannot* invent a section type. Validated, retried once. Cached for crash resume. |
| 5 | `05-classify-sections` | **no** | Decides static vs. AI per section. Also preflights that each frame **actually exists** in this checkout. |
| 6 | `06-generate-sections` | **yes (partly)** | Fan-out. Static → pure templating. AI-required → one independent agent run each, scoped to one file. All concurrent. Then composes `page.tsx` deterministically. |
| 7 | `07-verify` | no | Build + lint, then hero-fit / SEO / accessibility against one real page load. |
| 8 | `08-stage-draft` | no | Writes generated file contents into `draft_files`, tagged per slot. |
| 9 | `09-start-preview` | no | Boots a long-lived preview server. Non-fatal if it fails. |

> **Why `clone` runs before `generate_guide`:** the target repo's stack isn't
> fixed. The guide step scans the real repo (`package.json`, `composer.json`,
> top-level dirs) so it plans against what the repo *actually is* instead of
> assuming React.

### Static vs AI — the decision

In [`classify-sections.mjs`](src/sections/classify-sections.mjs):

1. `hero` → **always AI**. Never has a static candidate.
2. Anything in the brief's `aiRequiredSections` → **AI**.
3. Otherwise → **static** if the frame catalog has a candidate that really
   exists in this checkout; **AI** if not.

That last clause matters: a catalog entry pointing at a component the repo
doesn't have would otherwise produce an unresolvable import and a build failure
the retry loop could *never* fix (static sections are templated, not
agent-written, so a retry regenerates the identical broken import). Graceful
degradation instead. See v0.23.

### The retry loop (important)

When verify fails, the retry is a **targeted repair**, not a re-roll:

1. [`failing-files.mjs`](src/verify/failing-files.mjs) parses the build report
   for the files it actually blames.
2. Sections **not** blamed are skipped entirely; their previous result is
   carried forward. (Regenerating a section that already compiled is how retries
   used to turn one broken file into a *different* broken file.)
3. A blamed section goes into **repair mode**: *"your previous attempt is
   already at this path and failed with this error — read it, change as little
   as possible."*
4. If nothing can be attributed, it falls back to regenerating everything.

### The human gate

A `staged_for_review` run can go three ways:

- **Refine one section** — `refine-section.mjs`, four actions
  (`use-different-frame`, `modify`, `redesign`, `new`). Touches one slot,
  re-runs **full-page** verify, stages a new version, restarts the preview.
- **Approve** — commit → push → open PR. The only path to git.
- **Abandon** — stops the preview, removes the worktree, commits nothing.

---

## 6. Complete file map

```
src/
├── config.mjs                  Zod-validated env loading. Read once at import.
├── server.mjs                  Express API — the only HTTP entry point.
│
├── llm/                        LLM calls (plain fetch, no SDKs)
│   ├── generate-text.mjs         One-shot text/JSON (research, guide)
│   ├── coding-agent.mjs          The agentic tool loop (Claude + Gemini)
│   └── filesystem-tools.mjs      ★ THE WRITE GUARD. Read §2.
│
├── pipeline/                   Orchestration
│   ├── run-campaign-pipeline.mjs   LangGraph StateGraph + runCodegen()
│   ├── approve-or-abandon-run.mjs  The human gate → commit/push/PR
│   ├── refine-section.mjs          Per-section refinement (the review action)
│   ├── resume-interrupted-runs.mjs Crash resume on boot
│   └── steps/                      One file per pipeline stage
│       ├── 01-intake.mjs … 09-start-preview.mjs
│       ├── commit-push-and-open-pr.mjs   NOT graph nodes; post-approval only
│       ├── find-existing-imports.mjs     Retry helper: real import examples
│       ├── detect-typescript-strictness.mjs  Repo's tsconfig → prompt rules
│       ├── log-helper.mjs                logStage()
│       └── index.mjs                     Re-export barrel
│
├── sections/                   Section assembly
│   ├── classify-sections.mjs     static vs ai-required decision (pure)
│   ├── fill-static-frame.mjs     Pure templating, no LLM
│   ├── generate-sections.mjs     The fan-out dispatcher
│   ├── compose-page.mjs          Path/slot helpers + deterministic page.tsx
│   ├── section-agent-prompt.mjs  System prompt for one section
│   ├── hero-contract.mjs         Hero-specific requirements + lead form
│   └── write-guarded-file.mjs    Non-agent writes, same guard
│
├── design-catalog/             Knowledge about the target repo's components
│   ├── section-types.mjs         The fixed 9-type Zod enum
│   ├── reference-examples.mjs    Section type → real files (LLM grounding)
│   ├── resolve-references.mjs    Reads those files out of the clone
│   ├── static-frame-catalog.mjs  Section type → reusable component candidates
│   └── resolve-frame-file.mjs    Does this frame really exist here?
│
├── verify/                     The QA gate
│   ├── run-full-verify-suite.mjs  Coordinator
│   ├── build-and-lint.mjs         Install + build + lint
│   ├── docker-build.mjs           Build inside the repo's own Node image
│   ├── detect-package-manager.mjs npm/yarn/pnpm detection
│   ├── ephemeral-server.mjs       Request-scoped server for the checks
│   ├── check-hero-visibility.mjs  Hero above the fold, 2 viewports
│   ├── check-seo-tags.mjs         SEO tags
│   ├── check-accessibility.mjs    axe-core
│   ├── failing-files.mjs          Which files did the build blame?
│   └── summarize-report.mjs       Strip npm noise from a failure report
│
├── state/                      Persistence (SQLite)
│   ├── campaign-repository.mjs      ★ The ONLY import surface. Re-export.
│   ├── sqlite-campaign-repository.mjs  Concrete implementation
│   ├── database-schema.mjs          Idempotent schema + additive migrations
│   └── database-connection.mjs      One shared connection, WAL mode
│
├── staging/draft-versions.mjs  Versioned generated files (what gets committed)
├── preview/
│   ├── preview-server.mjs      Long-lived preview server (host npm by default)
│   └── frameable-proxy.mjs     Strips X-Frame-Options so the UI can iframe it
├── git/clone-and-commit.mjs    All git operations (spawn, no library)
├── github/open-pull-request.mjs GitHub REST — PR creation only
├── schemas/                    campaign-brief-schema, content-guide-schema
└── leadform/contract.mjs       Lead form fields, honeypot, preview sink

ui/                             React + Vite SPA (talks to the API only)
test/                           33 files, ~206 tests
dev/run-agent-standalone.mjs    Agent loop without git/GitHub
post.sh, test-api.sh            curl helpers
```

---

## 7. Implementation phases, 0 → 10

This is the historical plan from `new_plan.md` §6. **Phase numbering here is
canonical** and matches `documentation.md`'s changelog labels.

| Phase | Deliverable | Status |
|---|---|---|
| **0** | Core pipeline: intake → research → guide → manifest → clone → code, with the 4-layer write guard | ✅ v0.1 |
| **1** | Design-context catalog + resolver; fixed section enum in the guide schema | ✅ v0.3 — reference paths still unverified against the real repo |
| **2** | Deterministic verify suite: build/lint + hero-fit, SEO, a11y | ✅ v0.5 — browser checks never run against real Chromium in this sandbox |
| **3** | Database staging layer: `draft_files`, `runs`, versioning | ✅ v0.11, extended v0.17 with per-slot versioning |
| **4** | Preview sandbox: containerized, port registry, idle teardown | ✅ v0.15 |
| **5** | LLM validation layer (design/content judgment report) | ❌ **Superseded.** The per-section gallery review replaced the need. |
| **6** | Review workflow: approve / edit / reject / abandon | ❌ **Superseded as scoped** (no raw-file editor). The underlying need was met by Phase 7 + 9. |
| **7** | Commit/push/PR fire only after approval | ✅ v0.19 — the real human gate |
| **8** | Lead form contract: honeypot, conditional job field, preview no-op sink | ✅ v0.20 — real lead endpoint is an external dependency, not built |
| **9** | Marketing-facing review UI: creation, preview, per-section refine | ✅ v0.21 |
| **10** | Observability, hardening, runbooks | 🔶 **Partial** — basic `/healthz` only; no cost tracking, no alerting |

### Work after the phase plan

The phase table stops at 10, but real usage drove more work. From
`documentation.md`:

| Version | What |
|---|---|
| v0.22 | Full `src/` readability restructure (renames + file splits, no behavior change) |
| v0.23 | Root-caused the "always failing" build (untracked frames + missing `"use client"`); crash resume; animated log console |
| v0.24 | Log was hiding every build error (500-char slice was all npm noise); verify history persisted; `deleteRun` foreign-key bug |
| v0.25 | **Targeted repair retries** — the fix that makes runs converge |
| v0.27 | `CONTINUE_ON_VERIFY_FAILURE` escape hatch |

### If you're rebuilding this from scratch

Build in this order — each layer is useless without the one before it:

1. **Config + state** (`config.mjs`, `state/`). Everything depends on these.
2. **The write guard** (`llm/filesystem-tools.mjs`) **and its tests.** Before
   any LLM call exists. This is the foundation of the safety model.
3. **Git operations** (`git/clone-and-commit.mjs`) against a local bare fixture.
4. **The LLM layer** (`llm/generate-text.mjs`, then `coding-agent.mjs`).
5. **The pipeline skeleton** — graph + steps, ending at verify.
6. **The verify suite.** Build/lint first; browser checks after.
7. **Section assembly** — the catalog, classification, static templating, fan-out.
8. **Staging + preview**, then the **human gate**, then the **UI**.
9. **Only then** the resilience work: targeted repair, crash resume, report
   summarization. These are all responses to real observed failures — don't
   build them speculatively.

---

## 8. Configuration reference

All variables live in `.env`, validated by `src/config.mjs`. Anything invalid
prevents startup.

### Required

| Variable | Notes |
|---|---|
| `API_SHARED_SECRET` | Bearer token for every `/campaigns*` route. Min 16 chars. This service can push code — never run it unauthenticated. |
| `GITHUB_TARGET_OWNER` / `GITHUB_TARGET_REPO` | The target repo. |
| `WRITE_PATH_ALLOWLIST` | Comma-separated path prefixes, `{slug}` substituted per run. **Set this by looking at the real repo.** Layer 3 of the write guard. |
| `GEMINI_API_KEY` *or* `ANTHROPIC_API_KEY` | Whichever provider(s) you select below. |
| `GITHUB_TOKEN` | Required unless `DRY_RUN_NO_PR=true`. |

### LLM

| Variable | Default | Notes |
|---|---|---|
| `AI_PROVIDER` | `gemini` | One-shot stages (research, guide). `gemini` \| `claude` |
| `CODING_AGENT_PROVIDER` | `claude` | The agentic loop. Independent of the above — you can mix. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | |
| `CLAUDE_MODEL` | `claude-sonnet-5` | |
| `CODING_AGENT_MODEL` | *(falls back to the provider's model)* | |
| `MAX_AGENT_ITERATIONS` | `40` | Tool-loop cap per section. Hitting it without `finish_coding` is a hard failure. |
| `MAX_CODE_ATTEMPTS` | `3` | Generation attempts including retries. Raised from 2 in v0.25 once retries became cheap targeted repairs. |
| `SKIP_RESEARCH` | `false` | Skips the research call for fast iteration. |

### Verify

| Variable | Default | Notes |
|---|---|---|
| `PAGE_URL_PATH_TEMPLATE` | *(unset)* | e.g. `/campaigns/{slug}` — must match the route `WRITE_PATH_ALLOWLIST` produces. **Unset ⇒ hero-fit/SEO/a11y are skipped entirely** (build/lint still runs) **and the preview opens the target repo's home page instead of the campaign.** Set it. |
| `VERIFY_DISABLE_DOCKER` | `true` | **Default since v0.32.** Verify and preview run the repo's own `npm ci` / `npm run build` / `npm run start` on this host. Set to `false` to build inside the repo's Dockerfile image instead — sidesteps host/repo Node version mismatches, but was the largest single source of failed runs (image pulls, bind-mount permissions, containers outliving the process that spawned them). |
| `PACKAGE_MANAGER_OVERRIDE` | *(auto)* | `npm`\|`yarn`\|`pnpm`. Set when lockfile detection picks wrong. |
| `VERIFY_INSTALL_TIMEOUT_MS` | `300000` | |
| `VERIFY_BUILD_TIMEOUT_MS` | `600000` | |
| `VERIFY_SERVER_TIMEOUT_MS` | `30000` | |
| `REVIEW_PLAN_BEFORE_GENERATING` | `true` | Pause after the plan and before generating, so a human can edit the hero copy, SEO tags and section list. Steering here is free; every change after generation costs an AI run per section. Per-campaign override: the brief's `reviewPlan`. |
| `CONTINUE_ON_VERIFY_FAILURE` | `false` | ⚠️ Stage an **unbuildable** draft for review anyway. The run is flagged and the UI warns loudly. Approving one opens a PR with code that does not compile. Temporary unblock, not a normal mode. |

### Preview

| Variable | Default | Notes |
|---|---|---|
| `PREVIEW_TTL_MS` | `1800000` (30 min) | Idle lifetime before the sweep tears it down. |
| `MAX_CONCURRENT_PREVIEWS` | `3` | Soft cap — the oldest is evicted, not refused. |
| `PREVIEW_SWEEP_INTERVAL_MS` | `60000` | |
| `SERVICE_PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Where a previewed page's lead form POSTs. The preview is a *separate process on a different port*, so it can't use a relative path. Set explicitly for any real deployment. |

Every preview also gets a **frameable proxy** on a second port
(`preview/frameable-proxy.mjs`). The target repo sends `X-Frame-Options: DENY`
on every route, so the review UI cannot iframe the preview directly — the proxy
forwards to it and strips that header plus `content-security-policy`. It gets
its own origin rather than a path prefix on the API server so the page's
root-absolute asset URLs (`/_next/static/…`) keep resolving. `previews.url`
points at the real server (open in a new tab); `previews.embed_url` points at
the proxy (what the iframe loads). Nothing to configure; it starts and stops
with the preview it fronts.

### Git / target repo

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_BASE_BRANCH` | `main` | |
| `GITHUB_API_URL` | `https://api.github.com` | |
| `TARGET_REPO_CLONE_URL` | *(constructed)* | Override with a local path for safe dry runs. |
| `DRY_RUN_NO_PR` | `false` | Skips only the PR API call. Still clones, generates, verifies, commits, pushes. |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | bot defaults | |

### Storage / lifecycle

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4300` | |
| `DB_PATH` | `./data/campaigns.db` | Created automatically. |
| `WORKDIR_ROOT` | `./data/.scratch` | Base clone + per-run worktrees. |
| `KEEP_WORKDIR_ON_FAILURE` | `false` | Keep the scratch worktree after a failure — **essential for debugging**. |
| `RESUME_INTERRUPTED_RUNS` | `true` | Re-drive runs interrupted by a restart, reusing cached research/guide. Never resumes anything mid-commit/push. |

---

## 9. HTTP API reference

Every route except `/healthz` and the lead sink requires
`Authorization: Bearer $API_SHARED_SECRET`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness. No auth. |
| `GET` | `/campaigns` | List all runs. |
| `POST` | `/campaigns` | Create a campaign. Validates the brief, returns `202` + `runId`, runs in background. |
| `GET` | `/campaigns/:runId` | Full run state (status, stage, guide, section results, log tail). |
| `GET` | `/campaigns/:runId/log` | Full run log as `text/plain`. |
| `GET` | `/campaigns/:runId/draft` | Latest staged draft (paths + contents). |
| `GET` | `/campaigns/:runId/sections` | Section gallery: each slot's type/mode/frame + available alternatives. |
| `POST` | `/campaigns/:runId/sections/:slot/refine` | Refine one slot. Body: `{action, ...params}`. |
| `GET` | `/campaigns/:runId/brief` | The brief a run was created from, for duplicating it (slug withheld). |
| `GET` | `/campaigns/:runId/plan` | The content plan, with per-section build mode and layout choices. |
| `PATCH` | `/campaigns/:runId/plan` | Save an edited plan without approving it. 409 outside `awaiting_plan_approval`. |
| `POST` | `/campaigns/:runId/plan/approve` | Save any final edit and start generating. |
| `POST` | `/campaigns/:runId/plan/abandon` | End the run at the gate; nothing was generated. |
| `GET` | `/campaigns/:runId/preview` | Preview status/URL/expiry. |
| `POST` | `/campaigns/:runId/preview/stop` | Stop the preview. |
| `POST` | `/campaigns/:runId/approve` | **The gate.** commit → push → open PR. |
| `POST` | `/campaigns/:runId/abandon` | Terminal; commits nothing. |
| `DELETE` | `/campaigns/:runId` | Delete a terminal run's record. `409` if still in flight. |
| `POST` | `/internal/preview-lead-sink` | No-auth no-op sink for previewed lead forms. Honeypot-aware. |

### Refine actions

| Action | Applies to | Params |
|---|---|---|
| `use-different-frame` | static slots | `frameId` |
| `modify` | ai-required slots | `instructions` |
| `redesign` | any slot (forces AI) | `instructions` |
| `new` | any slot (changes section type) | `sectionType`, optional `instructions` |

Every refine re-runs the **full-page** verify suite — a section swap can affect
page-wide hero-fit/SEO/a11y. On failure nothing is rolled back: `draft_files`,
not the worktree, is what gets committed.

### Run statuses

| Status | Meaning |
|---|---|
| `queued` / `running` | In flight. |
| `staged_for_review` | **Generation done, waiting for a human.** Not terminal. |
| `approved` | Approve accepted, git sequence in progress. |
| `completed` | PR opened (or dry-run equivalent). |
| `failed_verification` | Verify failed and retries were exhausted. |
| `failed_clone` / `failed` | Failed earlier. |
| `failed_push` / `failed_push_incomplete` | Git-phase failure — **check GitHub manually**. |
| `abandoned` | Human declined. |

---

## 10. Database schema

SQLite via `node:sqlite`, WAL mode, one shared connection. The schema is
**idempotent** (`CREATE TABLE IF NOT EXISTS`) with additive migrations via
`addColumnIfMissing()`. There is no migration framework by design.

| Table | Holds |
|---|---|
| `campaigns` | The immutable submitted brief. |
| `runs` | Mutable pipeline state: status, stage, attempts, branch, PR, guide, section results, workdir, research notes, `verify_bypassed`. |
| `run_logs` | Every log line. |
| `draft_files` | **Versioned generated files — what actually gets committed.** Tagged with `section_slot`. |
| `verify_reports` | Per-attempt verify history (added v0.24). |
| `previews` | Live preview processes/containers, plus the frameable proxy's `proxy_port`/`embed_url` (v0.32). |
| `validation_reports` | Declared, unused (Phase 5 superseded). |
| `review_decisions` | Declared, unused. |
| `token_usage` | Declared, **unused** — Phase 10 work. |

**Two rules when changing the schema:**

1. New columns on existing tables go through `addColumnIfMissing()`, *after* the
   `CREATE TABLE` block. An index on a new column must come after that call — an
   inline index would throw on a pre-existing database.
2. `deleteRun` must clear every child table (`CHILD_TABLES_OF_RUNS`). Foreign
   keys are ON; a missed table makes deletion fail outright.

---

## 11. How to do common tasks

### Add a new section type

1. Add it to `SECTION_TYPES` in
   [`design-catalog/section-types.mjs`](src/design-catalog/section-types.mjs).
   This is the Zod enum — the model can only choose from this list.
2. Add a `reference-examples.mjs` entry (real files to ground the LLM).
3. Optionally add candidates to `static-frame-catalog.mjs` so it can be static.
   Without one, it's always AI-generated.
4. Update `SECTION_TYPES` in `ui/src/pages/RunDetailPage.tsx` (duplicated — the
   UI can't import backend `.mjs`).
5. Run `npm test` — `section-types.test.mjs` self-checks the catalog.

### Add a static frame candidate

In `static-frame-catalog.mjs`, add to the section type's array:

```js
{
  id: "kebab-case-id",
  component: "ExactComponentName",
  importPath: `${importBase}/ExactComponentName`,
  description: "shown in the refine gallery",
  defaultData: { /* FULL copy of the component's own defaults */ },
  fillableFields: z.object({ /* only what campaign copy may override */ }),
}
```

`defaultData` must be **complete**, not partial — these components take `data`
as all-or-nothing with no deep merge, so a partial object blanks out fields
(including images this service can't reproduce). A candidate with no
`fillableFields`/`defaultData` renders bare, which is the right choice for
photo-dependent frames.

The catalog self-validates at import; a malformed entry throws at boot.

### Change what the AI is told

- **Whole-page content plan** → `steps/03-generate-guide.mjs`
- **One section's instructions** → `sections/section-agent-prompt.mjs`
- **Hero-specific rules / lead form** → `sections/hero-contract.mjs`
- **Type-strictness rules** → `steps/detect-typescript-strictness.mjs`

Prompt changes are testable — assert the fragment appears (see
`section-agent-prompt.test.mjs`). Do this: several real build failures were
fixed by prompt changes, and the tests are what stop them regressing.

### Add a verify check

1. Write `src/verify/check-<thing>.mjs` exporting
   `async function check…({url}) → {ok, report}`.
2. Wire it into `run-full-verify-suite.mjs`'s `Promise.all` — checks share one
   page load per attempt.
3. Add it to the returned `checks` object (the UI renders these as badges).

### Point the service at a different target repo

1. `GITHUB_TARGET_OWNER` / `GITHUB_TARGET_REPO`.
2. **`WRITE_PATH_ALLOWLIST`** — look at the real structure first.
3. **`PAGE_URL_PATH_TEMPLATE`** — routing conventions differ; unset means the
   browser checks are skipped.
4. Re-curate `reference-examples.mjs` and `static-frame-catalog.mjs` — both
   reference real paths in the target repo.
5. Delete `data/.scratch/_base` so a fresh base clone is made.

### Swap the storage backend

Write a module with the same exports as
`state/sqlite-campaign-repository.mjs` and change the single re-export line in
`state/campaign-repository.mjs`. Nothing else imports the concrete module.

---

## 12. Debugging a failed run

### Where the information actually is

| What | Where |
|---|---|
| Human-readable timeline | `GET /campaigns/:runId/log` or the UI's log console |
| **Full, untruncated failure** | `runs.error` in the DB (written when retries are exhausted) |
| **Per-attempt verify reports** | `verify_reports` table — every attempt, not just the last |
| Generated files (if it passed verify) | `draft_files` table |
| Generated files (if it failed) | Only the scratch worktree — **and only if `KEEP_WORKDIR_ON_FAILURE=true`** |

Pull the full failure:

```bash
node --env-file=.env -e "
import('./src/state/database-connection.mjs').then(({getDb}) => {
  const r = getDb().prepare(\"SELECT error FROM runs WHERE run_id LIKE 'abc123%'\").get();
  console.log(r.error);
});
"
```

> The log line is deliberately a **summary**. A failing `npm ci && npm run build`
> emits ~1400 characters of install chatter before the compiler says anything,
> so `summarize-report.mjs` strips it. The full text is always in the database.

### Real failures we hit, and what they meant

These are worth reading — each looked like something it wasn't.

| Symptom | Actual cause |
|---|---|
| `"doesn't have a root layout"` | `WRITE_PATH_ALLOWLIST` said `app/` but the repo uses `src/app/`. Files landed outside the App Router tree. |
| `Can't resolve '@components/frames/landing/analyze/X'` | The frames were **untracked in git**. They existed in the local base clone but not in any fresh worktree. `git ls-files` returned 0. |
| `useState ... needs "use client"` | Next.js App Router: components are server components by default. Prompt didn't say so. |
| `Can't resolve '../../../components/Accordion'` | The agent invented a local component. Now forbidden; it builds inline instead. |
| `Cannot find name 'toggleFqa'` | A typo — but the retry *rewrote the whole component* instead of fixing it, producing a different error each time. Fixed by targeted repair (v0.25). |
| `Binding element 'children' implicitly has an 'any' type` | The repo is `"strict": true`. The agent wrote untyped props. Now detected and injected into the prompt. |

**The pattern:** each fix revealed the next layer. When a run fails, check
whether it's the *same* failure or a new one — that distinction is the single
most useful diagnostic signal in this project.

### ⚠ The one that wastes the most time: `npm run dev` kills runs

`npm run dev` runs `node --watch`, which **restarts the process whenever any
file under `src/` changes**. A campaign run takes several minutes (clone → LLM →
`npm ci` → `next build`), so editing a single source file mid-run kills that run
— almost always during `verify`, the longest stage.

The symptom is deeply misleading: the run log ends in a build failure or
`failed_clone`, so it reads like a code-generation or Docker problem. The
give-away is a `resume: service restarted while this run was at stage "verify"`
line in the log.

**Use `npm start` when running real campaigns.** `npm run dev` is for editing the
service itself. The server now prints a warning at boot when it detects watch
mode.

### Common gotchas

- **Worktree gone after a failure?** Set `KEEP_WORKDIR_ON_FAILURE=true`. Without
  the files you cannot diagnose a syntax error.
- **Run marked failed after a restart?** Should no longer happen for
  `staged_for_review` runs (fixed v0.23). Mid-commit/push runs are *deliberately*
  not auto-resumed — check GitHub manually.
- **Can't delete a run?** It must be terminal. `staged_for_review` is not
  terminal — approve or abandon first.
- **Preview gone after you abandoned a run?** Expected. Abandon makes the run
  terminal, which stops the preview and removes its worktree. Previews also
  expire on their own after `PREVIEW_TTL_MS` (30 min by default).
- **Build fails with `Unexpected response from worker: undefined`?** The cause
  found in practice (v0.36) is `WATCH_REPORT_DEPENDENCIES`, which `node --watch`
  (i.e. `npm run dev`) sets and every child inherits — Next's jest-worker
  children then push Node's `watch:require` IPC messages into jest-worker's own
  channel and the parent dies before printing anything. `src/spawn-env.mjs`
  strips it from every process this service spawns, so check it isn't being set
  some other way. Otherwise suspect a worker OOM. Either way, re-run
  `npm run build` by hand in the run's workdir to see the real errors.
- **Browser checks always skipped?** `PAGE_URL_PATH_TEMPLATE` is unset, or the
  repo isn't Node-servable, or Chromium isn't installed. The report says which.
  `playwright` is an npm dependency but the browser it drives is a separate
  ~150MB download that `npm ci` does **not** fetch — run
  `npx playwright install chromium` to enable hero-fit/SEO/a11y.
- **Preview shows the wrong page?** If it opens the target repo's home page
  rather than your campaign, `PAGE_URL_PATH_TEMPLATE` is unset — the preview URL
  falls back to the server root. Any runtime error you see then belongs to the
  target repo's own pages, not to the generated one.
- **Preview won't start after a failed build?** It should now: since v0.32 the
  process path tries every serve script in `SERVE_SCRIPT_PREFERENCE` order, so
  when `next start` finds no build output it falls through to `next dev`, which
  compiles on demand. If nothing starts, the log lists what each attempt did.
- **Preview iframe is blank in the UI?** The page is being loaded from
  `previews.url` instead of `previews.embed_url`, or the frameable proxy failed
  to bind — `X-Frame-Options: DENY` is doing exactly what it says. The UI falls
  back to a link-only panel when `embedUrl` is null.

---

## 13. Testing conventions

```bash
npm test                              # everything
node --test test/<file>.test.mjs      # one file
```

**Four rules, all load-bearing:**

1. **Never mock the LLM.** AI-touching code is verified live or via
   structural/compile checks. Pure logic gets real unit tests. This is why
   `generateSections` is tested with all-static sections — real code path, no
   network.
2. **Never mock git or the filesystem.** Use real `mkdtemp` and
   `git init --bare` fixtures.
3. **Config-touching tests must use a dynamic import after `setTestConfigEnv()`.**
   `config.mjs` validates `process.env` at first import, so a static top-level
   import runs before your overrides:
   ```js
   setTestConfigEnv({ DB_PATH: path.join(mkdtempSync(...), "test.db") });
   const repo = await import("../src/state/campaign-repository.mjs");
   ```
4. **Always pass a temp `DB_PATH`.** Omitting it makes tests write into the real
   `data/campaigns.db`. This has happened; don't repeat it.

Regression tests should use **the real failing input** — several tests here
embed verbatim build reports from actual failed runs. That's deliberate: it
proves the fix against the thing that actually broke.

---

## 14. Known gaps and deliberate non-goals

### Not built, on purpose

| Thing | Why |
|---|---|
| LLM validation/judgment layer (Phase 5) | Superseded by the per-section gallery review. |
| Raw-file editor in review (Phase 6) | Refinement happens only through the section gallery. |
| Reject-with-feedback-and-regenerate | Needs the same UI as refine; deferred rather than half-built. |
| Bulk regenerate | Explicitly lowest priority. |
| Real lead-endpoint delivery | External dependency. The preview sink is a no-op by design. |
| Crash *checkpointing* | Resume re-drives the pipeline reusing cached LLM output; it doesn't restore a mid-graph snapshot. |
| Alerting, metrics dashboard, real auth | Phase 10, not v1. |

### Genuinely open

1. **No live end-to-end validation.** This is the biggest gap. Every phase since
   Module 2 was verified by non-LLM tests and compile checks. Real runs keep
   surfacing things tests cannot.
2. **Design catalog not curated** against the real repo (`module.md` Module 7).
   `reference-examples.mjs` still has placeholder paths.
3. **Browser checks never run against real Chromium** here (`module.md` Module 8).
4. **`token_usage` has no writers** — no cost tracking (Phase 10).
5. **No concurrency cap on runs.** Previews are capped; campaign runs are not.
6. **Shared-secret compare isn't constant-time** — low risk behind HTTPS, but a
   five-minute fix.
7. **GHL iframe vs. custom lead form** — the real repo's heroes use GoHighLevel
   iframes, which is in tension with the custom-form contract in `leadform/`.
8. **`workflow.md` is stale** — pre-v0.16 pipeline, references the long-retired
   flat-JSON run store.
9. **Backend is plain `.mjs`, not TypeScript.** No build step by choice; the UI
   *is* TypeScript. A JSDoc + `// @ts-check` pass would catch real bugs without a
   rewrite.

### If you're picking this up next

Run it live, end to end, against the real target repo, and watch what breaks.
Every significant improvement in this project so far came from a real failure,
not from planning — and the tests, by design, cannot substitute for that.
