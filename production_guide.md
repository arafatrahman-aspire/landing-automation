# Production guide

Step-by-step instructions for pointing this campaign codegen service at a real frontend repository, configuring it with environment variables, and running it in production.

This service does **not** own the landing-page UI framework. It clones an **external target repo**, writes new campaign files under a human-configured allowlist, verifies that the target repo still builds, then opens a pull request.

---

## 1. What you are deploying

| Piece | Role |
|---|---|
| API (`src/server.mjs`) | Pipeline orchestration, SQLite state, preview lead-form sink |
| UI (`ui/`) | Marketing-facing campaign list / plan review / preview |
| Target repo | The real website (Next.js, Laravel, etc.) where campaign pages land |

Data on disk (defaults):

- `DB_PATH` → `./data/campaigns.db` (campaigns, runs, logs, drafts)
- `WORKDIR_ROOT` → `./data/.scratch` (shallow clones / git worktrees)

---

## 2. Pointing at a different target repository

Do this whenever you change the website the service writes into.

### Step 1 — Identify the repo and branch

You need:

- GitHub owner + repo name (or a custom clone URL)
- The base branch campaigns should branch from (often `main` or `dev`)
- A GitHub token with permission to clone, push branches, and open PRs

### Step 2 — Set target-repo env vars

In `.env`:

```bash
GITHUB_TARGET_OWNER=your-org
GITHUB_TARGET_REPO=your-frontend
GITHUB_BASE_BRANCH=dev
GITHUB_TOKEN=ghp_...          # required unless DRY_RUN_NO_PR=true
# Optional overrides:
# GITHUB_API_URL=https://api.github.com
# TARGET_REPO_CLONE_URL=https://github.com/your-org/your-frontend.git
```

`TARGET_REPO_CLONE_URL` is useful for local bare fixtures or non-GitHub hosts. If unset, the service builds:

`https://github.com/{GITHUB_TARGET_OWNER}/{GITHUB_TARGET_REPO}.git`

### Step 3 — Set `WRITE_PATH_ALLOWLIST` (required)

This is the **hard write boundary**. The coding agent may only create files under these prefixes. `{slug}` is replaced with the campaign slug at runtime.

Examples:

```bash
# Next.js App Router under src/
WRITE_PATH_ALLOWLIST=src/app/campaigns/{slug}/

# Next.js without src/
WRITE_PATH_ALLOWLIST=app/campaigns/{slug}/

# Multiple allowed trees (comma-separated)
WRITE_PATH_ALLOWLIST=src/app/campaigns/{slug}/,src/components/campaigns/{slug}/
```

How to choose it:

1. Clone the target repo locally.
2. Find where campaign / landing routes already live (or where you want them).
3. Use a path that becomes a **real route** in that framework.
4. Restart the API after changing it — config is validated once at startup.

Wrong allowlist = pages that never resolve as routes (classic Next “doesn't have a root layout” failure).

### Step 4 — Set `PAGE_URL_PATH_TEMPLATE` (strongly recommended)

Used by hero-fit / SEO / accessibility checks after build. Example for App Router campaigns:

```bash
PAGE_URL_PATH_TEMPLATE=/campaigns/{slug}
```

If unset, **build/lint still run**, but layout/SEO/a11y checks are skipped.

### Step 5 — Curate design grounding for *this* repo

Two human-edited catalogs live in **this** service, not in the target repo:

| File | Purpose |
|---|---|
| `src/design-catalog/reference-examples.mjs` | Real target-repo file paths used as prompt examples per section type |
| `src/design-catalog/static-frame-catalog.mjs` | Maps section types → reusable frame components + fillable data schemas |

After switching repos:

1. Open the target repo and list real components/pages that match hero, FAQ, pricing, etc.
2. Replace placeholder paths in `reference-examples.mjs` with paths that **exist** in that repo.
3. Update `static-frame-catalog.mjs` import paths / component names / `defaultData` to match that repo’s frames (or remove a section type’s static candidates so it becomes AI-required).
4. If you need a brand-new section type, edit `src/design-catalog/section-types.mjs` **and** both catalogs together — section types are a fixed enum, not free text.

Missing reference files do not crash a run; they only reduce plan quality. Broken static frame imports **will** fail verify.

### Step 6 — Package manager (if lockfiles are ambiguous)

```bash
# Leave unset for auto-detect (packageManager field → lockfile → npm)
PACKAGE_MANAGER_OVERRIDE=npm   # or yarn | pnpm
```

### Step 7 — Clear scratch state when switching repos

Old worktrees under `WORKDIR_ROOT` belong to the previous target. Safe practice:

```bash
# Stop the API first
rm -rf data/.scratch
# Keep campaigns.db if you want run history; wipe it if you want a clean slate:
# rm -f data/campaigns.db
```

Then restart the API so it re-clones the new base.

### Step 8 — Smoke-test before production traffic

```bash
DRY_RUN_NO_PR=true          # full pipeline except GitHub PR API
KEEP_WORKDIR_ON_FAILURE=true
```

Create one campaign from the UI, approve the plan, confirm verify + preview. Only then turn `DRY_RUN_NO_PR` off.

---

## 3. Environment variables reference

All vars are loaded and validated in `src/config.mjs` at process start. Modules never read `process.env` directly.

### Auth & process

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `API_SHARED_SECRET` | yes | — | Bearer token for API + UI (≥16 chars) |
| `PORT` | no | `4300` | API listen port |
| `SERVICE_PUBLIC_BASE_URL` | prod yes | `http://localhost:{PORT}` | Public URL of **this** API (preview lead forms POST here) |

### AI providers

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `AI_PROVIDER` | no | `gemini` | One-shot stages: research, guide, static copy (`gemini` \| `claude` \| `omniroute`) |
| `CODING_AGENT_PROVIDER` | no | `claude` | Agentic section coding loop (`gemini` \| `claude` \| `omniroute`) |
| `GEMINI_API_KEY` | if either provider is gemini | — | Google AI key |
| `ANTHROPIC_API_KEY` | if either provider is claude | — | Anthropic key |
| `GEMINI_MODEL` | no | `gemini-2.5-flash` | Model for Gemini one-shot calls |
| `CLAUDE_MODEL` | no | `claude-sonnet-5` | Model for Claude one-shot calls |
| `CODING_AGENT_MODEL` | no | follows coding provider | Override model for the coding agent only |
| `OMNIROUTE_BASE_URL` | if either provider is omniroute | `http://localhost:20128/v1` | OmniRoute OpenAI-compatible base URL |
| `OMNIROUTE_API_KEY` | no | unset | Dashboard key if the gateway requires auth |
| `OMNIROUTE_MODEL` | no | `auto` | Model id OmniRoute should route. **Pin a working id** from the OmniRoute dashboard — `auto` tries free Felo/OpenCode backends that often 400/401 |
| `SKIP_RESEARCH` | no | off | Skip research LLM call |
| `REVIEW_PLAN_BEFORE_GENERATING` | no | **on** | Pause for human plan edit before codegen (overridable per campaign via `reviewPlan`) |

### Target GitHub repo

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `GITHUB_TARGET_OWNER` | yes | — | Org/user |
| `GITHUB_TARGET_REPO` | yes | — | Repo name |
| `GITHUB_BASE_BRANCH` | no | `main` | Branch to fork from |
| `GITHUB_TOKEN` | unless dry-run | — | Clone / push / PR |
| `GITHUB_API_URL` | no | `https://api.github.com` | GitHub API base |
| `TARGET_REPO_CLONE_URL` | no | derived | Full git clone URL override |
| `DRY_RUN_NO_PR` | no | off | Run everything except opening a real PR |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | no | bot defaults | Commit author |

### Write & verify boundaries

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `WRITE_PATH_ALLOWLIST` | **yes** | — | Comma-separated write prefixes with `{slug}` |
| `PAGE_URL_PATH_TEMPLATE` | recommended | unset | Live page path for hero/SEO/a11y (e.g. `/campaigns/{slug}`) |
| `PACKAGE_MANAGER_OVERRIDE` | no | auto | Force `npm` / `yarn` / `pnpm` |
| `VERIFY_DISABLE_DOCKER` | no | **true** (host npm) | Set `false` to prefer Docker when a usable Dockerfile exists |
| `VERIFY_INSTALL_TIMEOUT_MS` | no | `300000` | Dependency install timeout |
| `VERIFY_BUILD_TIMEOUT_MS` | no | `600000` | Build/lint timeout |
| `VERIFY_SERVER_TIMEOUT_MS` | no | `30000` | Ephemeral preview server boot timeout |
| `MAX_AGENT_ITERATIONS` | no | `40` | Max tool-loop turns per section agent |
| `MAX_CODE_ATTEMPTS` | no | `3` | Verify → regenerate retries |
| `CONTINUE_ON_VERIFY_FAILURE` | no | off | Stage draft even if verify still fails (dangerous in prod) |
| `ENABLE_HERO_FIT_CHECK` | no | **true** | Set `false` to skip the hero above-the-fold check entirely (never fails a run) |
| `ENABLE_A11Y_CHECK` | no | **true** | Set `false` to skip the axe-core accessibility check entirely (never fails a run) |

### Preview sandboxes

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PREVIEW_TTL_MS` | no | 30 min | Idle preview lifetime |
| `MAX_CONCURRENT_PREVIEWS` | no | `3` | Soft cap (oldest stopped to make room) |
| `PREVIEW_SWEEP_INTERVAL_MS` | no | 60s | Idle sweep cadence |

### Storage & recovery

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DB_PATH` | no | `./data/campaigns.db` | SQLite database |
| `WORKDIR_ROOT` | no | `./data/.scratch` | Clone / worktree root |
| `KEEP_WORKDIR_ON_FAILURE` | no | off | Keep worktrees after failed runs (debug) |
| `RESUME_INTERRUPTED_RUNS` | no | **on** | On boot, resume mid-generation runs |

### Campaign images (optional)

Stock photos for campaign pages. **All of these are optional** — if any required piece is missing, research skips images and the campaign still generates (static frames fall back to dummy assets in the target repo).

Search order is **Pexels first**, then **SerpAPI Google Images** if Pexels returns nothing usable. Bytes are downloaded and uploaded to a **public** Supabase Storage bucket; only the public URL is written into campaign source under `src/app/campaigns/{slug}/`. Image binaries are never committed to the target repo.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PEXELS_API_KEY` | for photos | — | [Pexels API](https://www.pexels.com/api/) key (`Authorization` header) |
| `SERPAPI_API_KEY` | fallback | — | [SerpAPI](https://serpapi.com/) key for `engine=google_images` |
| `SUPABASE_URL` | for photos | — | Project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | for photos | — | Service role key (server-side upload only; never expose to the UI) |
| `SUPABASE_STORAGE_BUCKET` | no | `campaign-images` | Bucket name. Create it in Supabase Storage and set it **public** so `next/image` can fetch the objects |

Setup:

1. Create a Supabase project. In Storage, create bucket `campaign-images` (or your `SUPABASE_STORAGE_BUCKET` value) and mark it **public**.
2. Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from Project Settings → API.
3. Set `PEXELS_API_KEY`. Optionally set `SERPAPI_API_KEY` so Google Images can fill gaps.
4. Restart the API — config is validated at process start.

Copyright: Pexels photos are licensed for free use (attribution appreciated). SerpAPI Google Images results may include copyrighted photos — prefer Pexels hits, and review assigned URLs on the Plan tab before you publish. This service does not clear rights for you.

Slots (one photo each, skipped independently if search/upload fails): `details`, `timeline`, and `hero` only when the brief has no `videoUrl`. Testimonials and instructor sections never receive stock faces.

### UI

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `VITE_API_BASE_URL` | prod yes | `http://localhost:4300` | Built into the UI (`ui/`); must reach the API |

The UI also needs the same `API_SHARED_SECRET` entered in the browser (Authorization bearer).

---

## 4. Production deployment checklist

### A. Secrets & public URLs

1. Generate a strong `API_SHARED_SECRET` (≥16 chars; use a long random string).
2. Set `SERVICE_PUBLIC_BASE_URL` to the **public HTTPS** origin of the API (not localhost). Preview lead forms POST to `{SERVICE_PUBLIC_BASE_URL}/internal/preview-lead-sink`.
3. Put `GITHUB_TOKEN`, AI keys, and the shared secret in your secret manager — not in git. If campaign photos are enabled, also store `PEXELS_API_KEY`, optional `SERPAPI_API_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` there.
4. Build the UI with `VITE_API_BASE_URL=https://api.your-domain.example`.

### B. Process model

Recommended:

```bash
# API
npm ci
npm start          # node --env-file=.env src/server.mjs

# UI (separate process or static hosting)
cd ui && npm ci && npm run build
# Serve ui/dist behind your CDN / nginx, or `npm run preview` for a quick check
```

Use a process manager (systemd, PM2, Kubernetes) that:

- Restarts the API on crash
- Mounts a **persistent volume** for `DB_PATH` and preferably `WORKDIR_ROOT`
- Injects `.env` / secrets at runtime

`RESUME_INTERRUPTED_RUNS=true` (default) re-drives mid-generation runs after a crash. Runs already in commit/push/PR are **not** auto-resumed.

### C. Network & security

- Expose the API only over HTTPS.
- Require `Authorization: Bearer <API_SHARED_SECRET>` on all campaign routes.
- The preview lead sink (`POST /internal/preview-lead-sink`) is intentionally **unauthenticated** (called from the previewed page). It is a no-op logger — do not treat it as production lead intake.
- Restrict egress if your environment requires it: GitHub API, Gemini/Anthropic APIs, clone URLs, and (if campaign photos are enabled) Pexels, SerpAPI, and your Supabase project must remain reachable.
- Preview servers bind to local ports on the API host; put them behind the frameable proxy the service already starts, or firewall them from the public internet.

### D. Production-safe flags

| Setting | Production recommendation |
|---|---|
| `DRY_RUN_NO_PR` | `false` |
| `CONTINUE_ON_VERIFY_FAILURE` | `false` (never merge unverified pages by default) |
| `KEEP_WORKDIR_ON_FAILURE` | `false` (disk) / `true` briefly while debugging |
| `REVIEW_PLAN_BEFORE_GENERATING` | `true` for launch campaigns |
| `VERIFY_DISABLE_DOCKER` | `true` unless you have validated the Docker path |
| `SKIP_RESEARCH` | `false` |

### E. Capacity notes

- Each verify run may run `npm ci` + `npm run build` in a worktree — CPU/RAM heavy.
- Cap concurrent campaigns operationally (one or few at a time) until you know host size.
- `MAX_CONCURRENT_PREVIEWS` limits live preview sandboxes.
- SQLite is single-writer: one API process per `DB_PATH`.

### F. Observability

- Use the UI **Activity log** tab and `GET /campaigns/:runId/log`.
- Persist `data/campaigns.db` backups (copy the file when the API is idle, or use SQLite backup APIs).
- Watch for repeated verify failures naming files **outside** the allowlist — that usually means the target base branch is poisoned; quarantine helps locally, but fix the base branch for good (`fix-target-repo.sh` pattern).

---

## 5. Day-2 operations

### Changing only the base branch

Update `GITHUB_BASE_BRANCH`, clear `data/.scratch`, restart.

### Changing AI vendor/model

Swap `AI_PROVIDER` / `CODING_AGENT_PROVIDER` (`gemini` \| `claude` \| `omniroute`) and keys/models. No code change required. Restart the API.

For OmniRoute, run the gateway locally first (`npx omniroute`, default `http://localhost:20128`), then:

```bash
AI_PROVIDER=omniroute
CODING_AGENT_PROVIDER=omniroute
OMNIROUTE_BASE_URL=http://localhost:20128/v1
OMNIROUTE_MODEL=auto
# OMNIROUTE_API_KEY=...   # only if the gateway dashboard issued a key
```

`auto` is not a reliable default for this pipeline. If research fails with `Felo thread creation failed` / OpenCode `401`, pin `OMNIROUTE_MODEL` to a model that succeeds in the OmniRoute dashboard (or `GET /v1/models`), then restart this API.

Gemini/Claude implementations are unchanged. OmniRoute does not attach Gemini-style web search; research still runs using the routed model.

### Adding or retuning section types

1. Edit `section-types.mjs`.
2. Add references in `reference-examples.mjs`.
3. Optionally add static frames in `static-frame-catalog.mjs`.
4. Restart and run a dry campaign.

### Approving a campaign in production

1. Create campaign in UI (or `POST /campaigns` with the shared secret).
2. Review **Plan** (brief, research keywords, SEO, section briefs) → Approve.
3. Wait for verify + preview.
4. Review the live preview and section refine tools.
5. Approve → commit / push / PR against `GITHUB_BASE_BRANCH`.
6. Merge the PR in GitHub after normal code review.

### Local vs production quick matrix

| Goal | Key env |
|---|---|
| Safe local experiment | `DRY_RUN_NO_PR=true`, localhost `SERVICE_PUBLIC_BASE_URL` |
| Staging against real repo, no PR | `DRY_RUN_NO_PR=true` + real `GITHUB_*` |
| Production | Real secrets, `DRY_RUN_NO_PR=false`, `CONTINUE_ON_VERIFY_FAILURE=false`, public `SERVICE_PUBLIC_BASE_URL` + `VITE_API_BASE_URL` |

---

## 6. Minimal production `.env` skeleton

```bash
API_SHARED_SECRET=replace-with-long-random-secret
PORT=4300
SERVICE_PUBLIC_BASE_URL=https://codegen-api.example.com

AI_PROVIDER=gemini
CODING_AGENT_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash

GITHUB_TOKEN=...
GITHUB_TARGET_OWNER=your-org
GITHUB_TARGET_REPO=your-frontend
GITHUB_BASE_BRANCH=dev
WRITE_PATH_ALLOWLIST=src/app/campaigns/{slug}/
PAGE_URL_PATH_TEMPLATE=/campaigns/{slug}

REVIEW_PLAN_BEFORE_GENERATING=true
DRY_RUN_NO_PR=false
CONTINUE_ON_VERIFY_FAILURE=false
RESUME_INTERRUPTED_RUNS=true

DB_PATH=./data/campaigns.db
WORKDIR_ROOT=./data/.scratch
```

UI build:

```bash
cd ui
VITE_API_BASE_URL=https://codegen-api.example.com npm run build
```

---

## 7. Related files

| Path | Why it matters |
|---|---|
| `src/config.mjs` | Canonical env schema and defaults |
| `src/design-catalog/reference-examples.mjs` | Per-repo prompt grounding |
| `src/design-catalog/static-frame-catalog.mjs` | Per-repo static section frames |
| `src/design-catalog/section-types.mjs` | Fixed section-type enum |
| `fix-target-repo.sh` | One-off repairs for poisoned files on the target base branch |
| `workflow.md` / `documentation.md` | Deeper architecture and change history |
