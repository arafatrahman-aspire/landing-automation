# Campaign Codegen → PR Service

A standalone service, independent of the parent `landing_page_automation`
project. Given a campaign brief, it:

1. researches the topic and writes a short content guide (one-shot LLM calls),
2. declares a small, explicit **file plan** (which new files it intends to create),
3. clones an **external** frontend repository (not this one, not the parent
   project) — only once; every run after that reuses the cached clone
   (`data/.scratch/_base/`) via a `git worktree`, syncing it to the latest
   base branch first instead of re-cloning from scratch,
4. runs an **agentic coding loop** (Gemini or Claude — switchable with one
   env var) that explores that repo's real conventions and writes the new
   landing page — strictly inside a human-configured, code-enforced path
   allowlist, and only files declared in the plan,
5. runs the target repo's **own** build/lint scripts to verify the change,
6. stages the generated files as a versioned draft in a local SQLite
   database (`data/campaigns.db`),
7. commits, pushes a new branch, and **opens a pull request** — a human
   always reviews and merges it. This service never merges anything.

GitHub itself — the PR, its commits, and a `CODEGEN_LOG.md` committed
alongside the new page — is the durable record of what happened and why.
The local SQLite database (`src/state/database-schema.mjs`) tracks campaign briefs,
run status/logs, and staged draft file versions for the HTTP status API and
UI while the service is alive; nothing in it is required to understand a
merged PR after the fact.

## Why this is a separate project

The parent `landing_page_automation` app renders campaign pages from a
`page_spec` JSON row in its own Supabase database — deliberately never
writing code files, because its own hosting can't accept runtime file writes.
This service solves a genuinely different problem: getting AI-generated code
**into a repository someone else owns and deploys**, where a pull request is
the correct (and only) delivery mechanism. Nothing here imports from, or
touches, the parent project's code or database.

## Setup

```bash
cd new_approach
npm install
npx playwright install chromium   # needed for hero-fit/seo-lint/a11y-lint checks
cp .env.example .env
```

Fill in `.env`:

| Var | Notes |
|---|---|
| `API_SHARED_SECRET` | any long random string — required on every request |
| `AI_PROVIDER` | `gemini` \| `claude` — for the research/guide/file-manifest stages |
| `CODING_AGENT_PROVIDER` | `gemini` \| `claude` — for the agentic coding loop. **Independent of `AI_PROVIDER` above** — run research on one provider and coding on the other if you like. Only the API key for whichever provider(s) you actually select are required |
| `GITHUB_TOKEN` | a token scoped to the **target** repo only (fine-grained PAT: contents + pull-requests, that one repo). Not required if `DRY_RUN_NO_PR=true` |
| `GITHUB_TARGET_OWNER` / `GITHUB_TARGET_REPO` / `GITHUB_BASE_BRANCH` | the external repo this service pushes into |
| `WRITE_PATH_ALLOWLIST` | **set this by hand** after looking at the target repo's real structure, e.g. `app/campaigns/{slug}/,components/campaigns/{slug}/` — deliberately not auto-derived from what the AI discovers |
| `PAGE_URL_PATH_TEMPLATE` | **set this by hand** too, e.g. `/campaigns/{slug}` — how to reach the new page once served, for the hero-fit/SEO/accessibility checks. Leave unset to skip those checks (build/lint still runs) |
| `TARGET_REPO_CLONE_URL` / `DRY_RUN_NO_PR` | see "Safe local dry run" below |

```bash
npm start   # http://localhost:4300
```

## API

All `/campaigns*` routes require `Authorization: Bearer <API_SHARED_SECRET>`.

```
POST /campaigns
  { "slug": "spring-sale", "campaignName": "...", "offer": "...",
    "audience": "...", "cta": "...", "brief": "free-form notes",
    "videoUrl": "https://... (optional)" }
  -> 202 { runId, status: "queued", statusUrl }

GET /campaigns              -> list of all runs (status, stage, PR url, ...)
GET /campaigns/:runId       -> status, stage, branchName, prUrl, log tail
GET /campaigns/:runId/log   -> full plain-text log
GET /campaigns/:runId/draft -> latest staged draft version's file paths + content (404 before verify first passes)
GET /campaigns/:runId/preview      -> active preview {kind, port, url, status, expiresAt} (404 if none)
POST /campaigns/:runId/preview/stop -> stop the active preview now, instead of waiting for its idle timeout
GET /healthz                -> unauthenticated liveness check
```

## Browser UI

There's also a small React + Vite SPA in `ui/` that drives the API above —
create campaigns and watch runs progress without curl. See
`documentation.md` for how to run it alongside the API.

## Safety model

The write tool (`src/llm/filesystem-tools.mjs`) enforces four independent checks, in
order, before any file is written — a hole in one can't defeat the others:

1. **Path containment** — no `..`, no absolute paths; must resolve inside the scratch clone.
2. **Pristine-file guard** — a snapshot of every file tracked by git is taken *immediately after clone*; none of them can ever be written to, regardless of what the allowlist or plan say.
3. **Human-set path allowlist** — `WRITE_PATH_ALLOWLIST`, resolved per-run with `{slug}`.
4. **File-plan match** — the path must be one the AI itself declared before coding started.

The agent has **no shell-exec tool** — it can only `list_files`, `read_file`,
`write_file`, and `finish_coding`. Verification (install/build/lint) is a
deterministic step the orchestrator runs itself, using the target repo's own
`package.json` scripts.

Git/GitHub sequencing guarantees a PR is never opened for code that doesn't
build: clone → branch (local only) → code → verify (retry once, else halt) →
stage draft → **preview** → **only then** commit → push → open PR. Nothing
is ever pushed to the base branch, and this service never calls the merge
endpoint.

## Preview

Once verify passes, a real server for the generated page starts automatically
— `GET /campaigns/:runId/preview` for its URL, `POST .../preview/stop` to
tear it down early. It runs inside a Docker container using the target
repo's own `Dockerfile` (its declared Node version) when the repo has one
and Docker is reachable; otherwise it falls back to spawning the repo's own
serve script directly. Previews are torn down by an idle timeout
(`PREVIEW_TTL_MS`, default 30 min), an explicit stop, or a soft cap on
concurrent previews (`MAX_CONCURRENT_PREVIEWS`) evicting the oldest —
whichever comes first, or on service restart (previews never resume across
a process lifetime). Its scratch worktree isn't cleaned up until the
preview itself is — that's the one exception to "commit/push/open_pr always
runs right after verify passes."

## Testing — no real target repo needed for most of this

```bash
npm test
```

Runs offline: the write-tool allowlist guard (the most important test in the
service), the Zod schemas, the GitHub API's pure request-building, and a real
`git clone → branch → commit → push` cycle against a local `git init --bare`
fixture (zero network, zero GitHub token).

To iterate on the agentic coding loop itself against the real Claude API
without touching git or GitHub at all:

```bash
node --env-file=.env dev/run-agent-standalone.mjs
```

It runs the loop against a small fixture folder created in a temp directory
and prints the transcript + which files it wrote.

### Safe local dry run — the whole pipeline, zero real repositories touched

Before pointing this at anything real, you can exercise **every stage,
including a live agentic coding session**, against a disposable local repo:

```bash
# 1. Make ANY small repo with a package.json "build" script into a local
#    "remote" — e.g. a fixture with app/ and components/ folders and an
#    esbuild-based build check (fast, no framework needed).
git init --bare -b main /tmp/fixture.git
# ...seed it with an initial commit on main from a working copy, then:
git push /tmp/fixture.git main

# 2. In .env:
TARGET_REPO_CLONE_URL=/tmp/fixture.git   # overrides the github.com URL
DRY_RUN_NO_PR=true                       # skips the real GitHub API call
GITHUB_TOKEN=                            # not needed in this mode

npm start
curl -X POST http://localhost:4300/campaigns \
  -H "Authorization: Bearer $API_SHARED_SECRET" -H "Content-Type: application/json" \
  -d '{"slug":"test-campaign","campaignName":"Test","offer":"...","audience":"...","cta":"..."}'
```

Research, the file plan, the full agentic coding loop, real `npm install` +
build verification, a real commit, and a real `git push` to the branch all
run for real — only the final GitHub "open PR" call is skipped. Inspect the
result directly:

```bash
git --git-dir=/tmp/fixture.git branch -a                       # new branch, main untouched
git --git-dir=/tmp/fixture.git diff --stat main codegen/...    # only new files
```

Once this looks right, set `GITHUB_TOKEN` + point `GITHUB_TARGET_OWNER`/
`GITHUB_TARGET_REPO` at a small disposable **sandbox GitHub repo** and unset
`TARGET_REPO_CLONE_URL`/`DRY_RUN_NO_PR` for a real first PR. Only repoint at
a real production repo once that's worked cleanly.

## What's deliberately out of scope (v1)

- No resume across a process restart (LangGraph checkpointing would enable
  this later — flagged, not built). A crashed run is marked `failed` (or
  `failed_push_incomplete` if a branch was already pushed, so a human can
  open the PR manually instead of losing the work silently).
- Monorepos (single `package.json` at the target repo's root is assumed).
- True multi-provider tool-use *within a single run* — the coding agent
  calls one provider's tool-use API per run (whichever `CODING_AGENT_PROVIDER`
  selects), not both at once.
