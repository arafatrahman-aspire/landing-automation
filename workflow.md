# Workflow & Feature Documentation

**Campaign Codegen PR Service** — a standalone service that turns a campaign brief into a self-contained landing page inside an **external** frontend repository, verifies it builds and renders correctly, and opens a pull request. It never touches the parent project's own rendering system; it only produces new files in a target repo and opens a PR for a human to review and merge.

---

## 1. What it does (in one breath)

You POST a campaign brief. The service researches the campaign, plans the page's content and file structure against the *real* target repo, runs an agentic coding loop that writes new files (and only new files), verifies the result (build/lint + hero layout + SEO + accessibility), and — only if verification passes — commits, pushes a branch, and opens a GitHub PR. Every run's status is trackable over HTTP while it runs and after it finishes.

The core safety guarantee: **no existing file in the target repo is ever modified, and no PR is ever opened for code that failed verification.**

---

## 2. High-level architecture

```
HTTP API (Express)  ──▶  Orchestrator (LangGraph state machine)  ──▶  external GitHub repo (PR)
  src/server.mjs           src/orchestrator/graph.mjs + steps.mjs
        │                            │
        │                            ├── AI: research/guide/manifest (one-shot LLM)   src/ai/text.mjs
        │                            ├── AI: coding agent (tool-using loop)           src/ai/coding-agent.mjs + tools.mjs
        │                            ├── Git: shared base clone + per-run worktree     src/git/ops.mjs
        │                            ├── Verify: build/lint + hero/seo/a11y            src/verify/*
        │                            └── GitHub: open PR                               src/github/api.mjs
        │
        └── Run state (filesystem, no DB)                                             src/state/run-store.mjs
```

There is a separate React/Vite UI in `ui/` for driving the API from a browser.

---

## 3. The pipeline (LangGraph state machine)

Defined in [src/orchestrator/graph.mjs](src/orchestrator/graph.mjs); each node's logic lives in [src/orchestrator/steps.mjs](src/orchestrator/steps.mjs).

```
intake → research → clone → generate_guide → file_manifest → code → verify
                                                              ▲       │
                                                              └─retry─┘  (while codeAttempts < MAX_CODE_ATTEMPTS)
                                                                      │ pass
                                                     commit → push → open_pr → END
```

A verify failure that exhausts retries routes **straight to END** — it never reaches commit/push/open_pr, so a broken PR is impossible.

### Node-by-node

| Node | What it does | Key detail |
|------|--------------|------------|
| **intake** | Records the run started, logs the campaign name/slug. | Trivial; establishes the heartbeat stage. |
| **research** | One-shot LLM call (with web search) that returns JSON: keywords, pain points, FAQ questions, notes. | Skippable via `SKIP_RESEARCH=true`. |
| **clone** | Ensures a shared **base clone** exists, syncs it to latest, then creates a per-run **git worktree** with a new branch. Snapshots the set of pre-existing tracked files (`pristineFiles`). | See §5. Branch name: `codegen/<slug>-<runId8>`. |
| **generate_guide** | LLM plans page content + an ordered list of **sections** (chosen from a fixed catalog). Produces heroTitle, SEO title/description, section list with summaries. | Validated + retried once on bad JSON/schema. Length limits are strict. |
| **file_manifest** | LLM declares the concrete **new files to create** (2–8), with real paths/extensions matching the target repo's actual stack. | Every path must fall under the write allowlist; retried once, then hard-fails. |
| **code** | The agentic coding loop. The LLM explores the repo and writes the planned files via tools. Ends only on an explicit `finish_coding` call. | See §6. Guardrails are enforced in code, not just prompts. |
| **verify** | Deterministic verification suite: build/lint, then (if servable + a page URL is configured) hero-fit, SEO, a11y against an ephemeral server. | See §7. On failure, routes back to `code` for a retry with the failure report fed back in. |
| **commit** | Writes a `CODEGEN_LOG.md` audit file, commits only the manifest files + that log. | Commit message includes the run id. |
| **push** | Pushes the run's branch to the target remote. | |
| **open_pr** | Opens a GitHub PR with a structured body (summary, file list, agent notes, reviewer checklist), then cleans up the worktree. | `DRY_RUN_NO_PR=true` skips the real PR call but still pushes the branch. |

### Where the repo gets detected

`clone` happens **before** guide/file_manifest deliberately. The target repo's stack is not fixed — it could be Next.js, React, Vue, Laravel/Blade, or plain HTML. A lightweight scan (`detectRepoConventions` in steps.mjs) reads `package.json`/`composer.json` and top-level dirs so the guide and manifest stages describe the plan in terms of what the repo *actually is*, instead of guessing and locking in wrong file paths.

---

## 4. HTTP API

Server: [src/server.mjs](src/server.mjs). All endpoints except `/healthz` require `Authorization: Bearer <API_SHARED_SECRET>`.

| Method & path | Purpose |
|---|---|
| `GET /healthz` | Liveness check (no auth). |
| `POST /campaigns` | Submit a brief. Validates it, creates a run, kicks off the pipeline **asynchronously**, and returns `202` with `{ runId, status, statusUrl }`. |
| `GET /campaigns` | List all runs, newest first. |
| `GET /campaigns/:runId` | Full run record (status, stage, attempts, branch, PR url, guide, section references, verify checks, recent log tail). |
| `GET /campaigns/:runId/log` | Full plain-text run log. |
| `DELETE /campaigns/:runId` | Delete a run's local bookkeeping. Only allowed for **terminal** runs (`409` otherwise). Also best-effort removes any leftover worktree. Never touches anything already pushed to GitHub. |

The request runs in the background: `POST /campaigns` returns immediately; you poll `GET /campaigns/:runId` to watch it progress through stages.

### Brief schema

Validated by [src/schemas/brief-schema.mjs](src/schemas/brief-schema.mjs). Core fields: `campaignName`, `slug`, `offer`, `audience`, `cta`, `brief`, and optional `videoUrl`. The `slug` drives the branch name, the write allowlist, and the page URL.

---

## 5. Git strategy: base clone + worktrees

Implemented in [src/git/ops.mjs](src/git/ops.mjs), orchestrated by the `clone` step.

- A fresh network clone every run is slow, so a single **base clone** lives at `WORKDIR_ROOT/_base`, created once.
- Before each run it's kept current with a cheap shallow **fetch + reset** (`syncBaseToLatest`), not a re-clone.
- Each run gets its own isolated working directory via `git worktree add` — a new branch checked out into its own folder, sharing the base clone's object store.
- Cleanup removes the worktree and its local branch (`git worktree remove`) but never the base clone. Because worktrees share metadata with the base, they must be removed via git, not a raw `rm` — the DELETE endpoint is careful about this.

Auth: for HTTP remotes, the `GITHUB_TOKEN` is injected into the remote URL. `TARGET_REPO_CLONE_URL` can point at a local bare repo fixture for safe end-to-end testing without touching a real repo.

---

## 6. The coding agent & its guardrails

The loop lives in [src/ai/coding-agent.mjs](src/ai/coding-agent.mjs); the filesystem tools are in [src/ai/tools.mjs](src/ai/tools.mjs).

### Tools the agent has (and only these)

- `list_files` — explore repo structure.
- `read_file` — read a text file (binaries omitted, large files truncated).
- `write_file` — create a **new** file. Heavily guarded (below).
- `finish_coding` — the *only* way to end the loop, and it must include a summary (used in the PR body).

There is **deliberately no shell-exec tool.** Build/lint verification is a separate deterministic step the orchestrator runs itself — never something the LLM can invoke.

### The four independent write guards

`resolveWritePath` in tools.mjs checks every write in this order; a hole in one layer doesn't defeat the others:

1. **Path traversal** — reject absolute paths and anything escaping the repo (`..`).
2. **Pristine** — never overwrite a file that existed before this run started (unless the agent itself created it earlier in this run, so it can iterate on its own files across retries).
3. **Allowlist** — the path must start with a human-configured prefix (`WRITE_PATH_ALLOWLIST`, with `{slug}` resolved).
4. **Manifest** — the path must be one the file_manifest stage actually declared.

This is the safety-critical file of the whole service: the LLM can only do what these functions allow.

### Provider switching

Both the one-shot stages and the coding loop are provider-switchable:

- `AI_PROVIDER` (`gemini` | `claude`) — governs research/guide/manifest.
- `CODING_AGENT_PROVIDER` (`gemini` | `claude`) — governs the coding loop, **independently**. You can run research on Gemini and coding on Claude, or both on Gemini, etc.

Both provider implementations share one contract and terminate on the explicit `finish_coding` call — never on "the model stopped requesting tools." `MAX_AGENT_ITERATIONS` is a safety cap; hitting it *without* `finish_coding` is treated as a failure and never proceeds to verify.

### The hero requirement

The coding agent's system prompt mandates a hero block that fits above the fold on both desktop and mobile, containing the campaign title, a video-or-details block, and a lead-capture form. These three elements must be marked with exact HTML attributes — `data-hero-title`, `data-hero-media`, `data-hero-form` — which the hero-fit verifier looks for.

---

## 7. Verification suite

Coordinated by [src/verify/index.mjs](src/verify/index.mjs).

1. **build/lint** (`verify/build.mjs`) runs first — fail fast, no point measuring layout of something that doesn't build. Ecosystem-aware install + build.
2. If that passes **and** the repo is Node-servable **and** `PAGE_URL_PATH_TEMPLATE` is configured, an **ephemeral server** is started (`verify/local-server.mjs`) and three checks run in parallel against the live page:
   - **hero-fit** (`verify/hero-fit.mjs`) — the hero elements exist and fit above the fold at desktop and mobile widths (via Playwright).
   - **seo-lint** (`verify/seo-lint.mjs`) — title/meta/heading correctness.
   - **a11y-lint** (`verify/a11y-lint.mjs`) — accessibility via axe-core.
3. The server is always stopped afterward.

If the repo isn't servable or no page URL is configured, the layout/SEO/a11y checks are **skipped** (build/lint still gates), so the pipeline still works for repos like Laravel where the page isn't wired into routing yet.

The overall result (`ok` + a human-readable report + per-check booleans) is stored on the run. A failing report is fed back into the next `code` attempt so the agent can fix it.

---

## 8. Run state (no database)

[src/state/run-store.mjs](src/state/run-store.mjs) — filesystem-only, deliberately no DB. GitHub (via the resulting PR) is the durable record; this is just in-flight status.

- One `<runId>.json` per run (record + a bounded 50-line log tail) and one `<runId>.log` plain-text file (unbounded, full log).
- Reads/writes to the same run are serialized through a per-runId promise chain, which is enough for a single always-on process.
- **Statuses**: `queued` → `running` → stage-specific failures (`failed`, `failed_clone`, `failed_verification`, `failed_push`, `failed_push_incomplete`) or `completed`. `heartbeatAt` + `stage` track which node is active.
- **Crash recovery**: on startup, any run still non-terminal from a previous process lifetime is marked failed (no checkpoint/resume in v1). If it had already pushed a branch, it gets the distinct `failed_push_incomplete` status so a human knows a PR may need opening manually.

---

## 9. Design catalog (grounding the LLM in real code)

[src/design/catalog.mjs](src/design/catalog.mjs) + [src/design/resolve.mjs](src/design/resolve.mjs) + [src/design/schema.mjs](src/design/schema.mjs).

The guide stage chooses sections from a **fixed catalog** of section types (hero, faq, etc.). For each type, the catalog can list **reference files** in the target repo. Before prompting, `resolveSectionReferences` reads that real code out of the cloned repo and injects it into the prompt, so the model plans against actual conventions instead of a blank page. A missing example is a quality gap (fix it in `catalog.mjs`), never a reason to fail a run. The resolved references are also persisted on the run so a human can see which files grounded the plan.

---

## 10. Configuration

All env vars are loaded and validated once at startup by [src/config.mjs](src/config.mjs) (fail loud on misconfiguration). Every module reads from `config`, never `process.env` directly. See `.env.example`.

**Key vars:**

| Var | Meaning |
|---|---|
| `API_SHARED_SECRET` | Bearer token for the API (≥16 chars). |
| `AI_PROVIDER` / `CODING_AGENT_PROVIDER` | `gemini` or `claude`, independently. |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | Required depending on the providers chosen. |
| `CLAUDE_MODEL` / `GEMINI_MODEL` / `CODING_AGENT_MODEL` | Model selection. |
| `GITHUB_TARGET_OWNER` / `GITHUB_TARGET_REPO` / `GITHUB_BASE_BRANCH` | The repo PRs are opened against. |
| `GITHUB_TOKEN` | Required unless `DRY_RUN_NO_PR=true`. |
| `TARGET_REPO_CLONE_URL` | Override for pointing at a local fixture. |
| `DRY_RUN_NO_PR` | Run the whole pipeline (incl. real push) but skip the PR API call. |
| `WRITE_PATH_ALLOWLIST` | Comma-separated prefixes (with `{slug}`) the agent may write under — **required**. |
| `PAGE_URL_PATH_TEMPLATE` | e.g. `/campaigns/{slug}`; unset skips layout/SEO/a11y checks. |
| `MAX_AGENT_ITERATIONS` / `MAX_CODE_ATTEMPTS` | Loop and retry caps. |
| `VERIFY_*_TIMEOUT_MS` | Install/build/server timeouts. |
| `SKIP_RESEARCH` | Skip the research LLM call. |
| `KEEP_WORKDIR_ON_FAILURE` | Keep the worktree around for debugging. |
| `RUN_STATE_DIR` / `WORKDIR_ROOT` | Where run records and clones live. |

---

## 11. Running it

```bash
npm start        # node --env-file=.env src/server.mjs
npm run dev      # same, with --watch
npm test         # node --test (unit tests in test/)
```

The UI (in `ui/`) is a separate Vite app that talks to this API cross-origin (CORS reflects the origin and allows the `Authorization` header).

---

## 12. Design principles worth internalizing

- **Humans set the boundaries, code enforces them.** The write allowlist and page URL are human-configured after reviewing the target repo; the agent operates strictly inside them.
- **New files only, never modify existing ones.** Enforced by four independent guards, not just prompt instructions. If the page needs an existing routes file edited (e.g. Laravel), the agent leaves it unwired and flags it in the PR for a human.
- **No broken PRs.** Verification gates commit/push/PR; a failed verify that exhausts retries ends the run.
- **Deterministic verification, not LLM self-assessment.** Build/lint/hero/SEO/a11y are real checks the orchestrator runs, not something the model can claim it did.
- **Provider-agnostic.** Swap Gemini/Claude for research and coding independently with env vars, no code changes.
- **Stack-agnostic target repo.** Detect the repo's real conventions after clone; plan and code against them rather than assuming a framework.
