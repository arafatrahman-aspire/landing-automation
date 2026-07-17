# Landing page automation → PR Service — Landing Plan

**Project:** AI-driven landing page generation that opens PRs into an external frontend repo
**Status:** Implemented (v1)
**Date:** 2026-07-13
**Location:** `new_approach/` — standalone, independent of parent `landing_page_automation`

---

## 1. How We Got Here: Evolution of the System

### Original Plan (`plan.md` — v1, 2026-07-05)
A template + campaign-config + course-data rendering engine. Campaigns were data rows; pages composed from a fixed section catalog at render time. The AI role was limited to copy drafts and OG images (P2 stretch).

### Agent-Centric Plan (`landing-page-automation-agent-plan.md` — v2, 2026-07-07)
Pivoted to AI-generated pages: brief → research agent → guide generator → vibe coding agent → human approval → publish. The agent *writes code* into the Next.js repo (`app/lp/{slug}/page.tsx`). Shared components + token file prevent brand drift.

### Productionization Plan (`new-plan.md` — v3, 2026-07-08)
Two problems with v2: (1) generated `.tsx` files can't be deployed on immutable serverless hosts without a rebuild, and (2) runs die with the process. The key decision: **pages move from code files to database-driven rendering** (`page_spec` JSON per campaign, one dynamic `/lp/[slug]` route). This also makes the AI safer — it emits schema-validated JSON, never executable code.

### Current Implementation (`landing-automation-update.md` — 2026-07-08)
The v2 model is fully built and working end-to-end locally: admin panel → LangGraph pipeline (research → guide → build → QA) → draft preview → human publish → live page. Leads captured to DB + forwarded to CRM. Limitations: in-process runs, no CI/CD, code-only page delivery.

### The New Approach (`new_approach/` — this project)
Solves a **fundamentally different problem**: getting AI-generated code into **someone else's repository**, where a pull request is the correct (and only) delivery mechanism. Nothing here imports from or touches the parent project's code or database.

---

## 2. Problem Statement

The parent `landing_page_automation` renders pages from a `page_spec` JSON row in its own Supabase database — deliberately never writing code files, because its hosting (Vercel) can't accept runtime file writes. This works for the company's own site.

But what about getting AI-generated landing pages into a **repository the company doesn't control** — where pages must be actual code files, built by the target repo's own CI, and delivered via Pull Request? That's the gap this service fills.

---

## 3. Pipeline Flow

```
POST /campaigns  (brief JSON)
       │
       ▼
┌──────────┐     ┌───────────┐     ┌───────────────┐     ┌───────┐
│  intake   │────▶│ research   │────▶│ generate_guide │────▶│ file   │
│           │     │ (LLM+web) │     │ (LLM one-shot) │     │manifest│
└──────────┘     └───────────┘     └───────────────┘     └───┬───┘
                                                             │
         ◀───────────────────────────────────────────────────┘
         ▼
    ┌────────┐     ┌──────────┐     ┌──────────┐
    │ clone   │────▶│  code    │────▶│ verify   │
    │ (shallow│     │(agentic  │     │(install +│
    │  +branch)│    │ loop)    │     │build+lint)│
    └────────┘     └──────────┘     └─────┬────┘
                                   ▲       │ pass
                                   │       ▼
                          retry (max 2)  ┌────────┐
                                   │      │ commit  │
                          verify fails   └───┬────┘
                                             │
                                             ▼
                                        ┌────────┐     ┌─────────┐
                                        │  push   │────▶│ open PR │──▶ END
                                        └────────┘     └─────────┘
```

Each node in this state machine is a LangGraph step (`src/orchestrator/graph.mjs`). The conditional edge at `verify` either routes to `commit` (pass) or back to `code` with the error report (retry, max `MAX_CODE_ATTEMPTS`). Exhausted retries route straight to `END` — no broken code ever reaches a branch or PR.

---

## 4. Features

### 4.1 Campaign Intake (P0)
- `POST /campaigns` with validated brief: slug, campaignName, offer, audience, CTA, free-form notes.
- Zod schema (`src/schemas/brief-schema.mjs`): slug is lowercase kebab-case, all fields length-bounded.
- Returns `202` with a `runId` and status URL for polling.

### 4.2 Research Agent (P0)
- One-shot LLM call with web search (Gemini grounding or Claude web_search tool).
- Produces structured JSON: `keywords[]`, `painPoints[]`, `faqQuestions[]`, `notes`.
- Skippable via `SKIP_RESEARCH=true` for fast iteration.

### 4.3 Guide Generator (P0)
- One-shot LLM call that produces a content + design outline (~400 words).
- Covers: headline, subheadline, pain points, what's included, FAQ, section order.
- This is the content spec the coding agent implements — *not* a page-spec schema (unlike the parent project's data-driven approach).

### 4.4 File Manifest Declaration (P0)
- **Before** the coding agent runs, the LLM declares exactly which files it intends to create.
- Structure: `{slug, summary, designNotes, filesToCreate: [{path, purpose}]}`.
- Zod validated (`src/schemas/file-manifest-schema.mjs`): 1–15 files, each path bounded.
- Paths validated against the human-configured `WRITE_PATH_ALLOWLIST` at manifest time (not just at write time). Retried twice on parse/schema failure.
- **This is a safety-critical gate:** the coding agent can only write files listed here.

### 4.5 Agentic Coding Loop (P0)
- Provider-switchable: Gemini or Claude, selected via `CODING_AGENT_PROVIDER` (independent of `AI_PROVIDER`).
- Multi-turn tool-use conversation: `list_files`, `read_file`, `write_file`, `finish_coding`.
- No shell-exec tool — the LLM explores the repo to match conventions, but cannot run commands.
- Termination: explicit `finish_coding` tool call with a summary. Max `MAX_AGENT_ITERATIONS` (default 25) safety cap.
- If `finish_coding` is never called, the run is treated as a failure — never proceeds to verify/commit/push/PR.

### 4.6 Build/Lint Verification (P0)
- **Deterministic, non-AI step** — the orchestrator runs the target repo's own scripts:
  1. Detect package manager (npm/yarn/pnpm via lockfile detection).
  2. `install` (ci/--frozen-lockfile).
  3. `build` (must exist in target's `package.json` — aborts if missing).
  4. `lint` (optional — runs only if `scripts.lint` exists).
- A failure feeds the error report back to the coding agent for one retry.
- **This IS the QA gate** — mirrors the parent project's philosophy of "validation, not AI opinion."

### 4.7 Commit + Push + Open PR (P0)
- Clones the target repo shallow (`--depth 1`), creates a `codegen/{slug}-{runId}` branch locally.
- Commits only the new files declared in the manifest + `CODEGEN_LOG.md`.
- Pushes to the remote with retries (3 attempts).
- Opens a PR with a structured body: summary, file list, agent notes, reviewer checklist.
- **Never merges** — human review is the final gate.
- Idempotent PR opening: if GitHub reports "already exists," finds and returns the existing PR.
- Dry-run mode (`DRY_RUN_NO_PR=true`): clone/code/verify/commit/push all run for real; only the final GitHub API call is skipped.

### 4.8 HTTP Status API (P0)
- `GET /campaigns/:runId` — status, stage, branch name, PR URL, log tail (last 50 lines), error.
- `GET /campaigns/:runId/log` — full plain-text log.
- `GET /healthz` — unauthenticated liveness check.
- All `/campaigns*` routes require `Authorization: Bearer <API_SHARED_SECRET>`.

---

## 5. Architecture

### 5.1 Module Map

```
new_approach/
├── src/
│   ├── server.mjs              # HTTP server (plain node:http, port 4300)
│   ├── config.mjs              # Zod-validated env config, one import for everything
│   ├── ai/
│   │   ├── text.mjs            # One-shot LLM calls (research, guide, manifest)
│   │   ├── coding-agent.mjs    # Agentic loop: Gemini+Claude dispatch
│   │   └── tools.mjs           # Tool implementations + 4-layer write guard
│   ├── git/
│   │   └── ops.mjs             # Git CLI wrapper (clone, branch, commit, push)
│   ├── github/
│   │   └── api.mjs             # GitHub REST API (open PR, find existing)
│   ├── orchestrator/
│   │   ├── graph.mjs           # LangGraph state machine definition
│   │   └── steps.mjs           # Pure stage functions (orchestration logic)
│   ├── schemas/
│   │   ├── brief-schema.mjs    # Campaign brief validation (Zod)
│   │   └── file-manifest-schema.mjs  # File plan validation (Zod)
│   ├── state/
│   │   └── run-store.mjs       # Filesystem-based run tracking (no DB)
│   └── verify/
│       └── build.mjs           # Deterministic install/build/lint verification
├── dev/
│   └── run-agent-standalone.mjs # Offline coding agent harness (no git/GitHub)
└── test/
    ├── write-tool-allowlist.test.mjs  # Most important test — 4-layer guard
    ├── brief-schema.test.mjs
    ├── file-manifest-schema.test.mjs
    ├── git-ops.test.mjs               # Git operations against local bare repo
    ├── github-api.test.mjs            # Pure request-building tests
    └── verify-build.test.mjs
```

### 5.2 Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js (no framework) | 3 routes; plain `node:http` is sufficient |
| Orchestration | LangGraph (StateGraph) | Same pattern as parent project; retry-as-conditional-edge |
| AI (one-shot) | Gemini 2.5 Flash / Claude | Switchable via `AI_PROVIDER`; raw fetch, no SDKs |
| AI (agentic) | Gemini / Claude | Switchable via `CODING_AGENT_PROVIDER`; independent of one-shot provider |
| Validation | Zod | Fast startup-time and runtime validation with typed output |
| Git | CLI (`git clone`, `push`, etc.) | No SDKs — consistent with parent project convention |
| GitHub | REST API via `fetch` | No Octokit — same convention as parent's `ai.mjs` |
| State storage | Filesystem (JSON + plain-text logs) | Deliberately no DB — GitHub PR is the durable record |
| Testing | Node built-in test runner | Offline or against local git fixtures; zero network dependency |

### 5.3 Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `API_SHARED_SECRET` | Bearer token required on all `/campaigns*` routes |
| `AI_PROVIDER` | `gemini` \| `claude` — for research/guide/manifest |
| `CODING_AGENT_PROVIDER` | `gemini` \| `claude` — for the agentic loop (**independent**) |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | Required only for selected providers |
| `CODING_AGENT_MODEL` | Override model for the coding agent (falls back to provider default) |
| `MAX_AGENT_ITERATIONS` | Default 25 — safety cap on agentic loop |
| `MAX_CODE_ATTEMPTS` | Default 2 — max verify→retry cycles |
| `GITHUB_TARGET_OWNER` / `GITHUB_TARGET_REPO` | External repo this service pushes into |
| `GITHUB_BASE_BRANCH` | Default `main` — PRs target this, never pushed to directly |
| `GITHUB_TOKEN` | Fine-grained PAT: contents + pull-requests, scoped to the target repo only |
| `WRITE_PATH_ALLOWLIST` | **Set by human** after reviewing target repo structure, e.g. `app/campaigns/{slug}/,components/campaigns/{slug}/` |
| `TARGET_REPO_CLONE_URL` | Override for local `git init --bare` fixture testing |
| `DRY_RUN_NO_PR` | Skip the real GitHub PR API call |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | Commit authorship |

---

## 6. Safety Model (The Write Guard)

The `write_file` tool in `src/ai/tools.mjs` enforces **four independent checks** in strict order. A hole in any layer cannot defeat the others:

### Layer 1: Path Containment
- No absolute paths (`/etc/passwd` → rejected).
- No traversal (`../../etc/passwd` → rejected).
- Empty strings rejected.
- Resolved path must be inside the scratch clone directory.

### Layer 2: Pristine-File Guard
- A `Set<string>` of every tracked file is captured via `git ls-files` **immediately after clone**.
- The agent can **never** write to any file in this set — unconditional, regardless of allowlist or manifest.
- Exception: files the agent itself wrote earlier in the same run (so it can iterate on its own new files across turns/retries).

### Layer 3: Human-Set Path Allowlist
- `WRITE_PATH_ALLOWLIST` is configured by the human operator after inspecting the target repo.
- Supports `{slug}` template substitution per run.
- Any write outside the resolved allowlist prefixes is rejected.
- **Deliberately not auto-derived** from what the AI discovers — a human must set this.

### Layer 4: File-Plan Match
- The path must be exactly one of the files the AI declared in its own manifest before coding started.
- Prevents the agent from writing files it didn't plan for.

### Additional Constraints
- **No shell-exec tool.** The agent cannot run commands. Build/lint verification is run by the orchestrator separately.
- **Only 4 tools exist:** `list_files`, `read_file`, `write_file`, `finish_coding`.
- Binary files are never read (extensions hardcoded: images, fonts, archives).
- `read_file` capped at 60KB.
- Excluded directories: `.git`, `node_modules`, `.next`, `dist`, `build`, `coverage`, `.turbo`, `.cache`.

### Git/GitHub Structural Guards
- `createLocalBranch` and `push` refuse to use a branch name equal to the base branch.
- Commit stage only `git add`s the explicitly listed manifest paths — never `git add -A`.
- Clone → branch (local only) → code → verify → **only then** commit → push → open PR.
- Nothing is ever pushed to the base branch.
- This service never calls the merge endpoint.

---

## 7. Key Decisions

### D1: Separate project, not an extension of the parent
The parent app renders pages from `page_spec` JSON — no code files. This service targets external repos where code files are the only delivery format. Mixing the two would create conflicting assumptions about output format, safety boundaries, and deployment.

### D2: No database
GitHub (the PR, its commits, and `CODEGEN_LOG.md`) is the durable record. A per-run JSON file under `data/runs/` exists only for the HTTP status API while the service is alive. This avoids schema management, connection pooling, and the complexity of syncing two sources of truth.

### D3: File manifest declared before coding begins
The AI declares which files it will create **before** writing a single line. This manifest is validated against the human-set allowlist at declaration time, not just at write time. The coding agent is then constrained to only those paths.

### D4: Independent AI provider selection for one-shot vs. agentic stages
`AI_PROVIDER` controls research/guide/manifest (one-shot). `CODING_AGENT_PROVIDER` controls the coding loop (multi-turn). You can run research on Gemini and coding on Claude, or vice versa. Only the API keys for selected providers are required.

### D5: Deterministic build verification, not AI opinion
The "QA gate" is the target repo's own `package.json` scripts (`install` → `build` → `lint`). The orchestrator runs these — never the LLM. This matches the parent project's philosophy.

### D6: Human-in-the-loop at the PR
The service opens a PR but never merges it. A human reviews the diff, preview deploy, copy accuracy, and CTA behavior before merging. This is the final safety gate.

### D7: No checkpointing or resume in v1
If the process crashes mid-run, the run is marked `failed` (or `failed_push_incomplete` if a branch was already pushed — so a human can open the PR manually). LangGraph checkpointing is flagged as an obvious future addition but not built yet.

### D8: Write path allowlist is human-configured, not auto-discovered
The agent explores the repo and discovers conventions, but the *boundaries* within which it may write are set by hand in `.env`. This prevents an LLM from "discovering" dangerous paths to write to.

### D9: Plain Node.js HTTP, no framework
With exactly 4 routes, a framework adds dependency weight and learning curve for no benefit. Matches the parent project's convention of using `node:http` for simple services.

### D10: Raw fetch over provider SDKs
Both Gemini and Claude are called via raw `fetch`. This is consistent with the parent project's `ai.mjs` and avoids SDK churn.

---

## 8. State Machine & Error Handling

### LangGraph State
```
StateGraph(CodegenState) with nodes:
  intake → research → generate_guide → file_manifest → clone → code → verify → commit → push → open_pr → END
                                          condition edge at verify: pass → commit, fail+retries_left → code, fail+exhausted → END
```

### Run Statuses (Terminal)
| Status | Meaning |
|---|---|
| `completed` | PR opened (or dry-run completed) |
| `failed` | Generic failure (code agent, unexpected error) |
| `failed_clone` | Clone step failed |
| `failed_verification` | Build/lint failed after exhausting retries |
| `failed_push` | Push failed (with retries exhausted) |
| `failed_push_incomplete` | Process crashed after push but before PR — branch is on remote, human should open PR manually |

### Crash Recovery
On startup (`server.mjs`), `runStore.reconcileCrashedRuns()` scans for non-terminal runs from a previous process lifetime and marks them `failed` or `failed_push_incomplete`.

---

## 9. Testing Strategy

All tests run offline with `npm test`:

| Test | What it verifies |
|---|---|
| `write-tool-allowlist.test.mjs` | **Most important test.** All 4 guard layers independently: traversal rejection, pristine-file protection, allowlist enforcement, manifest match |
| `brief-schema.test.mjs` | Campaign brief validation: acceptable fields, rejection of bad slugs, missing fields |
| `file-manifest-schema.test.mjs` | File manifest validation: shape, bounds, acceptable/unacceptable paths |
| `git-ops.test.mjs` | Real git operations against a local `git init --bare` fixture: clone, branch, commit, push — zero network, zero GitHub token |
| `github-api.test.mjs` | Pure function tests: `buildPrPayload`, `isAlreadyExistsError` string matching |
| `verify-build.test.mjs` | Build verification against a local fake repo |

### Agentic Loop Iteration (Manual)
`node --env-file=.env dev/run-agent-standalone.mjs` runs the coding loop against a small temp fixture — no git clone, no GitHub involved. Useful for iterating on prompts and tool schemas cheaply.

### Dry-Run Integration Test
Point `TARGET_REPO_CLONE_URL` at a local bare repo fixture with `DRY_RUN_NO_PR=true`. This exercises every stage (clone, code, verify, commit, push) against a real LLM — only the GitHub PR API call is skipped.

---

## 10. What's Out of Scope (v1)

- **Resume across process restart.** LangGraph checkpointing to Postgres would enable this; flagged but not built.
- **Monorepo support.** Assumes a single `package.json` at the target repo root.
- **True multi-provider tool-use within a single run.** The coding agent uses one provider per run, not both at once.
- **Database-driven page rendering.** The parent project already does this. This service intentionally delivers code files via PR.
- **Auto-merge.** The service never merges PRs — human review is required.
- **A/B variant generation.** Out of scope for the code-delivery pipeline; belongs in the parent project's rendering engine.

---

## 11. Relationship to Parent Project

```
landing_page_automation (parent)          new_approach (this service)
─────────────────────────────────         ───────────────────────────
Renders pages from page_spec JSON         Generates code files for external repos
Owns its own Supabase database            No database — PR is the record
Dynamic /lp/[slug] route                  No rendering — just opens PRs
Admin panel for marketing                 No admin panel — HTTP API only
Leads captured to own DB                  Leads not in scope
Designed for the company's own site       Designed for external repos the company doesn't control
```

They share philosophies (Zod validation, LangGraph orchestration, provider-switchable AI, plain fetch over SDKs) but share zero code and solve different problems.

---

## 12. Future Directions (Flagged, Not Scheduled)

- **LangGraph checkpointing to Postgres** for resume across restarts.
- **Monorepo support** (workspace-aware install/build).
- **Slack/email notifications** on run completion or failure.
- **Per-run token budget tracking** and daily run limits.
- **Guide editor via API** — modify the content guide and re-trigger the manifest+code+verify cycle from the same run.
