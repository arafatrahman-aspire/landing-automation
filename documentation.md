# Documentation

Living developer doc for this service's conversion toward `new_plan.md`'s
architecture. Unlike `README.md` (quickstart/reference), this file is a
running narrative + changelog: what changed each phase, why, how it works,
and how to verify it — so a developer joining later can read this one file
top to bottom and understand how the system got to its current shape.

The conversion plan itself lives at
`.claude/plans/i-want-to-completely-parsed-lightning.md` (or wherever your
session saved it) — this file records what was *actually done*, phase by
phase, as it happens.

---

## Architecture overview (as of this phase)

```
POST /campaigns (brief)
   -> intake -> research -> generate_guide -> file_manifest -> clone -> code
                                                                          |
                                                                  (retry on failure,
                                                                   capped)
                                                                          v
                                                                       verify
                                                                          |
                                                                     pass v
                                                              commit -> push -> open_pr -> END
```

This is still the **original linear pipeline** — it auto-commits/pushes/opens
a PR the moment `verify` passes, with no human review gate yet. That gate
(the whole point of `new_plan.md`) arrives in Phase 6. Until then, every
phase stays a complete, runnable, PR-producing demo — new capabilities get
added *alongside* this flow before the flow itself is restructured.

Two processes make up the system:
- **`src/`** — the Express + LangGraph orchestrator service (`npm start`,
  port `4300` by default).
- **`ui/`** — a separate React + Vite single-page app that talks to the
  Express API over HTTP. It is never touched by the coding agent — the
  agent's `workdir` is always the *target* repo's scratch clone, never this
  service's own repo.

## Running it locally

```bash
# Terminal 1 — API
cd new_approach
npm install
cp .env.example .env   # fill in secrets, see README.md
npm start              # http://localhost:4300

# Terminal 2 — UI
cd new_approach/ui
npm install
cp .env.example .env   # VITE_API_BASE_URL, defaults to http://localhost:4300
npm run dev            # http://localhost:5173
```

Open the UI, paste in the same value as your `.env`'s `API_SHARED_SECRET`
when prompted (kept in `sessionStorage`, sent as `Authorization: Bearer` on
every request), then create a campaign from the form.

For a fully safe run that touches no real GitHub repo, follow README.md's
"Safe local dry run" recipe (`git init --bare` fixture +
`TARGET_REPO_CLONE_URL` + `DRY_RUN_NO_PR=true`) before pointing this at
anything real — the UI works identically against that fixture.

## What's deliberately deferred right now

See `new_plan.md` for the full target architecture and README.md's "What's
deliberately out of scope (v1)" section for the pre-existing list. This
conversion adds to that list as it goes — each phase's entry below notes
what it intentionally left for a later phase.

---

## Version log

### v0.1 — Phase 0 — 2026-07-17 — Working demo: frontend-targeted pipeline + browser UI

**In short:** Fixed the pipeline to generate real frontend page code (it was
targeting the wrong kind of output before) and built the first browser UI,
so campaigns no longer have to be run via curl/bash scripts.
**Visible change:** A working web app at `localhost:5173` — create a
campaign, watch it move through stages, see the finished PR link.

**What changed and why:** The pipeline's `research`/`guide`/`fileManifest`/`code`
prompts (`src/orchestrator/steps.mjs`) previously targeted a Python/FastAPI
backend module — the wrong output entirely for a *landing page* automation
system. Rewrote all four to target `.tsx`/`.jsx`/CSS files in a frontend
repository, added the hero contract (title + video-or-details + lead form,
above the fold, side-by-side desktop / stacked mobile) as explicit guidance
in the `code` system prompt, and added an optional `videoUrl` field to the
campaign brief (`src/schemas/brief-schema.mjs`) so the guide can decide
whether the hero shows a video or a details summary. Removed the
Python-specific `packageSlug()` underscore-conversion (kebab-case directory
names are fine for frontend paths) and deleted the dead Python verification
branch (`verifyPython`/`detectPython`/`ruffAvailable`) from
`src/verify/build.mjs` — this service only ever verifies Node/frontend repos
now, via their own `package.json` `build`/`lint` scripts.

There was previously no way to drive this service other than curl/bash
(`post.sh`, `test-api.sh`). Added a `GET /campaigns` list endpoint
(`src/server.mjs`, backed by `run-store.listRuns()`, which already existed)
and a `cors` middleware so a browser SPA on a different origin can send the
`Authorization` header. Also had `run-store.createRun` start persisting
`campaignName` (previously only the `slug` was kept), since the UI's
campaign list wants a human-readable name.

Built a new top-level `ui/` package (React + Vite + TypeScript +
react-router-dom, scaffolded via `npm create vite@latest ui -- --template
react-ts`): a one-time shared-secret prompt gate, `CampaignListPage` (polls
`GET /campaigns` every 4s), `NewCampaignPage` (brief form, client-side
slugify-from-name), and `RunDetailPage` (polls `GET /campaigns/:runId` +
`GET /campaigns/:runId/log` every 2s until the run reaches a terminal
status, shows the PR link or dry-run branch name on completion). All API
calls go through `ui/src/api.ts`, a thin fetch wrapper that attaches the
bearer token and normalizes error handling.

**How it works:** Nothing about the orchestrator's control flow changed —
`verify` passing still goes straight to `commit → push → open_pr`
automatically (unchanged in `src/orchestrator/graph.mjs`). This phase is a
content fix (right output type) plus new read surface (list endpoint) plus
a new consumer (the UI) — no new persistence, no new pipeline stages.

**Deferred to later phases (see plan):** the design-context catalog
(section types are still free text in the guide, not yet a fixed enum) —
Phase 1. Layout/SEO/accessibility checks in `verify` — Phase 2. Any
database/staging layer (still flat-JSON `run-store.mjs`) — Phase 3. Preview
sandbox, LLM validation, and the actual human approve/edit/reject gate —
Phases 4–6.

**How to verify:** see the Phase 0 entry in the conversion plan — start the
server against the local dry-run fixture, start the UI, create a campaign
in the browser, watch it move through stages and complete with a pushed
branch.

**Files touched:** `src/orchestrator/steps.mjs`, `src/schemas/brief-schema.mjs`,
`src/verify/build.mjs`, `src/server.mjs`, `src/state/run-store.mjs`,
`.env.example` (scrubbed placeholder secrets), new `ui/` package.

### v0.2 — Phase 0 bugfix — 2026-07-18 — Real ecosystem flexibility (target repo isn't always Next.js)

**In short:** Fixed a crash ("No package.json at repo root") caused by the
pipeline planning files before it ever looked at the real target repo, and
made it work against PHP/Laravel repos, not just Next.js/React ones.
**Visible change:** None in the UI — campaigns against real repos (whatever
their tech stack) stop failing immediately at the code-generation step.

**What changed and why:** Manual verification of v0.1 hit `"No package.json
at repo root"` on `verify`. Root cause was two-fold, and both are permanent:
the *actual* target repo this points at will change over time and may be a
Laravel/PHP app, a Next.js app, or something else entirely — this service
can't hardcode assumptions about it. Two fixes:

1. **Pipeline reorder** (`src/orchestrator/graph.mjs`): `clone` used to run
   *after* `generate_guide`/`file_manifest`, meaning those stages had to
   guess the target repo's file conventions blind before a single file of it
   had been read — `file_manifest` would lock in `.tsx` paths that might not
   match reality at all. Moved `clone` to run right after `research`, before
   `generate_guide`/`file_manifest`. New helper
   `steps.detectRepoConventions(workdir)` does a shallow scan right after
   clone (package.json → framework guess from deps; composer.json → PHP/
   Laravel signal + a note that routing files can't be touched, so the page
   stays unwired for a human to register; top-level directory listing) and
   its output is now injected into both the `guide` and `file_manifest`
   prompts, so file paths/extensions are chosen from what's actually there,
   not assumed.
2. **`verify/build.mjs` ecosystem detection, widened**: `findPackageJsonDir`
   now also checks one level of subdirectories (covers a Laravel app whose
   JS asset pipeline lives in a subfolder, or a small monorepo). If no
   package.json is found anywhere but `composer.json` exists, a new
   `verifyPhp()` path runs `php -l` (syntax-only, no framework bootstrap) on
   any newly created **plain** `.php` files — deliberately excluding
   `.blade.php` templates, since Blade directives (`@extends`, `{{ }}`)
   aren't valid raw PHP syntax and would false-positive fail. `verifyBuild`
   now again accepts `changedPaths` (removed in v0.1, needed again here) so
   the PHP gate knows which files are actually new.

**How it works:** This re-introduces an "ecosystem-aware" branch structurally
similar to the Python branch deleted in v0.1 — but this time it's Node vs.
PHP or (the repo is a *frontend* delivery target either way, unlike the old
Python/FastAPI mistake), and it's here because the target repo's stack is
explicitly expected to vary, not because of a wrong assumption.

**Verified:** ran a real end-to-end cycle against the local dry-run fixture
(real Gemini calls, no GitHub touched). Confirmed via the log: `research →
clone → guide → file_manifest → code` ordering is correct, `detectRepoConventions`
picked up the fixture's `package.json`/`app/`/`components/` structure, the
agent explored `package.json` and an existing `.tsx` file before writing, and
produced real frontend files under the allowlisted path referencing "React/
Next.js conventions with Tailwind CSS." The original `"No package.json at
repo root"` error is gone. (The run then failed at `npm ci` because my
throwaway fixture had no `package-lock.json` — a fixture gap, not a service
bug; a real target repo already has one committed.)

**Deferred:** a full PHP artisan-bootstrap check (routes/service providers)
— out of scope, the additive/isolated model means a syntax-only gate is the
meaningful one. The Laravel routing-file conflict (a new Blade page needs a
route added to `routes/web.php`, an existing file the agent can never touch)
is handled by explicitly leaving it unwired and flagging it in the PR
reviewer checklist for a human to do — not solved automatically.

**Files touched:** `src/orchestrator/graph.mjs`, `src/orchestrator/steps.mjs`,
`src/verify/build.mjs`, `test/verify-build.test.mjs`.

### v0.3 — Phase 1 — 2026-07-18 — Design-context catalog + structured guide

**In short:** The content plan (which page sections to include, hero copy,
SEO fields) is now structured and validated instead of free text, and it's
grounded in real code read from the target repo instead of guessed blind.
**Visible change:** The run detail page now shows a "Plan" panel — hero
title, SEO fields, and a table of chosen sections with a ✓/✗ per reference
file showing whether matching code was actually found in the target repo.

**What changed and why:** Two new modules implement `new_plan.md` §4.3/§4.4.
`src/design/schema.mjs` defines the fixed section-type catalog (`hero`,
`details`, `timeline`, `testimonials`, `faq`, `curriculum`, `pricing`,
`instructor`, `footer-cta`) as a Zod enum, plus shape-validation for the
catalog file itself. `src/design/catalog.mjs` is the human-curated
section→reference-file map — **shipped with placeholder paths** (e.g.
`components/Hero.tsx`) that need editing against whatever the real target
repo turns out to be; it self-validates at import time (fail loud, same
pattern as `config.mjs`) but a placeholder catalog is still valid shape-wise,
so it doesn't block anything — missing files just resolve to "not found."
`src/design/resolve.mjs`'s `resolveSectionReferences()` reads the actual
file content for a set of section types out of the just-cloned workdir,
returning `null` (not throwing) for any path that doesn't exist in this
particular repo.

`steps.guide()` was rewritten from a free-text spec into a structured,
Zod-validated plan (`src/schemas/guide-schema.mjs`) — `heroTitle`,
`heroHasVideo`, `seoTitle`, `seoMetaDescription`, and an ordered `sections`
array whose `type` can ONLY be one of the fixed catalog values (ships with
the same parse/validate/retry-up-to-2 pattern `fileManifest()` already used).
It calls `resolveSectionReferences` for **all** catalog section types before
generating, so the model chooses which sections to include having actually
seen real code for each option, not guessed blind. `fileManifest()` then
resolves references again for just the **chosen** sections and injects that
real code into its own prompt too (per §4.3, both stages get grounded
examples) — and persists a lightweight `{sectionType, note, files: [{path,
found}]}` summary to run-store so the API/UI can show which reference files
actually grounded the plan, without bloating the status JSON with full file
contents.

**Bug found and fixed during verification:** the real Gemini calls
initially failed schema validation repeatedly — `seoTitle`/
`seoMetaDescription` kept exceeding their character limits even after the
prompt stated the limits explicitly ("70 characters MAX", etc.), because
LLMs are unreliable at exact character counting. Since length is an
objectively fixable detail (not a structural problem worth burning a
regeneration attempt on), added `truncateGuideFields()` to
`guide-schema.mjs`, which clamps oversized string fields to their schema max
(with a trailing "…") **before** validation runs, so a two-character
overage no longer costs a retry or a failed run.

**How it works:** `guide()`'s output is now an object, not a string — updated
every place that previously interpolated `state.guide` as raw text
(`fileManifest()`'s prompt, `code()`'s system prompt, `CODEGEN_LOG.md`) to
`JSON.stringify` it instead. Both `guide` and the new `sectionReferences`
summary are persisted via `runStore.updateRun()` (previously neither was
persisted at all — only kept in in-process LangGraph state), which is what
makes them visible to `GET /campaigns/:runId` and therefore to the UI.

**UI:** `RunDetailPage` gained a read-only "Plan" panel: hero title/video
flag/SEO fields, plus a table of chosen sections with a ✓/✗ per reference
file showing whether the design catalog actually found a matching file in
this run's target repo. Renders directly off the existing `GET
/campaigns/:runId` response — no new endpoint needed.

**Verified:** ran a full end-to-end cycle against the local dry-run fixture
(real Gemini calls). The guide correctly chose 5 sections (hero, details,
testimonials, faq, footer-cta) — never anything outside the fixed enum —
set `heroHasVideo: true` correctly from a supplied video URL, and
`sectionReferences` correctly reported `found: true` for the fixture's real
`app/about/page.tsx` and `components/Button.tsx` and `found: false` for the
catalog's placeholder paths that don't exist in this particular repo. Run
completed end-to-end (`status: completed`) with a branch pushed to the local
fixture. Added 15 new unit tests (`design-schema`, `design-resolve`,
`guide-schema`, including the truncation fix) — 43 passing, 1 skipped (PHP
gate, no `php` interpreter in this environment).

**Deferred:** the design catalog itself is still placeholder content — not
"done" until a human populates it against the real target repo (matches the
plan's own phase-2 note). `code()` doesn't re-fetch section references
itself since the coding agent already has direct `read_file` access to the
same repo — no duplicate context injection needed there.

**Files touched:** `src/design/schema.mjs`, `src/design/catalog.mjs`,
`src/design/resolve.mjs` (new), `src/schemas/guide-schema.mjs` (new),
`src/orchestrator/steps.mjs`, `ui/src/api.ts`, `ui/src/pages/RunDetailPage.tsx`,
`ui/src/App.css`, `test/design-schema.test.mjs`, `test/design-resolve.test.mjs`,
`test/guide-schema.test.mjs`.

### v0.4 — Small feature — 2026-07-18 — Delete a campaign

**In short:** Added a way to remove old or throwaway campaigns instead of
them piling up forever in the list.
**Visible change:** A "Delete campaign" button on any finished or failed
campaign, in both the campaign list and its detail page (hidden while a run
is still in progress).

**What changed and why:** No way existed to clear out a run's local
record/log — every test or throwaway campaign accumulated forever in
`data/runs/`. Added `runStore.deleteRun(runId)`, which removes a run's
`.json`+`.log` files, but **only once its status is terminal**
(`completed`/`failed*`) — deleting the JSON file out from under an in-flight
`graph.invoke()` would make its next `updateRun`/`heartbeat` call throw
("no such run"), so a still-`running` run returns a `409` instead. Wired up
as `DELETE /campaigns/:runId` in `server.mjs` (404 if the run doesn't exist,
409 with the current status if it's not terminal yet, 204 on success — also
best-effort removes any leftover scratch workdir under `data/.scratch/`).
**This only ever removes this service's own local bookkeeping** — it never
touches a branch already pushed or a PR already opened on GitHub; that's
stated explicitly in both the confirm dialogs and the code comments so
nobody mistakes "delete campaign" for "revert the PR."

**UI:** `CampaignListPage` gets a "delete" action per terminal row (a
"running…" label instead, no button, while a run is in progress);
`RunDetailPage` gets a "Delete campaign" button in the header, shown only
once terminal, which navigates back to the list on success. Both confirm
before deleting.

**Verified:** real run against the local fixture — confirmed `409` while
running, `404` for a nonexistent run, `204` once terminal, `404` on a
follow-up `GET`, and that the `.json`/`.log` files are actually gone from
`data/runs/` afterward.

**Note from this verification pass:** while testing, I found a stray
`node src/server.mjs` process from an earlier test session was still bound
to port 4300 (background processes started during tool calls don't reliably
get cleaned up between separate command invocations in this environment) —
it was serving an older build of the code, which is why an early delete
attempt 404'd unexpectedly. Killed it and confirmed a fresh process behaves
correctly. Separately, I noticed a `node --watch src/server.mjs` process
already running (started 21:59, presumably from following the earlier
verify instructions) that isn't currently bound to any port — worth checking
on if you still have that terminal open.

**Files touched:** `src/state/run-store.mjs`, `src/server.mjs`,
`ui/src/api.ts`, `ui/src/pages/CampaignListPage.tsx`,
`ui/src/pages/RunDetailPage.tsx`, `ui/src/App.css`.

### v0.5 — Phase 2 — 2026-07-18 — Deterministic verify suite: hero-fit, SEO, accessibility

**In short:** Verification now checks more than "does it build" — it also
checks the hero section actually fits on screen on both desktop and mobile,
basic SEO tags are present, and accessibility rules aren't violated.
**Visible change:** The run detail page now shows a "Verify" panel with a
pass/fail/skipped badge for each of Build/lint, Hero fit, SEO, and
Accessibility.

**What changed and why:** `verify/build.mjs` only ever checked build/lint.
Added three new Playwright-based checks per `new_plan.md` §4.5/§4.6 Layer 1:
- `src/verify/hero-fit.mjs` — loads the staged page at 1440×900 (desktop)
  and 390×844 (mobile), measures the bounding boxes of the hero title,
  video-or-details block, and lead form, and fails with the exact
  per-viewport pixel overflow if any of them falls below the fold.
- `src/verify/seo-lint.mjs` — title/meta-description length, exactly one
  `<h1>`, `alt` text on every image, canonical tag, JSON-LD, Open Graph
  tags, viewport meta.
- `src/verify/a11y-lint.mjs` — WCAG 2A/2AA via axe-core
  (`@axe-core/playwright`): contrast, ARIA misuse, unlabeled fields, etc.

**Design decision — how the checks find the hero elements:** locating
"the title," "the video-or-details block," and "the form" reliably on an
arbitrary generated page (React, Vue, Blade, whatever) isn't solvable with
generic heuristics (which `<div>` is "the media block"?). Instead,
`steps.mjs`'s `code()` system prompt now requires the agent to mark exactly
three elements with `data-hero-title` / `data-hero-media` / `data-hero-form`
attributes — invisible to visitors, and a missing one is reported as a
structured, fixable error exactly like an overflow, not a guess.

**New supporting modules:** `src/verify/package-manager.mjs` (extracted from
`build.mjs` — shared package-manager/script-running helpers, reused by...),
`src/verify/local-server.mjs` (`startEphemeral` — starts the target repo's
own `start`/`preview`/`dev` script on an OS-assigned free port via the
`PORT` env var, polls until it responds, always torn down by the caller),
and `src/verify/index.mjs` (`runFullVerifySuite` — the coordinator: build/lint
first, fail fast; only if that passes AND a page URL path is configured,
starts the ephemeral server and runs hero-fit/seo/a11y together so one retry
surfaces every failing dimension at once).

**New config:** `PAGE_URL_PATH_TEMPLATE` (e.g. `/campaigns/{slug}`) — how to
reach the new page once served. Deliberately human-set, not derived, same
philosophy as `WRITE_PATH_ALLOWLIST`: routing conventions vary too much
(and for Laravel, the page isn't wired into routing at all until a human
does it — see v0.2), so there's nothing to derive automatically. **Left
unset by default** — the three new checks are skipped (not failed) with a
clear note in the report until it's configured, so this doesn't break
existing campaigns pointed at a repo that hasn't been set up for it yet.

**Real bug found and fixed during verification:** `startEphemeral` spawns
`npm run <script>`, but npm forks the actual server as a genuinely separate
process from the "npm" CLI wrapper — killing just the wrapper's pid left
the real server running forever, leaking a process bound to a port on every
failed/timed-out attempt. Fixed by spawning `detached: true` (child becomes
its own process-group leader) and killing the whole group
(`process.kill(-pid, signal)`) on both the timeout and `stop()` paths.
Caught this by literally leaking two orphaned `node server.js` processes
during test-writing and tracing why a test run hung indefinitely.

**UI:** `RunDetailPage` gained a "Verify" panel with a pass/fail/skipped
badge per check (Build/lint, Hero fit, SEO, Accessibility), reading the new
`verifyChecks` field persisted onto the run record.

**Verified, and what I could NOT verify here:** ran a real end-to-end cycle
— build/lint passed, and `verifyChecks` correctly showed `hero`/`seo`/`a11y`
as `null` ("skipped — PAGE_URL_PATH_TEMPLATE is not configured"), confirming
the coordinator's dispatch logic and persistence path work correctly, and
that a campaign run isn't blocked by the new checks when they're not yet
configured. **I could not download a real Chromium binary in this sandbox**
(`npx playwright install chromium` fails — the sandbox's network egress
doesn't reach `cdn.playwright.dev`), so the actual pass/fail behavior of
hero-fit/seo-lint/a11y-lint against a real rendered page is untested by me.
The three new test files (`test/hero-fit.test.mjs`, `test/seo-lint.test.mjs`,
`test/a11y-lint.test.mjs`) are real (fixture pages, real assertions, no
mocks) and will run for real the moment Chromium is actually installed —
they currently skip cleanly here via a `hasChromium()` capability check
(same pattern as the pre-existing PHP-not-installed skip). **On your own
machine**, run `npx playwright install chromium` (add `--with-deps` if you
have sudo and want the OS-level libs too) and then `npm test` — those 7
tests should go from skipped to passing. If they don't, that's a real bug
for me to fix, not something to paper over.

**Deferred:** sharing one page load across all three checks (my earlier
plan draft's idea, for efficiency) — kept each check's own independent
browser lifecycle instead, since it makes each module trivially testable in
isolation, at the cost of ~3 browser launches instead of 1 per verify
attempt. Golden fixture library beyond the pass/fail cases already
written — expand from real usage, not up front.

**Files touched:** `src/verify/package-manager.mjs` (new, extracted),
`src/verify/local-server.mjs`, `src/verify/hero-fit.mjs`,
`src/verify/seo-lint.mjs`, `src/verify/a11y-lint.mjs`, `src/verify/index.mjs`
(all new), `src/verify/build.mjs` (refactored to use the extracted module),
`src/config.mjs`, `src/orchestrator/steps.mjs`, `ui/src/api.ts`,
`ui/src/pages/RunDetailPage.tsx`, `ui/src/App.css`,
`test/local-server.test.mjs`, `test/hero-fit.test.mjs`,
`test/seo-lint.test.mjs`, `test/a11y-lint.test.mjs`,
`test/helpers/static-server.mjs` (all new).

### v0.6 — Small feature — 2026-07-19 — Reuse a persistent base clone instead of cloning fresh every run

**In short:** Instead of re-downloading the whole target repo on every
single campaign, it's now cloned once and reused — every run after the
first starts noticeably faster.
**Visible change:** None in the UI — runs just get to the "clone" stage
faster, especially the second campaign onward.

**What changed and why:** `clone()` used to run a full `git clone --depth 1`
of the real target repo into a brand-new `data/.scratch/<runId>/` directory
on **every single campaign run** — slow, and wasteful of bandwidth/CI minutes
once the target repo is a real frontend app (node_modules-sized history
aside, cloning itself gets slower the more branches/tags a real repo
accumulates over time). Requested directly: reuse whatever's already cloned
instead of re-cloning each time.

Replaced with a **persistent base clone + per-run git worktrees**:
- The very first run (or the first run after `data/.scratch/_base` is
  deleted) does the one real `git clone` into `data/.scratch/_base/`.
- Every run after that reuses `_base` — `syncBaseToLatest()` does a cheap
  `git fetch --depth 1 origin <baseBranch>` + `git reset --hard
  origin/<baseBranch>` to bring it up to date (no re-download of the whole
  repo, just the new commit(s)).
- Each run then gets its own isolated working directory via `git worktree
  add -b <branchName> <workdir> <baseBranch>` — a real, separate checkout
  (so concurrent runs never step on each other's files or npm installs) that
  shares `_base`'s `.git` object store instead of duplicating it. This is
  what `code()`/`verify()` still write into and build inside, completely
  unchanged from before.
- Cleanup (`removeWorktree()` in `src/git/ops.mjs`) replaces the old raw
  `rm -rf <workdir>` at the end of `openPr()` (both the dry-run and real-PR
  paths) and in the `DELETE /campaigns/:runId` route — a worktree can't just
  be `rm -rf`'d, since the base clone keeps metadata about it under
  `_base/.git/worktrees/`; left behind, that metadata accumulates and can
  confuse future `git worktree add` calls. `removeWorktree` runs `git
  worktree remove --force`, then `worktree prune`, then deletes the now-dead
  local branch (`git branch -D`) — all best-effort, since cleanup should
  never block the rest of a request.
- `KEEP_WORKDIR_ON_FAILURE=true` still works exactly as before: a failed
  run's worktree is simply never removed, left in place under
  `data/.scratch/<runId>/` for inspection, same as when it was a plain
  clone. The only thing that changed is *how* a workdir comes to exist and
  how it's torn down — not the failure-preservation behavior.

**Why worktrees and not, say, just resetting one shared directory:** a
single shared working directory would mean two concurrent runs (or a
still-open review of one run while a second is submitted) would stomp on
each other's checked-out branch and uncommitted files. Worktrees give every
run a real, independent directory and branch while still sharing the one
network clone underneath — the actual thing the user asked to avoid
repeating.

**Concurrency:** all runs sharing one `_base` checkout is new — before,
concurrent runs never touched each other's directory. Two campaigns started
close together would otherwise race on `_base`'s own `fetch`/`reset`/
`checkout`. Added `withBaseCloneLock()` in `steps.mjs`, a simple in-process
promise-chain mutex serializing just the "ensure/sync `_base`" step;
`git worktree add` itself runs outside the lock since it's safe to call
concurrently once `_base` is settled.

**Verified:** ran `steps.clone()` twice in sequence against a local
`git init --bare` fixture (own throwaway script, not committed) — first call
logged "no cached base clone yet — cloning..." and created `_base`; second
call logged "reusing cached base clone... syncing to latest" and did **not**
reclone, returning a second, distinct workdir. Then ran a full clone → write
a file → `commitPaths` → `push` → `removeWorktree` cycle and confirmed via
`git branch -a`/`git diff --stat` on the bare fixture that only the new file
landed on a real branch; confirmed `removeWorktree` actually removes the
worktree (`git worktree list` no longer shows it) while `_base` stays intact
and a third run's `clone()` still succeeds afterward. Separately fired
`Promise.all()` over three concurrent `clone()` calls against the same fresh
fixture and confirmed all three settle successfully with three distinct
worktree directories (no lock contention errors, no corrupted `_base`).
Also reran the full `npm test` suite (56 tests, 48 pass, 8 skip for the same
pre-existing Chromium/PHP environment reasons as v0.5, 0 fail) to confirm
nothing else regressed.

**Files touched:** `src/git/ops.mjs` (added `syncBaseToLatest`,
`addWorktree`, `removeWorktree`; `cloneShallow`/`createLocalBranch` kept
as-is for the one-time base clone and for `test/git-ops.test.mjs`, which
exercises them directly and needed no changes), `src/orchestrator/steps.mjs`
(`clone()` rewritten; `openPr()`'s two cleanup call sites switched from raw
`rm` to `removeWorktree`), `src/orchestrator/graph.mjs` (added `baseDir` to
the LangGraph state so `openPr()` can reach it), `src/server.mjs` (`DELETE
/campaigns/:runId` switched to `removeWorktree`, fetching the run's
`branchName` before `deleteRun()` erases the record).

### v0.7 — Bugfix — 2026-07-19 — "Coding agent hit max iterations without calling finish_coding"

**In short:** The AI would finish writing every planned file, but then run
out of allowed "turns" one step before it could say it was done, so the
whole run failed even though the work was basically finished.
**Visible change:** Campaigns against real (non-trivial) repos no longer
fail with this error after successfully generating all their files.

**What broke:** a real run against a real (non-toy) target repo failed
`code` on both attempts with this error. The log
(`data/runs/afcee49f-....log`) showed exactly what happened: the agent spent
~9 iterations exploring the repo (`list_files`/`read_file`), then wrote all
6 planned files one-per-iteration — and then, on both attempts, simply ran
out of budget one step before ever calling `finish_coding` (attempt 2 even
rewrote `page.tsx` a second time instead of finishing). `MAX_AGENT_ITERATIONS`
was set to `15` in `.env` — enough for a small fixture repo, not enough once
exploration + a full file plan (up to 8 files, per `file-manifest-schema.mjs`)
+ the final `finish_coding` call are added up. This gets worse, not better,
on a bigger real codebase, since exploration alone eats more of the budget
before any file is even written.

**Fix (two parts):**
1. Raised `MAX_AGENT_ITERATIONS` from `15` to `40` in `.env`, `.env.example`,
   and the `config.mjs` fallback default — a real repo needs meaningfully
   more headroom than the fixture ever did.
2. `src/ai/coding-agent.mjs` no longer just hopes the model calls
   `finish_coding` on its own once done — after every tool-result turn, both
   the Claude and Gemini loops now check whether every path in the file
   manifest has actually been written (`allManifestFilesWritten()`) and, if
   so, append an explicit "call finish_coding now, don't write anything
   else" nudge to that same turn's response. This directly targets what the
   log showed (the model rewriting an already-finished file instead of
   finishing) and reduces wasted iterations regardless of repo size, rather
   than only papering over it with a bigger cap.

**Verified:** `node --check` on both changed files; full `npm test` (56
tests, 48 pass, 8 skip for the same pre-existing environment reasons, 0
fail) confirms nothing regressed; loaded `coding-agent.mjs` with the real
`.env` via `node --env-file=.env` to confirm config parses cleanly with the
new default. The next real campaign run against the same target repo is the
actual end-to-end confirmation — retry the "security" campaign (or delete
it and start a new one) and confirm `code` now finishes within budget.

**Files touched:** `.env`, `.env.example`, `src/config.mjs`,
`src/ai/coding-agent.mjs`.

### v0.8 — Bugfix — 2026-07-19 — "yarn install failed: spawn yarn ENOENT"

**In short:** Verification crashed on any repo using yarn, because `yarn`
simply wasn't installed as a command on this machine.
**Visible change:** Campaigns against yarn-based repos no longer fail
verification with "spawn yarn ENOENT."

**What broke:** the very next real run (v0.7's fix worked — `code` now
called `finish_coding` on time) hit a new error in `verify`: `yarn install
failed: spawn yarn ENOENT`. `ENOENT` from `spawn` means the `yarn` binary
itself isn't on `PATH` in the environment `server.mjs` runs in — confirmed
with `which yarn` (nothing) vs. `which corepack` (`/usr/bin/corepack`,
ships with Node itself). The target repo has a `yarn.lock`, so
`detectPackageManager()` correctly picked `yarn` — but `INSTALL_CMD.yarn`/
`RUN_SCRIPT_CMD.yarn` in `src/verify/package-manager.mjs` spawned a bare
`yarn` command, assuming it was globally installed. It wasn't, on this host.

**Fix:** `src/verify/package-manager.mjs`'s yarn/pnpm entries now spawn
through `corepack yarn ...` / `corepack pnpm ...` instead of a bare
`yarn`/`pnpm` binary. Corepack ships with Node (guaranteed present, unlike a
separately-installed global yarn/pnpm) and also correctly respects the
target repo's own `packageManager` field in `package.json` when it has one,
so this is more correct, not just a workaround. `npm` is untouched (it
always ships with Node). `local-server.mjs` needed no change — it already
gets its spawn command generically via `RUN_SCRIPT_CMD[pm](...)`, so it
benefits from this fix automatically.

**Separately, in that same run's log** (not a bug): `code` first tried this
slug and every planned file was rejected as `"already_exists"` — the
pristine-file guard correctly refusing to touch files, because they already
exist on the target repo's base branch under that campaign's slug path
(almost certainly because an earlier run for the same slug already got
merged there). This is the guardrail working as designed, not something to
relax — retrying the *same slug* against a repo where it already landed
should fail exactly like this. If you want to regenerate that page, use a
different slug, or delete/revert the existing files on the target repo
first.

**Verified:** built a real throwaway fixture with a `yarn.lock` + a `build`
script and ran `verifyBuild()` against it directly — confirmed `corepack
yarn install` + `corepack yarn run build` both succeed and `verifyBuild`
returns `{ok: true}` (this exact fixture reproduced the original failure
before the fix, and passes after). Full `npm test` (56 tests, 48 pass, 8
skip, 0 fail) confirms nothing regressed.

**Files touched:** `src/verify/package-manager.mjs`.

### v0.9 — UI polish — 2026-07-19 — Professional visual redesign (no API/behavior changes)

**In short:** Redesigned the entire UI to look professional instead of like
default scaffolding — new colors, cards, and a step-by-step progress
tracker. No behavior changed, purely visual.
**Visible change:** The whole app looks different — a proper topbar with a
brand mark, summary stat cards on the campaign list, a stage-by-stage
progress stepper on each run's detail page, polished forms/tables/badges.

**What changed and why:** the UI worked but looked like scaffolding — flat
tables, no visual hierarchy, no sense of pipeline progress. Requested
directly: make it look "much more good and professional." This is a
**pure presentation pass** — no new endpoints, no changed data flow, no
component logic beyond small derived-display helpers (relative time,
status-label formatting). Every existing feature (create/list/delete,
polling, log tail, plan/verify panels) works exactly as before.

- `src/index.css` — replaced the flat token set with a fuller design-token
  system (accent tuned to match the existing purple `favicon.svg` mark,
  soft/strong variants for ok/bad/warn/live states, radius/shadow scale),
  refined base typography, focus rings, scrollbar styling.
- `src/App.css` — full component rebuild: sticky/blurred topbar, a
  reusable `.card`/`.card-header`/`.card-body` system, a proper button
  system (primary/secondary/ghost/danger), status pills with a colored
  dot (plus a pulsing dot for "live" states), a stage **stepper** for the
  pipeline, stat cards, a real empty-state pattern, refined form/table/log
  styling.
- `src/App.tsx` — added a small brand mark, switched nav links to
  `NavLink` so the current page is visually highlighted, restyled the
  shared-secret gate as a proper card instead of a bare form.
- `CampaignListPage.tsx` — added summary stat cards (total/running/
  completed/failed) above the table, human-readable relative timestamps
  (`"3m ago"`, full timestamp on hover via `title`), a real empty state
  with an icon instead of a plain sentence.
- `NewCampaignPage.tsx` — grouped the brief form inside a card, paired
  fields into responsive two-column rows (name+slug, CTA+video URL),
  added a "Cancel" action back to the list.
- `RunDetailPage.tsx` — added a `Stepper` component visualizing the
  pipeline's actual stage sequence (`intake → research → clone → guide →
  file_manifest → code → verify → committing → pushing → opening_pr`,
  matching the exact `heartbeat(...)` stage strings `steps.mjs` writes),
  marking each step done/current/failed from `run.stage`/`run.status`;
  wrapped the Plan panel in a `.card` to match the rest of the page.

**Verified:** `npm run build` (`tsc -b && vite build`) succeeds with zero
type errors, producing a normal-sized bundle (12KB CSS, 249KB JS); `npm run
lint` (oxlint) passes clean, exit code 0. Inspected the built CSS output
directly (brace-balance check, no leftover artifacts) since **I could not
visually render the app myself in this sandbox** (no browser available) —
you should open `http://localhost:5173` after `npm run dev` (or `npm run
preview` on the `dist/` build) and confirm it actually looks right; if
anything looks off, tell me what and I'll adjust — I'm verifying
correctness (compiles, type-checks, lints, valid CSS) here, not the
rendered result.

**Files touched:** `ui/src/index.css`, `ui/src/App.css`, `ui/src/App.tsx`,
`ui/src/pages/CampaignListPage.tsx`, `ui/src/pages/NewCampaignPage.tsx`,
`ui/src/pages/RunDetailPage.tsx`.

### v0.10 — Bugfix — 2026-07-19 — "yarn install failed... Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`"

**In short:** A second recurring verify failure on the same target repo —
its `yarn.lock` file was already out of sync with `package.json` (pre-existing,
nothing this service caused), and the strict install mode hard-failed on
that instead of just fixing it locally.
**Visible change:** Campaigns against that repo no longer fail verification
with "Your lockfile needs to be updated."

**What broke:** verify kept failing on a real target repo with: yarn
warning about a `package-lock.json` existing alongside `yarn.lock` (both
lockfiles present — leftover from a past package-manager switch, most
likely), then a hard error because `yarn.lock` doesn't match
`package.json` and `INSTALL_CMD.yarn` used `--frozen-lockfile`. This isn't
something the coding agent caused — it can never modify an existing
`package.json` or lockfile (the pristine-file guard forbids it) — so this
was pre-existing drift in the target repo that would fail **every** run
against it, forever, with `--frozen-lockfile` in place. Same latent risk
existed for npm (`npm ci` is equally strict about lockfile/package.json
sync) even though it hadn't been hit yet.

**Fix, two parts, both in `src/verify/package-manager.mjs`:**
1. `detectPackageManager()` now checks `package.json`'s own
   `packageManager` field first (the field Corepack itself treats as
   authoritative, e.g. `"npm@10.2.3"`) before falling back to "which
   lockfile exists" — lockfile presence alone is ambiguous when more than
   one is committed, like here.
2. Dropped the frozen/CI-strict install flags across the board: `npm ci`
   → `npm install`, `yarn install --frozen-lockfile` → `yarn install`,
   same for pnpm. This is safe specifically **because** of two existing
   guarantees: the agent can never touch an existing lockfile/package.json,
   and this install only ever runs inside a throwaway worktree — 
   `commitPaths` only stages the declared manifest files + `CODEGEN_LOG.md`
   (see `steps.mjs` `commit()`), so a lockfile updated here during install
   is never part of what gets committed or pushed. A plain install can
   safely resolve pre-existing drift locally instead of hard-failing on a
   problem this service didn't create and can't fix by retrying code.

**Verified:** built a throwaway fixture reproducing the exact failure —
`package.json` depending on `left-pad`, an empty `package-lock.json`, and a
`yarn.lock` that doesn't list `left-pad` (so `--frozen-lockfile` would
refuse it). Confirmed it failed the same way before the fix and now
`verifyBuild()` returns `{ok: true}`, with `yarn.lock` actually updated
in-place to include the resolved dependency. Full `npm test` (56 tests, 48
pass, 8 skip, 0 fail) confirms nothing regressed.

**Files touched:** `src/verify/package-manager.mjs`.

### v0.11 — Phase 3 — 2026-07-19 — Database staging layer (SQLite)

**In short:** Replaced the old flat-JSON storage with a real SQLite
database, and every generated file is now saved as a versioned "draft"
record the moment verification passes — groundwork for the future
approve/reject review step.
**Visible change:** The run detail page now shows a "Files" panel listing
exactly which files were generated for that campaign, once verify passes.

**What changed and why:** per the approved conversion plan, this phase
replaces the flat-JSON `state/run-store.mjs` with a real database and adds
a versioned record of exactly what the coding agent wrote for each run —
laying groundwork Phase 6 (review/reject/edit) will depend on, without yet
building anything Phase 6-specific.

- **`src/state/schema.mjs`** — idempotent `CREATE TABLE IF NOT EXISTS` for
  nine tables: `campaigns` (the immutable submitted brief), `runs` (mutable
  pipeline state — status/stage/attempts/branch/PR/guide/verify-checks,
  plus nullable "resume-state" columns — `workdir`, `research_notes_json`,
  `file_manifest_json`, `pristine_files_json`, `allowlist_json`,
  `current_draft_version` — that nothing populates yet; they exist now
  because additive SQLite columns are free and this avoids a migration
  story later), `run_logs` (replaces both the bounded in-memory tail and
  the unbounded `.log` file — `LIMIT`/`ORDER BY` do both jobs now),
  `draft_files` (this phase's actual new capability), and four schema-only
  scaffold tables for later phases (`verify_reports`, `validation_reports`,
  `previews`, `review_decisions`, `token_usage` — declared, not yet written
  to by any code).
- **`src/state/db.mjs`** — the one shared `node:sqlite` `DatabaseSync`
  connection (WAL mode, foreign keys on), created at import time from
  `config.dbPath`, schema applied once via `initSchema()`.
- **`src/state/sqlite-repository.mjs`** — every function the old
  `run-store.mjs` had (`createRun`, `getRun`, `updateRun`, `heartbeat`,
  `appendLog`, `getFullLog`, `listRuns`, `isTerminal`, `deleteRun`,
  `reconcileCrashedRuns`), same names and signatures, now backed by real
  SQL instead of a JSON file + an in-process write-lock. **The write-lock
  is gone entirely** — the old flat-JSON store needed a per-runId promise
  chain to avoid read-modify-write races across concurrent
  `updateRun`/`appendLog` calls; SQLite makes each `UPDATE`/`INSERT` one
  atomic statement, so there's nothing left to race.
- **`src/state/repository.mjs`** — a one-line re-export facade
  (`export * from "./sqlite-repository.mjs"`). This is **the** swap point
  a future backend change (e.g. Supabase, for a hosted multi-instance
  deployment) would touch — every other module imports from here, never
  from `sqlite-repository.mjs` directly. `server.mjs`, `steps.mjs`, and
  `graph.mjs` each changed exactly one import line to pick this up; nothing
  else about their code changed.
- **`src/staging/draft-store.mjs`** (new) — `stageNewVersion({runId,
  files})`, `getLatestVersion(runId)`, `diffFromPrevious(runId)`. A new
  `stage_draft` graph node (`orchestrator/steps.mjs` `stageDraft()`,
  wired into `orchestrator/graph.mjs` between `verify` (on pass) and
  `commit`) reads the actual file contents the agent wrote off the scratch
  worktree and records them as version 1 (or N, on a future regenerate) in
  `draft_files`. New `GET /campaigns/:runId/draft` endpoint serves the
  latest version; `RunDetailPage` gets a read-only "Files" panel listing
  the staged paths and content length. `diffFromPrevious` has no caller
  yet — it's only meaningful once a run has been regenerated at least
  once, which is Phase 6 — but it's a small, independently correct, fully
  tested pure function, unlike a stub with no real behavior.
- **Deliberately NOT built this phase, despite being named in the
  plan:** `src/staging/materialize.mjs`. The plan listed it as created in
  Phase 3 but "used from Phase 6 onward" — building a file with zero
  callers and no real target to write into yet would be exactly the
  "half-finished implementation" I try to avoid. Its actual job (writing a
  staged draft version's files back onto disk somewhere real) will land
  whenever Phase 4 (preview) or Phase 6 (review) first needs it — Phase
  4's preview may not even need it, since the scratch worktree already has
  the files on disk live during that synchronous graph run. Flagging this
  now so it doesn't look like an oversight later.
- **Small additive change, not scope creep:** `POST /campaigns` now passes
  the full validated brief into `createRun({..., request})`, stored as
  `campaigns.brief_json`. The old run-store never persisted the original
  offer/audience/cta/brief text at all (only slug + campaignName) — free to
  add right where the data was already in hand, and directly useful for
  the Phase 6 resume-state columns later.
- **Config:** `RUN_STATE_DIR` removed, `DB_PATH` added (default
  `./data/campaigns.db`), in `config.mjs`, `.env`, and `.env.example`.

**Verified:**
- New test files `test/schema.test.mjs`, `test/sqlite-repository.test.mjs`,
  `test/draft-store.test.mjs` (real temp-file SQLite databases, no mocks —
  same convention as the rest of this suite) cover: all nine tables exist
  and schema init is idempotent; the full `createRun`/`getRun`/`updateRun`/
  `heartbeat`/`appendLog`/`getFullLog`/`listRuns`/`deleteRun`/
  `reconcileCrashedRuns` cycle, including the 409-not-terminal and
  404-not-found delete paths and the "already-pushed branch" crash-recovery
  distinction; `stageNewVersion`/`getLatestVersion`/`diffFromPrevious`
  including added/removed/modified path detection across two versions.
  New `test/helpers/test-config-env.mjs` factors out the env-vars-before-
  first-import requirement `config.mjs` imposes (documented inline).
- Ran the real `steps.stageDraft()` function directly against a real temp
  workdir with real files on disk and a real temp SQLite database (no
  mocks) — confirmed it reads the files, stages them, and the run's stage
  updates correctly — plus confirmed `createCodegenGraph()` compiles with
  the new node wired in, without needing a real AI provider key.
- Started the real `server.mjs` against a temp SQLite DB and hit
  `/healthz` and `/campaigns` for real — confirms server boot, schema
  auto-creation, and the new import paths all work together, not just in
  isolation.
- Full `npm test`: 76 tests, 68 pass, 8 skip (same pre-existing
  Chromium/PHP environment gaps as before), 0 fail.
- UI: `npm run build` (tsc + vite) and `npm run lint` (oxlint) both pass
  clean with the new `Draft`/`getRunDraft` type/fetch and "Files" panel.

**Files touched:** `src/config.mjs`, `.env`, `.env.example`, `README.md`;
new `src/state/schema.mjs`, `src/state/db.mjs`,
`src/state/sqlite-repository.mjs`, `src/state/repository.mjs`,
`src/staging/draft-store.mjs`; `src/orchestrator/steps.mjs` (import switch +
new `stageDraft`), `src/orchestrator/graph.mjs` (import switch + new node/
edge + failure-status entry), `src/server.mjs` (import switch + brief
passed to `createRun` + new draft endpoint); deleted
`src/state/run-store.mjs`; new `test/schema.test.mjs`,
`test/sqlite-repository.test.mjs`, `test/draft-store.test.mjs`,
`test/helpers/test-config-env.mjs`; UI: `ui/src/api.ts`,
`ui/src/pages/RunDetailPage.tsx`.

### v0.12 — Bugfix — 2026-07-19 — "Module not found: Can't resolve 'react-icons/fa6'" (agent repeated the same mistake on retry)

**In short:** The AI picked an icon import that doesn't exist in this
repo's installed package version, and when given a second chance to fix it,
guessed wrong again instead of checking how the repo's own existing code
does it. Told it to always copy real import paths from the repo instead of
guessing from general knowledge.
**Visible change:** Campaigns generating icon (or similar sub-path) imports
should no longer fail build with "Module not found," and won't repeat an
identical mistake on retry.

**What broke:** a real run (`10a67f70-...`) failed `verify` on both code
attempts with the identical error: `Module not found: Error: Can't resolve
'react-icons/fa6'`. Traced it by inspecting the failed run's still-on-disk
worktree directly (`KEEP_WORKDIR_ON_FAILURE=true` kept it around):
`package.json` has `"react-icons": "^4.7.1"` installed, and
`node_modules/react-icons` genuinely has no `fa6` folder — that icon set was
added in react-icons v5, this repo is on v4. Worse: this repo's own
**pre-existing** `src/components/layout/Footer.js` already imports icons
correctly, via `react-icons/fa` (confirmed by reading it directly out of the
worktree) — the coding agent had a perfect, real example of the right
import sitting right there, and used the wrong one anyway, almost certainly
defaulting to newer-version knowledge from training data rather than
checking this specific repo. On the retry, `verifyReport` was fed back into
the prompt as instructed, but the agent produced the exact same unresolvable
import again instead of correcting it.

**Fix:** `orchestrator/steps.mjs`'s `code()` system prompt gained two new
instructions: (1) a standing rule that any import beyond a package's plain
root export must be copied from a real existing usage found by reading
other files in the repo, never guessed from general/training knowledge,
since a package's exposed sub-paths vary by installed major version — if
nothing in the repo already imports it, that's a signal to avoid
introducing it rather than gamble a sub-path guess; (2) the retry-feedback
block now explicitly calls out the "Module not found" case by name,
instructing the agent to find and copy an existing successful import of
that same package rather than trying a different guess.

**Verified:** confirmed via direct inspection of the real failed workdir
(not a synthetic fixture — the actual repo, actual installed
`react-icons@4.7.1`, actual pre-existing `Footer.js` using the correct
`react-icons/fa` path) that this is exactly the failure mode the new prompt
guidance targets. This is a prompt-quality fix, not something a unit test
can exercise (no mocked LLM in this suite, by design) — `node --check` and
the full `npm test` (76 tests, 68 pass, 8 skip, 0 fail) confirm nothing else
regressed. Real confirmation is the next campaign run: watch whether a
retry after a "Module not found" error actually fixes the import instead of
repeating it.

**Files touched:** `src/orchestrator/steps.mjs`.

### v0.13 — Bugfix — 2026-07-19 — Same "react-icons/fa6" error persisted; added a package-manager override and a deterministic import-example scan

**In short:** The v0.12 prompt fix wasn't enough — the log showed the agent
never actually looked at any file that imports `react-icons` on either
attempt, despite being told to. Instead of only asking it to look, the
orchestrator now does the looking itself and hands over real examples.
Also added a way to force npm for this target repo, since it also has a
stale `yarn.lock` sitting next to the `package-lock.json` it actually uses.
**Visible change:** None you'll interact with directly, but two concrete
effects: verify now installs with npm on this repo (was yarn), and a code
retry after a "Module not found" error now gets shown the repo's own real
working import line for that package, instead of just being told to go
find it.

**What broke, part 1 — same error, prompt alone didn't fix it:** a new run
(`1108434c-...`) hit the identical `Can't resolve 'react-icons/fa6'` error
on both attempts, even after v0.12's prompt change. The log shows exactly
why: on both attempts the agent read `package.json` and a page file
(`Home.js`), but never opened any component file that actually imports
`react-icons` — it never did the exploration the prompt asked for, it just
wrote its guess directly. Telling a model to "go check" doesn't guarantee
it will.

**Fix, part 1 — do the checking in code, not in the prompt:** new
`findExistingImportExamples({workdir, verifyReport})` in
`orchestrator/steps.mjs`. When a previous verify failure contains
`Can't resolve 'X'`, it extracts the base package name (handling scoped
packages, e.g. `@radix-ui/react-icons`), then scans the repo's own source
files (`.js/.jsx/.ts/.tsx/.vue`, skipping `node_modules`/`.git`/build
output, capped at 3000 files scanned / 8 examples found so a pathological
repo can't make a retry hang) for real lines that already import that
package, and injects up to 8 of them verbatim into the retry prompt as
"copy this exact path." This replaces hoping the model explores with
actually handing it the answer — a deterministic fix for a
non-deterministic model behavior, and one this suite can actually unit
test (an LLM prompt-wording change can't be).

**What broke, part 2 — asked directly "why yarn, use npm":** this target
repo has both `package-lock.json` and a leftover `yarn.lock` (previously
diagnosed in v0.10 as stale drift); `detectPackageManager()`'s fallback
order picks `yarn.lock` over the npm default when there's no
`packageManager` field to disambiguate. Auto-detection guessing wrong here
was the direct ask to fix.

**Fix, part 2:** new `PACKAGE_MANAGER_OVERRIDE` config var (`npm`|`yarn`|
`pnpm`, optional) — when set, `detectPackageManager(workdir, override)`
returns it immediately, before checking the `packageManager` field or any
lockfile. Threaded through every caller (`verify/build.mjs`,
`verify/local-server.mjs`, `verify/index.mjs`) as an explicit parameter
rather than importing `config.mjs` into those lower-level modules (keeps
them dependency-free and directly testable against plain fixture
directories, same as before). `steps.mjs`'s `verify()` passes
`config.packageManagerOverride` in. Set to `npm` in the real `.env` for
this repo; left unset (auto-detect, unchanged default) in `.env.example`.

**Verified:** `test/find-existing-import-examples.test.mjs` (new, 5 tests,
real temp directories, no mocks) confirms the scan finds a real import,
ignores `node_modules`, handles scoped packages, and returns nothing when
there's no verify report yet or nothing in the repo imports the package at
all. Added a case to `test/verify-build.test.mjs` confirming the override
wins even with a conflicting lockfile present, and that behavior is
unchanged when it's not set. Confirmed the real `.env` parses cleanly with
`packageManagerOverride: "npm"` via `node --env-file=.env`. Full `npm
test`: 82 tests, 74 pass, 8 skip (same pre-existing environment gaps), 0
fail. The import-scan fix targets a real, reproduced failure directly, but
— like v0.12 — it changes model behavior, so the actual confirmation is
the next campaign run against this repo.

**Files touched:** `src/config.mjs`, `.env`, `.env.example`,
`src/verify/package-manager.mjs`, `src/verify/build.mjs`,
`src/verify/local-server.mjs`, `src/verify/index.mjs`,
`src/orchestrator/steps.mjs`; new `test/find-existing-import-examples.test.mjs`;
`test/verify-build.test.mjs`.

### v0.14 — Feature + root-cause found — 2026-07-19 — Docker-based verify build, and "react-icons/fa6" was never the agent's bug

**In short:** Added Docker-based install/build (using the target repo's OWN
Dockerfile and Node version) as an alternative to running npm/yarn directly
on this service's host — requested directly, since the host's npm is much
newer than what the repo's Dockerfile declares. Using it immediately
uncovered the real cause of the recurring `react-icons/fa6` failure: **it
was never something the AI wrote.** It's a pre-existing broken import
already committed on the target repo's own `main` branch, unrelated to any
campaign.
**Visible change:** Verify now builds inside a real Docker container
(matching the repo's own `Dockerfile` and Node version) when one is
present, instead of using whatever Node/npm happens to be on this host.

**What was asked:** "donot directly use npm install, it is run on a very
old npm... so use docker, is there any other way to verify?" — a fair
concern independent of the earlier lockfile/import debugging: this
service's host has npm 11 installed, but the target repo's own `Dockerfile`
declares `node:14.18.2`, which ships npm 6 — a very different install
engine (peer-dependency resolution, lockfile version handling, etc. changed
substantially across those major versions). Installing under the "wrong"
npm risks behaving differently than the project's real, working build,
independent of anything this service does.

**Fix:** new `src/verify/docker-build.mjs`:
- `hasDocker()` — probes `docker info` (daemon actually reachable, not just
  the CLI present on PATH).
- `parseDockerBuildStage(workdir)` — reads the target repo's root
  `Dockerfile`, if any, and extracts the **first** build stage only (a
  multi-stage Dockerfile's later stages, e.g. `FROM nginx:latest` for
  serving, are irrelevant here) — its `node:` base image, plus every `RUN`
  command in that stage, in order. Returns `null` if there's no Dockerfile
  or the first stage isn't a `node:` image (falls back to the existing
  host-based path in that case, so this is purely additive for repos
  without one).
- `verifyBuildInDocker({workdir, nodeImage, commands, ...})` — runs the
  extracted commands as one `docker run --rm` against that exact image,
  bind-mounting the worktree as `/app` — no `COPY` steps needed since the
  mount already has everything. `--user <host-uid>:<host-gid>` so files
  Docker writes (`node_modules`, `build/`) come out owned by the actual
  host user, not root (otherwise the later `git worktree remove` cleanup
  would fail to delete them) — verified directly, not assumed. A unique
  `--name` lets a timeout `docker kill` the specific container instead of
  just killing the local CLI process, which wouldn't necessarily stop it
  server-side.
- `verify/build.mjs`'s `verifyBuild()` tries this path first (when not
  disabled and a usable Dockerfile + reachable Docker exist), extracted
  into `verifyNodeInDocker()` — which also runs `npm run lint` inside the
  same container afterward if `package.json` declares one and the
  Dockerfile's own commands didn't already include it, so Docker-verified
  repos get the same lint gate as host-verified ones, not a weaker one.
- New `VERIFY_DISABLE_DOCKER` config (default off — Docker is used
  automatically when available and applicable) threaded through
  `verify/index.mjs` and `steps.mjs`'s `verify()`, same pattern as
  `packageManagerOverride`.

**The actual root-cause discovery:** to confirm this fix for real (not a
synthetic fixture), I created a disposable `git worktree` off the cached
`data/.scratch/_base` clone — a byte-for-byte copy of the real target
repo's current `main`, no campaign, no AI-written files, nothing from this
service touching it at all — and ran `verifyBuild()` against it directly.
**It failed with the exact same error:** `Module not found: Error: Can't
resolve 'react-icons/fa6'`. Grepping confirmed why:
`src/components/home/PlayGroundVideo.js` — a file already committed on
`main` (`git log`: commit `2ff8f74`, "testing frontend", 2026-07-18) —
itself imports `FaDownload` from `react-icons/fa6`, which doesn't exist in
this repo's installed `react-icons@4.7.1`. **Every prior "fix" this
session (v0.12's prompt guidance, v0.13's deterministic import-scan
retry-helper) was chasing a symptom that could never be fixed from this
service's side** — the target repo's own `main` branch doesn't build
clean, independent of anything any campaign does, because the whole
`src/` tree gets compiled by `react-scripts build`, not just a campaign's
new files under `app/campaigns/`. Those two fixes are still legitimate,
useful hardening (a real unresolved import from something the agent itself
writes is a real scenario), they just weren't what was actually failing
here. **The only real fix for this specific error is on the target repo's
own `main` branch** — either fix or revert that import in
`PlayGroundVideo.js` (e.g. `react-icons/fa`, matching what `Footer.js`
already uses correctly, per v0.12's investigation) — this service cannot
fix a pre-existing bug in a file it never touches and never will.

**Verified:** `test/docker-build.test.mjs` (new, 9 tests) — 5 against
`parseDockerBuildStage` (no Dockerfile, non-Node first stage, correct
extraction ignoring later stages/commented lines, no-RUN-commands case)
plus 4 **real** `docker run` tests (using the already-locally-cached
`node:14.18.2`, so no network pull needed and the suite stays fast): a
real successful install+build, a real build failure with real captured
container output, a real timeout that kills the container within
~1s instead of hanging for the full sleep, and a real ownership check
confirming files land as the host user, not root. All pass. Full `npm
test`: 91 tests, 83 pass, 8 skip (same pre-existing environment gaps), 0
fail. Then confirmed against the real target repo itself (not a fixture,
as described above) — Docker path engages correctly (`docker run
(node:14.18.2) [npm cache clean --force && npm install --force && npm run
build]`), a real `npm install` of 1520 packages succeeds under the correct
npm version, and the remaining failure is conclusively the pre-existing
`main`-branch bug, not anything this service produced.

**Files touched:** new `src/verify/docker-build.mjs`, new
`test/docker-build.test.mjs`; `src/verify/build.mjs` (Docker path +
`verifyNodeInDocker`), `src/verify/index.mjs` (`disableDocker` threaded
through), `src/config.mjs` (`VERIFY_DISABLE_DOCKER`),
`src/orchestrator/steps.mjs` (passes `config.verifyDisableDocker` in),
`.env.example`.

### v0.15 — Phase 4 — 2026-07-20 — Preview sandbox (Docker-first, process fallback)

**In short:** Once verify passes, the generated page now gets served by a
real, clickable preview — a live server you can actually open in a
browser, not just pass/fail badges. It runs inside Docker (using the
target repo's own Dockerfile) when available, falling back to spawning the
repo's own dev server directly otherwise.
**Visible change:** The run detail page gets a new "Preview" panel with a
live URL, an "Open in new tab" link, an expiry countdown, and a "Stop
preview" button, once a run reaches that stage.

**Decision revisited from the original plan:** `new_plan.md`'s Phase 4 spec
explicitly said preview would be process-based, not Docker, for v1. The
Docker-based build-verify work earlier this session (v0.14) changed that
calculus: once a repo's `node_modules` gets installed inside a
`node:14.18.2` container (as now happens automatically for a repo with a
Dockerfile), spawning the *serve* step on the host with a different Node
version risks native-module ABI mismatches, and wouldn't match the
project's real runtime anyway. Asked directly, confirmed: preview should
follow build's lead — Docker when the repo has a usable Dockerfile, process
fallback otherwise. Not a unilateral change to a previously agreed decision.

**What was built:**
- **`src/preview/sandbox.mjs`** (new) — `startPreview`, `getPreview`,
  `stopPreview`, `sweepIdlePreviews`, `reconcilePreviewsOnBoot`. Unlike
  `verify/local-server.mjs`'s ephemeral server (closure-based `stop()`,
  torn down within the same request that started it), a preview is
  DB-tracked and *must* survive the request that started it — a human
  clicks the link later, an idle sweep runs on a timer in a different tick
  entirely. So state lives in the `previews` table (`kind`, `port`,
  `pid`/`container_name`, `url`, `status`, `expires_at`), not in an
  in-memory map — `stopPreview`/the sweep can act on a preview purely from
  its DB row, regardless of which process invocation started it.
  - **Docker mode**: reuses `verify/docker-build.mjs`'s
    `parseDockerBuildStage()` for just the repo's declared `node:` image
    (not its install/build commands — preview needs the *serve* script,
    e.g. `npm start`), runs `docker run -d`-equivalent (foreground, tracked
    by a unique `--name`) bind-mounting the worktree, `-p <port>:<port>`,
    `--user <host-uid>:<host-gid>` (same bind-mount ownership reasoning as
    v0.14's build path).
  - **Process mode**: same detached/process-group spawn pattern as
    `local-server.mjs`, but the **pid** is what's persisted (not a
    closure) — `stopPreviewRow` calls `process.kill(-pid, signal)` fresh
    each time, working even from a completely different process
    invocation (e.g. the sweep, on a timer, long after the original
    request finished).
  - `getFreePort`/`waitForReady`/`SERVE_SCRIPT_PREFERENCE` extracted as
    exports from `local-server.mjs` for reuse rather than duplicated.
- **New `preview_build` graph node** (`orchestrator/steps.mjs`
  `previewBuild()`, wired into `orchestrator/graph.mjs` between
  `stage_draft` and `commit`) — **non-fatal by design**: whether or not a
  preview actually starts, the graph still auto-continues to
  commit/push/open_pr (Phase 6 is what adds a real human gate; until then
  preview is a convenience, not a blocker).
- **Deferred worktree cleanup** — this is the one real behavioral change
  to the existing pipeline, not just an addition: `openPr()`'s two cleanup
  call sites now check `state.previewStarted` and skip `removeWorktree`
  when a preview is running (it's still reading from that exact
  directory — deleting it out from under a live preview would break the
  very thing `preview_build` just started). Cleanup instead happens from
  the preview's own lifecycle — `stopPreviewRow()` (used by
  `stopPreview`, `sweepIdlePreviews`, `reconcilePreviewsOnBoot`, and the
  `DELETE /campaigns/:runId` route) calls `removeWorktree` itself once the
  preview actually stops. This needed `runs.workdir` to actually start
  being populated (`clone()` now persists it) — previously an inert
  "resume-state" column from Phase 3's schema, since a sweep running on a
  timer has no in-process LangGraph state to read `workdir` from; it has
  to reconstruct the worktree path from the DB alone.
- **Schema migration, for real this time**: `previews` already existed
  (empty) from Phase 3's schema-only scaffolding, without the columns
  Phase 4 actually needs (`kind`, `container_name`, `url`) —
  `CREATE TABLE IF NOT EXISTS` doesn't retroactively add columns to a
  table that already exists. Added `addColumnIfMissing()` to
  `state/schema.mjs` (checks `PRAGMA table_info`, `ALTER TABLE ADD COLUMN`
  only if actually missing) — the first real exercise of the "no migration
  framework, but additive changes are cheap" claim from v0.11's schema
  design. Confirmed against a simulated old-shape table, not just a fresh
  one.
- **New endpoints**: `GET /campaigns/:runId/preview`,
  `POST /campaigns/:runId/preview/stop`. `DELETE /campaigns/:runId` now
  stops any active preview (proper process/container teardown) before
  removing the worktree, instead of just deleting the directory out from
  under a live process. Server startup gained
  `reconcilePreviewsOnBoot()` (any `previews` row still `'running'` is
  from a dead process lifetime — same reasoning as
  `reconcileCrashedRuns()` for runs) and a `setInterval` idle-sweep
  (`.unref()`'d, so it can't itself keep the process alive).
- **UI**: `RunDetailPage` gets a "Preview" panel — URL, "Open in new tab",
  live expiry countdown, "Stop preview" button — and the stage stepper
  gained a `preview_build` step. Polling was changed to keep going after
  the *run* reaches a terminal status, as long as a preview is still
  `running` — otherwise the expiry countdown would go stale the moment the
  run finished, even though the preview is designed to keep running well
  past that point.

**Verified:**
- `test/preview-sandbox.test.mjs` (new, 7 tests, real processes and a real
  Docker container, no mocks): full process-mode lifecycle (start → really
  reachable via `fetch` → stop → really unreachable afterward); full
  docker-mode lifecycle, same shape (skips cleanly if Docker isn't
  available, matching `docker-build.test.mjs`'s convention); `getPreview`/
  `stopPreview` on a run with none; **LRU eviction** — a second preview
  past `maxConcurrent: 1` actually evicts the first, confirmed via
  `getPreview` returning null for the evicted run; **idle sweep** — a
  negative-TTL preview gets swept while a fresh one is left alone; **boot
  reconciliation** — stops a real running preview without throwing.
- A full, real end-to-end run through the **actual graph** (real Gemini
  calls, local `git init --bare` fixture, `DRY_RUN_NO_PR=true`) — not a
  synthetic unit test — confirmed: the run completes with
  `previewStarted: true`; the preview is genuinely reachable and serves
  the real generated page (confirmed `data-hero-title` present in the
  fetched HTML); and critically, `openPr()` correctly skipped its own
  worktree cleanup, and `stopPreview()` correctly performed it afterward
  — the workdir existed right after the run completed, and was gone only
  after the preview was explicitly stopped. This is the deferred-cleanup
  design actually working, not just compiling.
- Full `npm test`: 98 tests, 90 pass, 8 skip (same pre-existing
  Chromium/PHP environment gaps as always — unrelated to this phase), 0
  fail. UI `npm run build` (tsc + vite) and `npm run lint` (oxlint) both
  pass clean.

**Deferred:** `src/staging/materialize.mjs`, still not built — preview
confirmed it doesn't need it after all (this phase serves directly from
the live scratch worktree, exactly as v0.11 speculated it might). A
reverse proxy / stable preview hostname — still direct
`http://<host>:<port>/`, per the plan's original v1 scope (only the
Docker-vs-process axis of that decision changed, not the no-reverse-proxy
part).

**Files touched:** new `src/preview/sandbox.mjs`, new
`test/preview-sandbox.test.mjs`; `src/verify/local-server.mjs` (exported
`getFreePort`/`waitForReady`/`SERVE_SCRIPT_PREFERENCE`); `src/state/schema.mjs`
(`addColumnIfMissing`, previews columns); `src/state/sqlite-repository.mjs`
(`workdir` in `COLUMN_MAP`/`rowToRun`); `src/orchestrator/steps.mjs`
(`clone()` persists `workdir`, new `previewBuild`, `openPr()` cleanup
guarded by `previewStarted`); `src/orchestrator/graph.mjs` (new
`preview_build` node/edge, `previewStarted` state channel); `src/config.mjs`
(`PREVIEW_TTL_MS`, `MAX_CONCURRENT_PREVIEWS`, `PREVIEW_SWEEP_INTERVAL_MS`);
`src/server.mjs` (preview endpoints, boot reconciliation, sweep interval,
`DELETE` stops the preview first); `.env.example`, `README.md`; UI:
`ui/src/api.ts`, `ui/src/pages/RunDetailPage.tsx`.

### v0.16 — Hybrid Section Assembly, Modules 1–2 — 2026-07-27 — Per-section static/AI fan-out replaces the whole-page coding loop

**In short:** The pipeline no longer generates the whole page in one long AI
coding-agent run. Most sections (FAQ, pricing, testimonials, footer CTA, …)
are now templated instantly from a curated static component library with
real campaign copy substituted in; only the hero (and anything a campaign
brief explicitly flags) still goes through the coding agent — and each
flagged section now gets its own independent agent run instead of sharing
one big one. See `new_plan.md` §9 for the full design and `module.md` for
the remaining build-out.
**Visible change:** None in the UI's behavior yet (Module 4's gallery/modal
review UI is what actually surfaces this) — the run detail page's stepper
now shows "Classify"/"Generate" instead of "File plan"/"Code", and runs
complete noticeably faster when most sections are static.

**What changed and why:** The old pipeline planned the whole file list with
one upfront `file_manifest` LLM call, then wrote every file through one
long, shared coding-agent loop. Most landing-page sections don't need
bespoke code every time — they're the same handful of layouts with
different copy. New modules, built in two parts this session:

- **`src/design/frame-catalog.mjs`** (new) — human-curated bridge from the
  fixed `SECTION_TYPES` enum to real, reusable static components sourced
  from the target repo's own analyzed component library
  (`atss-frontend`'s `src/components/frames/landing/analyze/`, catalogued
  earlier in this project). Each entry carries a full, real copy of that
  frame's own default data plus a `fillableFields` Zod schema for the
  subset of fields campaign copy may override — full, not partial, because
  these components take `data` as an all-or-nothing prop with no internal
  deep-merge (a partial object would blank out fields the catalog can't
  reproduce, like real photos). Frames with no fillable fields (testimonials,
  instructor — both photo-dependent) always render bare, using their own
  untouched default; this service has no way to generate or source real
  photos, so it never guesses.
- **`src/sections/classify.mjs`** (new) — pure, deterministic: `hero` is
  always `ai-required`; every other section defaults to `static` unless the
  brief's new `aiRequiredSections` field flags it, or the catalog simply
  has no static candidate for that type (falls back to `ai-required`
  automatically). Mode is decided in code, never asked of the LLM.
- **`src/sections/populate-frame.mjs`** (new) — pure templating for static
  sections: validates guide-produced copy against a candidate's
  `fillableFields`, merges it over the full `defaultData`, emits a small
  wrapper component. No LLM call, no coding-agent loop.
- **`src/sections/generate-sections.mjs`** (new) — the fan-out dispatcher.
  Every classified section gets a deterministic path
  (`{allowlistBase}sections/{Type}Section{index}.tsx`); static sections are
  written directly, each ai-required section gets its OWN `runCodingAgent()`
  call scoped to exactly that one file (not a shared multi-file manifest),
  all running concurrently via `Promise.all`. Results are composed into a
  deterministic `page.tsx` (never agent-written, so it's always exactly
  consistent with what was actually generated).
- **`schemas/brief-schema.mjs`** gained `aiRequiredSections` (optional array
  of section types). **`schemas/guide-schema.mjs`** gained
  `sectionModeSchema`/`classifiedSectionSchema` for validating
  `classify.mjs`'s output — the base `guideSchema.sections` shape (LLM
  output) is unchanged; mode/frameId are a pure post-processing pass, not
  something the model is asked to know about.

**Orchestrator wiring (the part that touched existing code):** replaced the
graph's `file_manifest -> code` pair with `classify_sections ->
generate_sections` (`orchestrator/graph.mjs`, `orchestrator/steps.mjs`). A
verify-failure retry now re-enters at `generate_sections`, not
`classify_sections` — mode/frameId don't change because a build broke; the
whole-page verify failure report (and the existing `findExistingImportExamples`
scan) is still fed into every ai-required section's retry prompt, same
spirit as the old shared-loop retry feedback, just not perfectly targeted
to whichever section actually caused it. `verify()`/`stageDraft()`/`commit()`
now read `state.writtenByAgent` directly (populated by `generate_sections`
for every path — static and agent-written alike) instead of falling back to
`state.fileManifest.filesToCreate`; `buildPrBody()`/`writeCodegenLog()` were
adapted to describe sections instead of a flat file+purpose list.

**Deliberately removed, not deprecated:** `file_manifest` had no remaining
callers once this landed (every file's path is now deterministic instead of
LLM-guessed), so `schemas/file-manifest-schema.mjs` and its test were
deleted outright rather than left orphaned. The one behavior it used to own
that still matters — persisting `sectionReferences` so a human can see which
real reference files grounded the plan — moved into `classify_sections`,
its natural successor in the pipeline.

**Deliberately NOT done this session (see `module.md`):** the actual
graph wiring (Module 2) is done, but Module 3 (section-slot `draft_files`
versioning + a real assembled-page verify/preview pass proven end-to-end)
and Module 4 (the click-to-refine gallery/modal UI that's the actual point
of per-section generation) are still ahead. `dev/run-agent-standalone.mjs`
still reflects the old whole-page prompt style — it's a generic
`runCodingAgent()` iteration harness, still functionally correct, just not
updated to the new single-section prompt shape (low priority, noted rather
than silently left).

**Verified:** all pure logic is real unit tests, no mocks — `frame-catalog`,
`classify`, `populate-frame`, and `generate-sections`' path/prompt/compose
helpers (34 + 9 + 1 new tests this session). `generate-sections`' all-static
path is exercised for real against a temp directory (real files on real
disk, zero network) — its ai-required path calls the real coding agent, so
it's not unit-tested, matching this codebase's standing no-LLM-mocking
convention (verified live, like the old `code()` always was). Confirmed the
restructured graph actually `createCodegenGraph()`-compiles under dry-run
config. Full `npm test`: 128 tests, 120 pass, 8 skip (same pre-existing
Chromium/PHP environment gaps as always), 0 fail. UI `npm run build` (tsc +
vite) passes clean with the updated stepper. **Not yet run end-to-end
against a real LLM + fixture repo** — that's the next real confirmation,
same as any other AI-touching change in this project's history.

**Files touched:** new `src/design/frame-catalog.mjs`,
`src/sections/classify.mjs`, `src/sections/populate-frame.mjs`,
`src/sections/generate-sections.mjs`; `src/schemas/brief-schema.mjs`,
`src/schemas/guide-schema.mjs`, `src/orchestrator/steps.mjs`,
`src/orchestrator/graph.mjs`; deleted `src/schemas/file-manifest-schema.mjs`,
`test/file-manifest-schema.test.mjs`; new `test/frame-catalog.test.mjs`,
`test/classify.test.mjs`, `test/populate-frame.test.mjs`,
`test/generate-sections.test.mjs`; `test/brief-schema.test.mjs`,
`test/guide-schema.test.mjs`; UI: `ui/src/pages/RunDetailPage.tsx`; new
`new_plan.md` §9, new `module.md`.

### v0.17 — Hybrid Section Assembly, Module 3 — 2026-07-28 — Section-slot draft versioning

**In short:** Every generated file is now tagged with which section it
belongs to when staged, not just lumped into one flat per-run version. This
is groundwork, not a visible feature yet — it's what Module 4's per-section
refine ("swap just the FAQ section") will version against without touching
the rest of the page's history.
**Visible change:** None — this is a staging-layer addition with no new
endpoint or UI surface yet.

**What changed and why:** `draft_files` (`state/schema.mjs`) gained a
nullable `section_slot` column — `NULL` for the composed `page.tsx` row
(it has no single slot), a stable id like `"section-0"` for everything
else. Slot ids are **positional**, not derived from the section's current
type (`sectionSlotId(index)` in `sections/generate-sections.mjs`) — a
future refine that swaps a slot's section type entirely (Module 4's "new"
action) shouldn't orphan its own version history just because what
occupies that slot changed.

`staging/draft-store.mjs`'s `stageNewVersion` now accepts an optional
`sectionSlot` per file (omitted files stay `NULL`, same as before — existing
callers need no changes). New `getLatestVersionForSlot(runId, slot)` reads
just one slot's latest staged file(s) — has no caller yet (Module 4 is
what will use it), same "small, independently correct, fully tested"
precedent as `diffFromPrevious` back in v0.11, not a stub. `steps.mjs`'s
`stageDraft()` now builds a `path -> slot` map from `state.sectionResults`
(populated by Module 2's `generate_sections` node) and tags every file
accordingly when staging.

**Real bug caught before it shipped:** the new index
(`idx_draft_files_run_slot`) was originally declared inline inside the same
`CREATE TABLE IF NOT EXISTS` block as everything else. On a **fresh**
database that's fine, but on the real, already-existing `data/campaigns.db`
(where `draft_files` predates this column), `CREATE TABLE IF NOT EXISTS`
no-ops and the inline `CREATE INDEX ... ON draft_files(run_id, section_slot)`
would then run against a table that doesn't have `section_slot` yet —
`addColumnIfMissing` for it was correctly placed, but *after* that inline
index statement in file order, not before. Fixed by moving the index
creation to run strictly after `addColumnIfMissing`. Caught by reasoning
through the migration path before running anything — then added a real
test to prove it, not just assert it.

**Verified:** new `test/schema.test.mjs` case builds a genuine old-shape
`draft_files` table (no `section_slot`, simulating a database from before
this version) and confirms `initSchema()` adds both the column and the
index without throwing — this is the test that would have caught the
ordering bug above if it had shipped. New `draft-store.test.mjs` cases:
`stageNewVersion` tags files correctly (page.tsx stays `NULL`),
`getLatestVersionForSlot` returns only that slot's file at its own latest
version (independent of whether OTHER slots have since been restaged), and
returns an empty result for a slot never staged. Additionally ran the exact
migration against a **copy of the real, live `data/campaigns.db`** (not
just a synthetic in-memory table) — confirmed clean. Full `npm test`: 133
tests, 125 pass, 8 skip (same pre-existing environment gaps), 0 fail. UI
`npm run build` passes clean (no UI files touched this round). Graph still
`createCodegenGraph()`-compiles under dry-run config.

**Deferred (see `module.md`):** this only lays the storage groundwork —
nothing reads `getLatestVersionForSlot` yet, and `generate_sections`
(Module 2) still regenerates the WHOLE page on a verify retry, not one
slot at a time. Module 4 is what actually exercises this: a per-section
refine action that stages a new version for one slot only.

**Files touched:** `src/state/schema.mjs`, `src/staging/draft-store.mjs`,
`src/sections/generate-sections.mjs`, `src/orchestrator/steps.mjs`; new
test cases in `test/schema.test.mjs`, `test/draft-store.test.mjs`,
`test/generate-sections.test.mjs`.

### v0.18 — Bugfix — 2026-07-28 — "doesn't have a root layout" (WRITE_PATH_ALLOWLIST pointed at a directory that doesn't exist in this repo)

**In short:** The first real end-to-end run (Modules 1–3, real target repo,
real Gemini calls) got all the way through classify/generate and failed at
`verify` with a genuine Next.js error. Root cause: `WRITE_PATH_ALLOWLIST`
was `app/campaigns/{slug}/`, but this specific target repo (`atss-frontend`)
uses Next.js's `src/app/` convention — its real root layout lives at
`src/app/layout.tsx`. Every generated page was landing in a brand-new,
orphaned top-level `app/` directory sitting next to (not inside) the real
App Router tree, so Next.js correctly refused to build it: that page isn't
part of the tree the root layout covers.
**Visible change:** Campaigns against this target repo no longer fail
verification with "doesn't have a root layout."

**Confirmed, not guessed:** `ls data/.scratch/_base` showed no top-level
`app/` at all — only `src/app/`, containing `layout.tsx` and every existing
real route. `WRITE_PATH_ALLOWLIST` is deliberately human-set, never derived
(same philosophy as everywhere else in this project) — this was simply
wrong for this specific repo's actual layout.

**Fix:** `.env`'s `WRITE_PATH_ALLOWLIST` changed to `src/app/campaigns/{slug}/`.
No code change — `resolveAllowlist()` and every write path downstream are
already purely config-driven (confirmed via `grep`, nothing hardcodes
`app/campaigns` outside one illustrative code comment). `.env.example`
left as a generic template, not tied to this specific repo's convention.

**Left as-is, not cleaned up:** the failed run's worktree
(`data/.scratch/3cd3dc98-...`, containing the stray `app/campaigns/...`
directory) is still on disk — expected, `KEEP_WORKDIR_ON_FAILURE=true` is
what's supposed to preserve it for exactly this kind of inspection. It was
never committed or pushed (verify failing routes straight back to retry/END,
never through commit/push), so `_base` and the real remote are unaffected.
Left for a human to delete once done inspecting, not auto-cleaned.

**Verified:** `node --env-file=.env` confirms `config.writePathAllowlistTemplates`
now resolves to `["src/app/campaigns/{slug}/"]`. Real end-to-end
confirmation (does verify actually pass now) is the next live run against
this repo — not re-run here, since it costs real LLM calls against a real
target repo.

**Files touched:** `.env`.

### v0.19 — Phase 7 — 2026-07-28 — Real human approval gate (nothing reaches git without it)

**In short:** The pipeline no longer auto-commits/pushes/opens a PR the
moment a preview is ready. It now stops and waits — a human has to
explicitly approve (or abandon) before anything touches git. This is the
last piece of what was originally asked for back at the start of the
Hybrid Section Assembly work: static decision ✅, preview ✅, per-section
modify+save (still Module 4, not this phase), **approval for code push ✅.**
**Visible change:** A run that passes verification now shows status
"staged for review" instead of racing straight to "completed." The run
detail page gets a new "Review" card with **Approve & open PR** / **Abandon**
buttons.

**What changed and why:** `commit`, `push`, and `open_pr` were graph nodes,
auto-chained after `preview_build` — by design, from before Phase 7 existed
(every earlier phase deliberately kept this auto-continue so each was still
a complete, demoable, PR-producing pipeline on its own). That was always
flagged as temporary. This phase removes it for real.

- **`orchestrator/graph.mjs`**: `commit`/`push`/`open_pr` are no longer
  graph nodes. The graph now ends at `preview_build` either way — success
  (`stage_draft -> preview_build -> END`) or a verify failure that
  exhausted its retries (still routes straight to `END` from
  `routeAfterVerify`, unchanged). `runCodegen()`'s post-`invoke()` logic
  used to distinguish those two END-reaching paths by checking
  `final.status === "completed"` (only ever true via `open_pr`) — now that
  neither path reaches `open_pr`, it checks `final.verifyPassed` instead:
  `true` → `status: "staged_for_review"`, `false` → the same
  `failed_verification` handling as before.
- **New `orchestrator/review-actions.mjs`**: `approveRun(runId)` and
  `abandonRun(runId)`, invoked from a **separate, later** HTTP request —
  the in-process LangGraph state from `generate_sections` is long gone by
  the time a human actually clicks Approve (no checkpointer in v1), so
  `approveRun` rebuilds exactly what `commit()`/`push()`/`openPr()` need
  (reused **unchanged**, just called directly instead of as graph nodes)
  from `run-store` + the latest staged draft: `workdir`/`branchName` (already
  persisted since earlier phases), `request` (now exposed via `getRun()` —
  `campaigns.brief_json` was already stored, just never read back out),
  `writtenByAgent` (rebuilt from `draftStore.getLatestVersion()`'s file
  paths — the staged draft **is** the authoritative "what should get
  committed," not something to re-derive), `agentSummary`/`sectionResults`
  (newly persisted — see below), and `previewStarted` (checked live via
  `preview.getPreview()`, not a stale boolean, since a preview started in
  an earlier request could have since expired). `abandonRun` stops any
  active preview and removes the worktree, same cleanup the success path
  would eventually do, but commits nothing.
- **`orchestrator/steps.mjs`**: `generateSectionsStep` now persists
  `agentSummary`/`sectionResults` to run-store (previously only kept in
  LangGraph's in-process state) — this is specifically what makes them
  available to `approveRun` later.
- **New DB columns** (`state/schema.mjs`, both nullable, both migrated onto
  the real existing `data/campaigns.db` via `addColumnIfMissing`, same
  precedent as `section_slot` in v0.17): `runs.agent_summary`,
  `runs.section_results_json`.
- **New statuses**: `staged_for_review` (deliberately **not** terminal —
  `DELETE` still 409s until a human approves or abandons), `approved`
  (transient, set right before commit/push/PR start), `abandoned` (now
  genuinely reachable, not just declared — added to `TERMINAL_STATUSES`).
- **New endpoints**: `POST /campaigns/:runId/approve`,
  `POST /campaigns/:runId/abandon` — 404 if the run doesn't exist, 409 if
  it's not in a state that action makes sense for (`ReviewActionError`,
  mapped to the right HTTP status in `server.mjs`).
- **UI**: `RunDetailPage` gets a `ReviewPanel` (Approve/Abandon buttons,
  confirm dialogs, error display), shown only while
  `status === "staged_for_review"`, wired to the new `approveCampaign`/
  `abandonCampaign` calls in `api.ts`.

**Deliberately NOT built this phase:** reject-with-feedback-and-regenerate.
It needs a feedback UI and a way to re-enter section generation for a
specific run — naturally paired with the per-section refine UI
(module.md Module 4, not built yet). Building a standalone version now
would mean reshaping or throwing it away once that UI exists, so it's left
for then. Approve/abandon don't have that dependency, which is exactly why
they're the two built now.

**Verified:** new `test/review-actions.test.mjs` (6 tests) — the
`approveRun` happy path is a **real** end-to-end check: a local `git init
--bare` fixture, a real staged draft, a real `approveRun()` call, then
confirming via `git ls-tree` directly against the bare "remote" that the
right files (including `CODEGEN_LOG.md`) actually landed on the right
branch, and the run's own record shows `status: "completed"` with a
dry-run PR URL. Plus the 404/409 error paths for both functions (missing
run, wrong status). Booted the real `server.mjs` for real and hit both new
endpoints with `curl` — confirmed 404 + the exact `ReviewActionError`
payload for a nonexistent run, and `/healthz` still responds `200` (routes
registered correctly, nothing broken at boot). Full `npm test`: 139 tests,
131 pass, 8 skip (same pre-existing environment gaps), 0 fail. UI
`npm run build`/`npm run lint` both pass clean. Graph still
`createCodegenGraph()`-compiles. **Not yet exercised as a real full
end-to-end run** (real LLM through to a real Approve click) — the next
live campaign against the real target repo is what actually proves this,
same as every other AI-touching phase in this project.

**Files touched:** `src/orchestrator/graph.mjs`, `src/orchestrator/steps.mjs`;
new `src/orchestrator/review-actions.mjs`; `src/state/schema.mjs`,
`src/state/sqlite-repository.mjs`, `src/server.mjs`; new
`test/review-actions.test.mjs`; UI: `ui/src/api.ts`,
`ui/src/pages/RunDetailPage.tsx`.

### v0.20 — Phase 8 — 2026-08-01 — Lead form contract (fields, honeypot, no-op preview sink)

**In short:** Every generated hero now gets a precise, real specification
for its lead-capture form instead of a vague "name, phone, email" note —
exact fields (with a conditional job title), a real honeypot pattern, basic
client-side validation, and a safe no-op endpoint to submit to during
preview so a reviewer can click through the form without a real lead going
anywhere.
**Visible change:** New campaign form gets a "Require a job title on the
lead form" checkbox. Generated hero forms now include a hidden honeypot
field and submit to a preview-safe endpoint instead of nowhere/undefined.

**What changed and why:** new_plan.md §4.8 always specified this contract,
but nothing implemented it — the old whole-page `code()` prompt just said
"the lead form (name, phone, email, CTA button)" and left the rest to the
model's judgment, with no honeypot, no defined submission target, and no
way to test the form without wiring up a real backend.

- **New `src/leadform/contract.mjs`**: `BASE_FIELDS`/`JOB_TITLE_FIELD`
  (name, phone, email, +jobTitle when flagged), `HONEYPOT_FIELD_NAME`
  (`company_website` — plausible-looking, not an obvious tell),
  `leadFormFields({requiresJobField})`, and
  `buildLeadFormPromptFragment()` — the actual prompt text: exact field
  list, honeypot styling requirements (explicitly **not**
  `display:none`/`type="hidden"`, since some bots skip those; must stay
  invisible and unfocusable to real visitors), client-side format checks
  for email/phone, and the exact absolute URL to POST to.
- **`brief-schema.mjs`** gained `requiresJobField` (optional, defaults
  `false`) — set at campaign creation, threaded down into the hero prompt.
- **`sections/generate-sections.mjs`**: `HERO_CONTRACT` (a static string)
  became `buildHeroContract({requiresJobField, previewLeadSinkUrl})` (a
  function), since the lead-form fragment now varies per campaign/config —
  only threaded in for the hero section, the one section that's always
  ai-required.
- **New config `SERVICE_PUBLIC_BASE_URL`** (optional, defaults to
  `http://localhost:<PORT>`): a preview runs the TARGET repo's own server
  on its own port (`preview/sandbox.mjs`) — a completely separate process
  from this one — so the generated form can't just fetch a relative path;
  it needs this service's own externally-reachable base URL. Only
  localhost works out of the box; a real deployment needs this set
  explicitly (noted inline in `.env.example`-worthy detail in the config
  comment itself).
- **New `POST /internal/preview-lead-sink`** (`server.mjs`) — deliberately
  **no auth** (called from a browser rendering the previewed page, which
  has no access to `API_SHARED_SECRET`) and deliberately a **no-op**:
  logs the submission and returns `{ok:true}`, never delivers anywhere.
  Honeypot-tripped submissions are logged distinctly (so a human can tell
  the difference) but still return success — detection is never revealed
  to the caller, real or bot.
- **UI**: `NewCampaignPage` gets a "Require a job title" checkbox, wired
  straight through to the brief.

**Deliberately NOT built this phase (new_plan.md §4.8's own scope note):**
real delivery to the parent landing-page platform's lead-intake pipeline.
That's blocked on that platform exposing a receiving endpoint — a separate,
external dependency, not something this service can build standalone. What
ships now is everything up to that boundary: the contract, the honeypot,
and a safe way to demo/test the form.

**Worth flagging, not resolved this phase:** while wiring this up, I
noticed the real target repo's existing hero/lead-capture components
(the `atss-frontend` `analyze/` folder catalogued earlier — e.g.
`WebinarRegistrationHeroFrame`) actually use **GoHighLevel (GHL) iframe
embeds** for lead capture, not a custom form posting to a JSON endpoint.
This phase implements the contract exactly as `new_plan.md` §4.8 originally
specified it (a custom form, our own submission target) — reconciling that
against the real repo's existing GHL convention is a design catalog
curation question (module.md Module 7, still not done: `design/catalog.mjs`
and `design/frame-catalog.mjs` both still need real curation against this
specific repo), not something to silently decide here.

**Verified:** new `test/leadform-contract.test.mjs` (6 tests, pure) —
field lists, honeypot naming, and the exact prompt text for both
`requiresJobField` states. `test/brief-schema.test.mjs` gained a case for
the new field (caught and fixed an unrelated bug in my OWN test fixture
along the way — a 1-character `campaignName` that should have failed
`min(3)` regardless of `requiresJobField`, which briefly looked like a
schema bug before I traced it to the fixture). `test/generate-sections.test.mjs`
updated/extended to confirm the hero prompt includes the honeypot field
name and the sink URL, and that non-hero sections get neither. Booted the
real `server.mjs` and hit the real endpoint with `curl`: a normal
submission logs cleanly (honeypot field stripped from the log line), a
honeypot-tripped one is flagged distinctly but still returns `{ok:true}`,
and a malformed body correctly 400s. Full `npm test`: 147 tests, 139 pass,
8 skip (same pre-existing environment gaps), 0 fail. UI `npm run build`/
`npm run lint` both pass clean. Graph still `createCodegenGraph()`-compiles.

**Files touched:** new `src/leadform/contract.mjs`; `src/schemas/brief-schema.mjs`,
`src/sections/generate-sections.mjs`, `src/orchestrator/steps.mjs`,
`src/config.mjs`, `src/server.mjs`; new `test/leadform-contract.test.mjs`;
`test/brief-schema.test.mjs`, `test/generate-sections.test.mjs`; UI:
`ui/src/api.ts`, `ui/src/pages/NewCampaignPage.tsx`, `ui/src/App.css`.

### v0.21 — Phase 9 — 2026-08-01 — Per-section refinement (the click-a-section, swap-it, save-a-new-version review UI)

**In short:** This is the piece from the very original ask that was still
missing: a reviewer can now click any section in a staged run, swap its
frame, ask AI to redesign or modify it, or replace it with a different
section type entirely — each action writes a new version scoped to just
that one slot, never touching the rest of the page, then re-verifies the
whole assembled page and refreshes the live preview automatically.
**Visible change:** A new "Sections" card appears on `staged_for_review`
runs, listing every section with a "Refine" button that opens a modal.

**What changed and why:** new_plan.md §9.7 specified this as *the* review
mechanism (not a separate raw-file editor) back when the Hybrid Section
Assembly plan was designed — Module 3 (v0.17) built the storage groundwork
(`section_slot` versioning) but nothing actually used it until now.

- **New `src/orchestrator/refine-actions.mjs`** — `listSections(runId)`
  (the gallery's data source: every slot's current type/mode/frame, plus
  which other static candidates exist for that type) and
  `refineSection(runId, slot, action, params)`, one of four actions:
  - `use-different-frame` — static slots only. Pure templating
    (`populateFrame()`), no LLM — regenerates that slot's file from a
    different catalog candidate.
  - `modify` — ai-required slots only. Re-runs the coding agent for just
    that one file with human-written instructions layered on top of the
    original section prompt.
  - `redesign` — any slot. Forces it to ai-required (even if currently
    static) and generates fresh via the coding agent, discarding whatever
    was there before.
  - `new` — any slot. Swaps the section's TYPE entirely (e.g. faq →
    testimonials) — re-resolves static-vs-ai-required for the new type and
    generates accordingly. The old file is simply left on disk, unreferenced
    and harmless (see below); it's dropped from the new draft version's
    manifest, not deleted.
  Every action recomposes `page.tsx` (a type change means the imported
  component name changes), runs the **full-page** verify suite (a section
  swap can affect page-wide hero-fit/SEO/a11y checks, so it's always
  whole-page, never per-section — same reasoning as Module 2/3), and only
  on success: stages a new `draft_files` version (previous version's files,
  with just the refined slot + `page.tsx` replaced — full history of every
  other slot preserved untouched), updates `runs.sectionResults` (the one
  entry for that slot), and refreshes the live preview (`stopPreview` then
  `startPreview` — a stop-then-restart, not an in-place reload, since the
  serve script may be a production build that doesn't hot-reload source
  changes).
- **Nothing is rolled back on a failed refine.** Verify runs against files
  already written to the live scratch worktree, but `draft_files` — not the
  worktree — is what `commit()` actually reads from (same "database is the
  source of truth until approval" principle the whole project has followed
  since `landingplan.md` §4.7). A failed attempt's bad content just sits in
  the worktree, never staged, never committed, overwritten by the next
  attempt. This is a deliberate simplification, not an oversight — it
  avoids needing to snapshot/restore file content around every verify call.
- **`generate-sections.mjs`**: static section results now carry `frameId`
  (needed so the gallery/refine can show and validate against the
  *current* selection) — small, backward-compatible addition. Also exported
  the previously-internal `writeGuardedFile()` helper so refine-actions.mjs
  reuses the exact same write-guard path generate_sections itself uses,
  rather than duplicating it.
- **New endpoints**: `GET /campaigns/:runId/sections`,
  `POST /campaigns/:runId/sections/:slot/refine` — 404/409/400/422 mapped
  from `RefineActionError`'s reasons (`not_found`/`wrong_status`/
  `invalid_action`/`verify_failed`).
- **UI**: new `SectionsPanel` (the gallery — one row per slot, a "Refine"
  button each) and `RefineModal` (scoped to one slot: action buttons
  filtered by current mode, a frame picker for `use-different-frame`, an
  instructions textarea for `modify`/`redesign`, a type picker for `new`).
  Both shown only while `status === "staged_for_review"`. A successful
  refine refetches the run, draft, and preview immediately rather than
  waiting for the next poll tick, since the action itself (real verify +
  real preview restart) already takes a few seconds.

**Verified:** new `test/refine-actions.test.mjs` (8 tests) — the
`use-different-frame` happy path is a **real** end-to-end check against a
minimal-but-real buildable fixture (a `package.json` whose build script
trivially succeeds, so `verifyBuild()` runs for real without needing a
full Next.js/Docker setup): confirms the refined slot's file gets **real**
`populateFrame()` content, the *other* slot's file is byte-for-byte
untouched, the new `draft_files` version has both files correctly slotted,
`runs.sectionResults` updates, and the run's `status` never changes (refine
never approves or rejects, only stages). Plus the error paths: unknown
action, unknown slot, unknown frame id, wrong run status, `use-different-frame`
on an ai-required slot. Full `npm test`: 155 tests, 147 pass, 8 skip (same
pre-existing environment gaps), 0 fail. UI `npm run build`/`npm run lint`
both pass clean. Booted the real server and hit both new endpoints with
`curl` to confirm routing/error-mapping. **Could not visually render the
modal/gallery in a browser in this sandbox** (no browser available, same
limitation noted back in v0.9) — verified structurally (compiles, correct
data flow end-to-end via the real backend test) but not what it actually
looks like; worth a visual pass on your end before relying on it.

**Deliberately NOT built this phase:** `modify`/`redesign` don't get the
`findExistingImportExamples` retry-context boost the main generation retry
loop gets (steps.mjs) — a refine is a fresh one-off action, not a retry
loop, so this was left out for scope discipline rather than bundled in
silently. Bulk regenerate (module.md Module 6, "start over with a new
direction for every section") is still separate, deliberately last-priority
work.

**Files touched:** new `src/orchestrator/refine-actions.mjs`; `src/sections/generate-sections.mjs`,
`src/server.mjs`; new `test/refine-actions.test.mjs`; UI: `ui/src/api.ts`,
`ui/src/pages/RunDetailPage.tsx`, `ui/src/App.css`.

### v0.22 — Readability restructure — 2026-08-02 — Renamed/reorganized `src/` for humans (no behavior change)

**Why:** the file/folder layout had drifted into a shape only someone who'd
built it could navigate — 13 small domain folders with some genuinely
uninformative names (`index.mjs`, `ops.mjs`, `api.mjs`, `sandbox.mjs`,
`db.mjs`), and one 580-line `orchestrator/steps.mjs` mixing 9 unrelated
pipeline stages plus several unrelated helpers in a single file. Requested
directly, with the explicit scope of a project-wide rename, not just an
architecture change. Zero logic changed anywhere in this pass — every
edit is a rename, a relocation, or splitting one file into several with the
same code moved verbatim; the 155-then-157-test suite is the proof (same
pass/fail/skip counts before and after).

**What changed** — old path → new path, folder by folder:

- `src/ai/` → `src/llm/`: `text.mjs` → `generate-text.mjs`, `tools.mjs` → `filesystem-tools.mjs`, `coding-agent.mjs` unchanged.
- `src/orchestrator/` → `src/pipeline/`: `graph.mjs` → `run-campaign-pipeline.mjs`, `review-actions.mjs` → `approve-or-abandon-run.mjs`, `refine-actions.mjs` → `refine-section.mjs`. `steps.mjs` (580 lines) split into `pipeline/steps/` — one file per LangGraph stage (`01-intake.mjs` … `09-start-preview.mjs`), plus `find-existing-imports.mjs` (a helper, not a stage) and `commit-push-and-open-pr.mjs` (the three post-approval functions, no longer graph nodes since Phase 7). `pipeline/steps/index.mjs` re-exports all of them so `run-campaign-pipeline.mjs` keeps one `import * as steps` line.
- `src/design/` → `src/design-catalog/`: `schema.mjs` → `section-types.mjs`, `catalog.mjs` → `reference-examples.mjs`, `resolve.mjs` → `resolve-references.mjs`, `frame-catalog.mjs` → `static-frame-catalog.mjs`.
- `src/sections/`: `classify.mjs` → `classify-sections.mjs`, `populate-frame.mjs` → `fill-static-frame.mjs`. `generate-sections.mjs` (256 lines, several unrelated concerns) split into: `generate-sections.mjs` (kept — just the fan-out dispatcher + `buildStaticSectionFile`), `compose-page.mjs` (path/slot helpers + `composePage`), `hero-contract.mjs` (`buildHeroContract`), `section-agent-prompt.mjs` (`buildSectionAgentSystemPrompt`), `write-guarded-file.mjs` (`writeGuardedFile`, shared with `refine-section.mjs`).
- `src/verify/`: `index.mjs` → `run-full-verify-suite.mjs` (the single worst name in the repo — gave zero information), `build.mjs` → `build-and-lint.mjs`, `local-server.mjs` → `ephemeral-server.mjs`, `package-manager.mjs` → `detect-package-manager.mjs`, `hero-fit.mjs` → `check-hero-visibility.mjs`, `seo-lint.mjs` → `check-seo-tags.mjs`, `a11y-lint.mjs` → `check-accessibility.mjs`. `docker-build.mjs` unchanged.
- `src/preview/sandbox.mjs` → `src/preview/preview-server.mjs` ("sandbox" was jargon; it starts/stops/tracks a live preview server).
- `src/staging/draft-store.mjs` → `src/staging/draft-versions.mjs`.
- `src/state/`: `db.mjs` → `database-connection.mjs`, `schema.mjs` → `database-schema.mjs`, `repository.mjs` → `campaign-repository.mjs`, `sqlite-repository.mjs` → `sqlite-campaign-repository.mjs`.
- `src/git/ops.mjs` → `src/git/clone-and-commit.mjs`; `src/github/api.mjs` → `src/github/open-pull-request.mjs` (both old names were generic enough to be interchangeable at a glance, which was itself confusing).
- `src/schemas/brief-schema.mjs` → `campaign-brief-schema.mjs`; `guide-schema.mjs` → `content-guide-schema.mjs`.
- Every file under `test/` renamed to mirror its source file 1:1, and split the same way `generate-sections.test.mjs` was split (new `compose-page.test.mjs`, `section-agent-prompt.test.mjs`).
- Comments were also passed over: every large block comment that used to sit above a whole function was broken into smaller comments placed next to the specific sub-block or line it actually explains, rather than one paragraph up top covering the whole function.

**Deliberately out of scope:** `ui/` (already clearly named — `CampaignListPage.tsx`, `api.ts`, etc.); replacing LangGraph itself (`StateGraph`/`Annotation`/`START`/`END` is a library dependency, not something a rename touches); a project-wide identifier audit (`resolveWritePath`, `runFullVerifySuite`, `classifySections`, `createPullRequest`, Express's `req`/`res` were already clear and left alone); the `design-catalog/static-frame-catalog.mjs` "frame"/`frameId` terminology (touches the public API shape and the UI — disproportionate to a readability pass).

**Verification:** `npm test` — 157 tests, 149 pass, 8 pre-existing skips, 0 fail, identical to the pre-restructure baseline. `cd ui && npm run build && npm run lint` — clean. `createCodegenGraph()` compile smoke test — passes. Booted the real `src/server.mjs` and confirmed `/healthz` returns 200. Repo-wide grep swept `src/`, `test/`, `dev/run-agent-standalone.mjs`, and this project's own docs (`README.md`, `new_plan.md`, `module.md`, `workflow.md`, `landingplan.md`) for every old filename — none left outside this changelog's own historical entries above, which describe what was true at the time and are intentionally not rewritten.

**Known pre-existing staleness NOT fixed by this pass** (out of scope — this was a rename, not a content audit): `workflow.md` still shows the old `file_manifest → code` pipeline shape (superseded by Hybrid Section Assembly, v0.16) and still points at the long-retired flat-JSON `state/run-store.mjs` instead of the current SQLite `state/campaign-repository.mjs` — both predate this restructure and are a separate doc-accuracy cleanup, not a path rename.

**Files touched:** every file under `src/` except `config.mjs`, `server.mjs` (renamed imports, not itself), `leadform/`, and `verify/docker-build.mjs`; every file under `test/`; `dev/run-agent-standalone.mjs`; `README.md`, `new_plan.md`, `module.md`, `workflow.md`, `landingplan.md`.

### v0.23 — Bugfix + Feature — 2026-08-04 — Root-caused the "always failing" build, crash resume, animated log console

Three separate pieces of work, driven by a real failing run.

**1. Why every build was failing (two independent root causes, neither one "verify being too strict").**

The pasted failure showed five errors. Four were `Module not found: Can't
resolve '@components/frames/landing/analyze/…'` and one was the hero using
`useState` without a `"use client"` directive.

*Cause A — the frame components were never committed.* The target repo's
`src/components/frames/landing/analyze/` directory is **untracked in git**:
`git ls-files` returns 0 files for it and `git status` shows `?? …/analyze/`.
Those ~53 components exist only in the local `_base` working copy. Every run
creates a fresh `git worktree` off the `dev` branch, which by definition
contains only committed files — so the whole `analyze/` folder was absent from
every run's workdir, and every static section emitted an import to a file that
wasn't there. Proven directly: the frame resolver reports **8/8 catalog frames
present in `_base`, 0/8 in an actual run worktree.**

This was *unfixable by the retry loop*, which is what made it look permanent:
static sections are templated from the catalog, not written by the coding
agent, so a verify-failure retry regenerates the identical broken import.

*Cause B — no `"use client"`.* The hero always renders a stateful lead form,
but nothing in its prompt mentioned that a Next.js App Router component using
hooks must declare `"use client"` as its first line. The target repo's own
interactive frames all do — the convention existed, the agent just wasn't told.

**Fixes (deliberately root causes, not a lowered bar).** Weakening verify would
only have shipped broken pages into PRs; the gate correctly caught five real
defects. Instead:
- New `src/design-catalog/resolve-frame-file.mjs` resolves a candidate's
  `importPath` through the target repo's *own* `tsconfig.json`/`jsconfig.json`
  `paths` aliases (handles JSONC, `baseUrl`, directory/index imports, and falls
  back to repo- and `src/`-relative resolution when there's no config).
- `pipeline/steps/05-classify-sections.mjs` now preflights every catalog frame
  against the real workdir. A section whose frames are missing **degrades to
  `ai-required`** — the agent writes it from scratch — instead of guaranteeing
  a failed build. Missing frames are logged loudly as a catalog-curation bug.
- `sections/classify-sections.mjs` takes an `isFrameAvailable` predicate and
  picks the first *available* candidate. The I/O stays in the pipeline step, so
  both functions remain pure and unit-testable.
- `sections/section-agent-prompt.mjs` now specifies the `"use client"`
  requirement explicitly.

*Still worth doing on your side:* commit and push `analyze/` to the target
repo, so those sections go back to being free/static instead of AI-generated.
Note `SyllabusAccordionFrame.tsx` uses hooks but has no `'use client'` of its
own, so it would need that line added before it builds.

**2. Crash resume — plus two data-loss bugs found while building it.**

- `reconcileCrashedRuns()` marked *every* non-terminal run failed on boot,
  and `staged_for_review` is deliberately non-terminal — so **restarting the
  service destroyed every run awaiting human review**, discarding finished,
  already-paid-for work.
- Worse, `stopPreviewRow()` deleted the run's git worktree whenever a preview
  stopped. Since approve's `commit()` runs git *inside* that worktree, both a
  service restart and a routine 30-minute idle-preview sweep left a reviewable
  run impossible to approve.

Now: runs awaiting review are left completely untouched; the worktree is only
removed once the run itself is terminal; runs caught mid-commit/push are still
flagged for manual attention (git can't be safely re-driven); and everything
else mid-generation is re-driven by the new
`src/pipeline/resume-interrupted-runs.mjs`. Resume re-runs the pipeline rather
than restoring a mid-graph snapshot (there's no checkpointer), but research
notes and the content plan are now persisted and reused, so a resumed run skips
both of those LLM calls. Section files are intentionally *not* replayed from
`draft_files` — a resumed run gets a fresh worktree, and replaying an unverified
draft would be trusting output that never passed verify. Toggle with
`RESUME_INTERRUPTED_RUNS` (default on).

**3. Animated live log console + UI motion.** The log was a flat `<pre>`. It's
now a parsed console: timestamps, per-stage badges, and severity colouring
(pass/warn/fail) derived from each line, with new lines sliding in, a blinking
cursor and breathing glow while a run is live, and auto-follow that politely
stops when you scroll up to read scrollback. Continuation lines (stack traces,
multi-line verify reports) fold into their parent entry instead of being
dropped. The stepper's active stage pulses, completed steps pop, failures
shake. All of it sits behind `prefers-reduced-motion`.

**Verification:** 174 tests, 166 pass, 8 pre-existing skips, 0 fail (up from
157/149 — 17 new). The frame resolver was validated against the real target
repo (8/8 vs 0/8). The schema migration was run against a copy of the real live
`data/campaigns.db`. Server boots and `/healthz` responds. UI builds and lints
clean. The log parser was checked against a real 89-line run log from the live
database. **Not verified:** no live end-to-end LLM run — the "use client" prompt
fix in particular is only confirmed to be present in the prompt, not yet
observed changing real model output.

**Files touched:** new `src/design-catalog/resolve-frame-file.mjs`,
`src/pipeline/resume-interrupted-runs.mjs`; `src/sections/classify-sections.mjs`,
`src/sections/section-agent-prompt.mjs`, `src/pipeline/steps/05-classify-sections.mjs`,
`02-research.mjs`, `03-generate-guide.mjs`, `04-clone-target-repo.mjs`,
`src/state/sqlite-campaign-repository.mjs`, `src/state/database-schema.mjs`,
`src/preview/preview-server.mjs`, `src/config.mjs`, `src/server.mjs`,
`.env.example`; new `test/resolve-frame-file.test.mjs`,
`test/resume-interrupted-runs.test.mjs`; UI: `ui/src/pages/RunDetailPage.tsx`,
`ui/src/App.css`.

### v0.24 — Bugfix — 2026-08-04 — The run log was hiding every build error; verify history is now persisted

**The complaint that triggered this:** a verify failure whose log entry ended
mid-word at `- Env`, showing nothing but npm install chatter. The actual
compiler error was invisible.

**Root cause:** `07-verify.mjs` logged `result.report.slice(0, 500)`. A failing
`npm ci && npm run build` emits ~1400 characters of package counts, funding
notices, audit summaries, deprecation warnings and npm upgrade notices *before*
the compiler says anything. So the 500-character budget was spent entirely on
chatter, and every failure logged identically regardless of what actually broke.
The real report was 2313 characters with the error starting past character 1400.

New `src/verify/summarize-report.mjs` strips package-manager bookkeeping and
seeks to the first real failure marker (`Failed to compile`, `Module not found`,
`Syntax Error`, `Type error`, …), keeping the command header for context. The
full report is still passed verbatim to the retry prompt and stored — this only
governs what the one-line log entry shows. Verified against the real stored
report from run `aee7e242`: the old slice contained no error text at all; the
new summary leads with `Failed to compile.` and both failing files.

**Verify history is now persisted.** The `verify_reports` table had existed
since Phase 3 with **zero writers**. A failing run never reaches `stage_draft`
and its scratch worktree is disposable, so the only surviving copy of a failure
was `runs.error` — written once, after retries are exhausted, discarding every
earlier attempt's report. `recordVerifyReport()`/`listVerifyReports()` now keep
one row per attempt.

**`deleteRun` was broken for any run with child rows.** It cleared only
`draft_files` and `run_logs`, but seven tables carry a foreign key to `runs` and
`PRAGMA foreign_keys` is ON — so a run that had ever started a preview could not
be deleted at all. Now driven off a single `CHILD_TABLES_OF_RUNS` list.

**Two agent-behaviour fixes, from the errors that surfaced once the earlier
frame/`use client` fixes cleared the way:**
- `Can't resolve '../../../components/Accordion'` — the agent invented a local
  component. `find-existing-imports.mjs` used to reduce such a specifier to a
  "base package" of `..` and grep for it, matching nearly every relative import
  in the repo and flooding the retry prompt with noise. Relative specifiers now
  get a direct instruction instead: don't import a project-local file you
  haven't opened; implement the element inline.
- The section prompt now also forbids importing unopened project-local files and
  requires a complete, parseable file in one write.

**Confirmed working from the previous version:** the `@components/frames/…`
resolution errors and the `useState`-without-`"use client"` error are both gone
from this run — v0.23's frame-availability fallback and prompt fix did their job.
The remaining failures are new and different.

**Still unexplained:** `HeroSection0.tsx` failed with `Unexpected token
'section'. Expected jsx identifier` at a plain `<section>` tag. The generated
file could not be inspected — the run never staged (staging happens only after
verify passes) and its worktree was already gone, despite
`KEEP_WORKDIR_ON_FAILURE=true`. Prompt hardening around complete/parseable
output is a mitigation, not a diagnosis; the persisted verify reports mean the
next occurrence will at least be fully recorded.

**Verification:** 185 tests, 177 pass, 8 pre-existing skips, 0 fail (11 new).
The summarizer is tested against the real 2313-char report from the live
database. Server boots, `/healthz` responds, live DB untouched. One transient
assertion failure was seen once and did not reproduce across five subsequent
full runs — most likely a timing flake in the docker/preview tests, not
confirmed fixed.

**Files touched:** new `src/verify/summarize-report.mjs`;
`src/pipeline/steps/07-verify.mjs`, `src/pipeline/steps/find-existing-imports.mjs`,
`src/sections/section-agent-prompt.mjs`, `src/state/sqlite-campaign-repository.mjs`;
new `test/summarize-report.test.mjs`; extended `test/find-existing-imports.test.mjs`,
`test/sqlite-campaign-repository.test.mjs`.

### v0.25 — Feature — 2026-08-04 — Verify retries now REPAIR the broken file instead of regenerating everything

**The pattern that forced this.** Three consecutive real runs each failed on a
different, unrelated mistake: a missing frame component, then an invented
`../../../components/Accordion` import plus a JSX syntax error, then
`Cannot find name 'toggleFqa'. Did you mean 'toggleFaq'?`. Each individual
failure was trivial. The run still never converged.

**Root cause — the retry was a re-roll, not a fix.** On a verify failure the
graph routes back to `generate_sections`, which regenerated **every**
ai-required section with the task prompt *"Explore the repository, then
implement X at path"*. Two consequences:

1. The agent never read its own previous attempt. A one-token typo fix was
   re-rolled as a from-scratch rewrite of the whole component.
2. Sections that had compiled perfectly were rewritten too — so a retry could
   turn one broken file into a *different* broken file. That is precisely why
   consecutive attempts kept failing on unrelated errors.

With `MAX_CODE_ATTEMPTS=2` that amounted to exactly one extra roll of the dice.

**The fix.** New `src/verify/failing-files.mjs` parses the build report for the
files it actually blames — handling tsc `file.tsx:51:32` errors, webpack
`Module not found` blocks, and ANSI-coloured swc syntax errors carrying a
docker `/app/` prefix. It only ever blames files under the campaign's own
allowlist, and never `page.tsx` (composed deterministically, never
agent-written, but present in every import trace).

`generateSections()` now takes `retryFailedPaths` + `previousSectionResults`:
- Sections **not** blamed are skipped entirely and their previous result is
  carried forward verbatim — no rewrite, no regression risk, no LLM cost.
- A blamed section is put in **repair mode**: *"Your previous attempt is
  ALREADY WRITTEN at <path> and the build FAILED on it. Call read_file on it
  first, then fix the specific reported error — most failures here are a single
  typo, a mismatched name, or one bad import, so change as little as possible."*
- If the failure can't be attributed to any file, it falls back to the old
  regenerate-everything behaviour, which is the only safe option.

`MAX_CODE_ATTEMPTS` default raised 2 → 3 (and in `.env`): a retry is now a
cheap single-file repair rather than a full regeneration, so more attempts buy
real convergence instead of more dice.

**Verification:** 194 tests, 186 pass, 8 pre-existing skips, 0 fail (13 new).
The blame extractor is tested against all three real failure reports verbatim.
A real end-to-end test proves an unblamed section is preserved **byte for
byte** across a targeted retry, and that an unattributable failure still
regenerates everything. Graph compiles, server boots, `/healthz` responds.

**Not verified:** no live LLM run — repair mode is confirmed to be wired and
prompted correctly, but not yet observed fixing a real typo end to end.

**Files touched:** new `src/verify/failing-files.mjs`;
`src/sections/generate-sections.mjs`, `src/pipeline/steps/06-generate-sections.mjs`,
`src/config.mjs`, `.env`, `.env.example`; new `test/failing-files.test.mjs`;
extended `test/generate-sections.test.mjs`.

### v0.26 — Bugfix — 2026-08-05 — Generated code now respects the target repo's TypeScript strictness

**The failure:** `Type error: Binding element 'children' implicitly has an
'any' type.` on
`const Button = ({ children, type = 'button', onClick, disabled, className }) => (`

**Not a version conflict** (the question that prompted this). Two facts settle it:
1. The target repo's `tsconfig.json` sets `"strict": true`, which implies
   `noImplicitAny`.
2. `next build` runs the type checker, so an untyped destructured prop is a
   hard build failure, not a warning.

Nothing in the section prompt ever mentioned that the repo type-checks
strictly — and the repo's own components already follow a clear convention
(`interface IProps { … }` then `}: IProps) => {`) that the agent had no reason
to know about. It wrote idiomatic *JavaScript* React into a `.tsx` file in a
strict TypeScript project.

**Fix:** new `src/pipeline/steps/detect-typescript-strictness.mjs` reads the
target repo's own `tsconfig.json` (JSONC-tolerant) and builds a prompt fragment
describing what its type checker will accept: every parameter and destructured
prop explicitly typed, the repo's `interface IProps` convention, typed React
event handlers, typed nested helper components, `?` for optional props. It
assumes strict whenever strictness can't be disproved (e.g. inherited through
`extends`) — adding types to a loose repo is harmless, omitting them in a
strict one is fatal. A repo with no `tsconfig.json` gets no fragment at all.

Threaded through `generateSections()` **and** `refine-section.mjs` — refine
builds its own prompt, so leaving it out would let a refined section
reintroduce the exact failure the pipeline had just fixed.

**Also confirmed working from v0.24:** the generated file contained the comment
*"Basic Button component for local use, as external components cannot be
imported without prior exploration"* — the agent built the button inline
instead of inventing an import, which is precisely what that version's
invented-import rule asked for.

**Verification:** 201 tests, 193 pass, 8 pre-existing skips, 0 fail (7 new).
The detector was run against the real target repo and correctly reports
`{isTypeScript: true, strict: true}`. Graph compiles, server boots, `/healthz`
responds.

**Not verified:** no live LLM run — the rules are confirmed present in the
prompt and correct for this repo, but not yet observed changing model output.

**Files touched:** new `src/pipeline/steps/detect-typescript-strictness.mjs`;
`src/sections/section-agent-prompt.mjs`, `src/sections/generate-sections.mjs`,
`src/pipeline/steps/06-generate-sections.mjs`, `src/pipeline/refine-section.mjs`;
new `test/detect-typescript-strictness.test.mjs`; extended
`test/section-agent-prompt.test.mjs`.

### v0.27 — Feature (escape hatch) — 2026-08-05 — CONTINUE_ON_VERIFY_FAILURE: stage an unbuildable draft for review anyway

**Requested explicitly** ("for now if it fails, then skips the verification")
after four consecutive real runs each failed on a different generation defect.
The concern that a weakened gate lets non-compiling code reach a PR was raised
earlier and reaffirmed by the user; this implements it as a deliberate,
reversible switch rather than a behaviour change.

**What it does.** When verify still fails after every retry, the graph routes to
`stage_draft` instead of `END`, so the run reaches `staged_for_review` with a
preview, exactly like a passing run — except it is flagged.

**What keeps it honest:**
- Off by default (`CONTINUE_ON_VERIFY_FAILURE=false` in `.env.example`; enabled
  in the local `.env`). Default routing is unchanged and still tested.
- It does **not** short-circuit repair: retries still run to exhaustion first,
  so the targeted-repair loop (v0.25) gets every attempt it would have had.
- The run carries a new `verifyBypassed` flag (new `runs.verify_bypassed`
  column, additive migration) and keeps the full failure report in `runs.error`.
- The run log states plainly: *"THE PAGE IS NOT KNOWN TO BUILD; do not approve
  it without checking the errors above."*
- The review panel replaces its normal "verification passed" copy with a red
  banner: **"This page does NOT build."** — approving opens a PR containing code
  that does not compile.

**Bug caught by the new test before it shipped:** `node:sqlite` cannot bind a
JavaScript boolean, and `07-verify.mjs` passes `verifyBypassed` on *every*
verify — so this would have thrown on every single run. `updateRun` now coerces
booleans to the 0/1 integer SQLite actually stores.

**Verification:** 206 tests, 198 pass, 8 pre-existing skips, 0 fail (5 new).
The routing decision table is pinned for all four combinations (pass / retries
left / exhausted+flag / exhausted+no-flag), and default behaviour is asserted
unchanged. Additive migration run against a copy of the real live
`data/campaigns.db`. Graph compiles, server boots, UI builds and lints clean.

**Files touched:** `src/config.mjs`, `src/pipeline/run-campaign-pipeline.mjs`,
`src/pipeline/steps/07-verify.mjs`, `src/state/sqlite-campaign-repository.mjs`,
`src/state/database-schema.mjs`, `.env`, `.env.example`; new
`test/continue-on-verify-failure.test.mjs`; UI: `ui/src/api.ts`,
`ui/src/pages/RunDetailPage.tsx`, `ui/src/App.css`.

### v0.28 — Feature — 2026-08-07 — Fast per-file precheck: catch generation defects in 0.6ms instead of ~60s

**The complaint:** "the same error of verify in Docker failing… it keeps failing
again and again for the last fourteen days."

**Docker was never the problem.** `docker run (node:20-alpine) [npm ci && npm run
build] failed` only means the command *inside* the container exited non-zero.
Docker pulled the image, installed 557 packages and ran `next build` correctly
every time; `next build` then rejected the generated code. The last run's three
attempts read:

1. `Can't resolve '../../../../../components/SectionLine'` — an invented import
2. `Binding element 'children' implicitly has an 'any' type` — untyped props
3. `export default HeroSection0;"` — **a stray trailing quote**

Setting `VERIFY_DISABLE_DOCKER=true` would reproduce all three on the host and
reintroduce the Node-version mismatch Docker exists to avoid.

**The actual problem was loop economics.** Logs show `npm ci` taking 54s–1m on
*every* attempt. Three attempts ≈ 4–5 minutes of compute, whose final verdict was
"there is one extra quote character" — something detectable in well under a
millisecond.

**What was built.** New `src/verify/precheck-section-file.mjs` runs three checks
on each generated file immediately after the agent writes it — before the page is
composed and long before Docker is invoked:

| Check | Catches | Needs |
|---|---|---|
| Syntax | stray quotes, unclosed braces, mid-template EOF | the target repo's own `typescript` |
| Imports | invented relative paths, missing aliased files, undeclared packages | filesystem + `package.json` |
| Types | untyped destructured props under `"strict": true` | nothing |

On failure the agent is immediately re-prompted with the exact problem and asked
to make the smallest fix — a bounded inner loop (`precheckAttempts`, default 2)
that runs entirely locally. Docker then only ever sees code that already parses,
resolves and is annotated, so it verifies *integration* rather than typos.
Measured at **0.6ms per file** against the real repo.

**Design rule: no false positives.** Blocking valid code would be a
self-inflicted outage; missing a defect merely costs what it already costs.
A hand-rolled lexer was written first and **rejected** — it flagged
`<h1>it's "quoted" text</h1>` as an unterminated string, and apostrophes are
everywhere in marketing copy. It was replaced with the real TypeScript parser
(`ts.createSourceFile` → `parseDiagnostics`), resolved from the target repo's own
node_modules. When no parser is resolvable (before the first install) the syntax
check **skips** rather than guesses. A second false positive was caught the same
way: `items.map(({ id }) => …)` is contextually typed and legal, so only
*declared* components (`const X = ({…}) =>`, `function X({…})`) are checked, and
a type annotation on either the variable or the parameter exempts it.

**Verification:** 227 tests, 219 pass, 8 pre-existing skips, 0 fail (21 new).
Every "catches" test is a verbatim reproduction of a real failure; the
no-false-positive tests cover apostrophes in JSX, regex vs. division, template
literals, callback destructuring and `React.FC` annotations. Validated end to end
against the real `atss-frontend` clone: all three real defects caught, a valid
hero passes, 48 declared packages read, TypeScript resolvable.

**Deliberately NOT done:** `node_modules` caching across attempts (still ~60s per
verify) and raising `MAX_TOKENS` (8192 — the stray trailing quote is consistent
with truncated output). Both remain open and are probably the next wins.

**Files touched:** new `src/verify/precheck-section-file.mjs`;
`src/sections/generate-sections.mjs`, `src/pipeline/steps/06-generate-sections.mjs`;
new `test/precheck-section-file.test.mjs`.

### v0.29 — Bugfix — 2026-08-07 — Orphaned scratch directory killed runs at clone

**Symptom:** `git worktree add … failed (128): fatal: '…/da6987aa-…' already
exists`, leaving the run at `failed_clone`.

**Root cause.** The run's scratch directory survived as an **orphan**: the repo's
files were on disk but there was no `.git` file, so git had no record of it
(`_base/.git/worktrees/` listed only an unrelated run). `git worktree remove
--force` therefore failed with "is not a working tree" — and the crash-resume
cleanup added in v0.23 swallowed that with `.catch(() => {})`, so `worktree add`
then ran straight into the still-present directory. Two defects: no filesystem
fallback, and a silent catch that hid the reason.

**Fix.** `removeWorktree()` is now defined by its outcome rather than by which
git command succeeded — the git calls stay best-effort, and if the path still
exists afterwards it is removed from the filesystem. It returns
`{ok, reason?}` instead of nothing. The recursive delete is guarded: the target
must resolve to a sibling of the base clone inside the scratch root and must
never be the base clone itself, so it cannot be pointed elsewhere. `clone()` no
longer ignores the result — it throws with the real reason instead of letting
`worktree add` fail with a far less informative message, and it also clears a
leftover BRANCH when the directory is already gone (a surviving branch alone
breaks `add -b`).

**Verification:** 230 tests, 222 pass, 8 pre-existing skips, 0 fail (3 new). The
new tests reproduce the exact orphaned state (files present, no `.git`), and
assert the guard refuses both a path outside the scratch root and the base clone
itself, checking in each case that the files survive. The real stuck directory
was then cleared using the fixed function — it held no generated files and had no
`draft_files` rows, so nothing was lost.

**Files touched:** `src/git/clone-and-commit.mjs`,
`src/pipeline/steps/04-clone-target-repo.mjs`; extended
`test/clone-and-commit.test.mjs`.

### v0.30 — Bugfix — 2026-08-07 — `npm run dev`'s --watch was killing in-flight campaign runs

**Reported as:** "the codebase fails and restarts during validation of the build."

**Root cause.** `npm run dev` is `node --watch`, which restarts the process
whenever any file under `src/` changes. A campaign run takes minutes, so editing
a single source file mid-run kills it — almost always during `verify`, the
longest stage. The run log then shows a build failure or `failed_clone`, which
reads like a codegen or Docker problem. The database confirmed it: three
separate runs carried `resume: service restarted while this run was at stage
"verify"` / `"clone"`.

Two hypotheses were tested and **disproved** before landing on this: writes into
`data/` do NOT trigger the watcher (verified — creating files there caused no
restart), and it was not memory pressure (18 GB RAM, 8 GB swap, no OOM kills).
Touching `src/config.mjs` with the dev server running produced
`Restarting 'src/server.mjs'` and a second boot, confirming the real cause.

**Fixes.**
- The server now prints a loud warning at boot in watch mode. Detection is
  non-obvious: in watch mode Node runs the script in a *child* process, so
  `--watch` never appears in that child's `execArgv` — it is marked with the
  `WATCH_REPORT_DEPENDENCIES` env var instead. A first attempt checking only
  `execArgv` silently printed nothing; both signals are now checked.
- `removeWorktree`'s filesystem fallback now retries. A resume failed with
  `ENOTEMPTY: directory not empty, rmdir '…/node_modules/@tsparticles/…'` —
  deleting a worktree's node_modules races with writes still flushing from a
  Docker build whose container outlived the process that started it. Retries
  with backoff, plus `rm`'s own `maxRetries`.
- `full_doc.md` gains a prominent troubleshooting entry, since the symptom
  points at entirely the wrong subsystem.

**Guidance:** use `npm start` for real campaigns; `npm run dev` is for editing
the service itself.

**Verification:** 230 tests, 222 pass, 8 pre-existing skips, 0 fail; suite run
three consecutive times clean. Warning confirmed to appear under `npm run dev`
and to stay silent under `npm start`.

**Files touched:** `src/server.mjs`, `src/git/clone-and-commit.mjs`, `full_doc.md`.

### v0.31 — Root cause found — 2026-08-07 — The TARGET REPO does not build; verify could never have passed

**The finding that explains the whole fortnight.** A verify failure pointed at
`./src/app/soc-health-check/page.tsx` — a path **outside** `WRITE_PATH_ALLOWLIST`
(`src/app/campaigns/{slug}/`), which the four-layer write guard makes it
physically impossible for this service to create. It is pre-existing target-repo
code, `git ls-files`-tracked, last touched by `siddikAspire` four weeks ago in
"Merge pull request #4 from dev-aspire/trainingUpdate".

Typechecking the **pristine** base clone (no campaign files present at all)
confirmed it:

```
src/app/soc-health-check/page.tsx(22,9): error TS2322:
  Property 'contents' does not exist on type 'Frame29Props'. Did you mean 'contents1'?
```

`Frame29Props` requires `contents1` and `contents2`; the page passes `contents`
and omits both. Of 928 raw `tsc` errors, 926 were `TS2307 "cannot find module
*.png"` — verified spurious, since those image files exist (an artifact of raw
tsc without Next's image declarations). **Exactly one was real.**

`next build` runs the type checker, so the target repo's `dev` branch does not
compile on its own. **No generated code could ever have made verify pass.**

Why it surfaced only now: earlier runs failed on defects in the generated
sections themselves, so tsc/webpack stopped at ours first. Once v0.28's per-file
prechecks cleaned those up, the build got far enough to reach the repo's own
pre-existing error. The identical-looking failure was actually progress.

**Fix (in this service):** verify now distinguishes "our code is broken" from
"the target repo doesn't build". New `extractAllBlamedFiles()` collects every
blamed file with no allowlist filter; when a failure blames files but **none**
are ours, the log says so explicitly rather than letting it read as a codegen
bug. The composed-page exclusion was also tightened — it previously dropped any
`*/page.tsx`, which would have hidden this very file; it now excludes only our
own `${allowlistBase}page.tsx`.

**Fix (in the target repo — not ours to make):** `src/app/soc-health-check/page.tsx`
must pass `contents1`/`contents2` instead of `contents`. Until then every run
fails at build no matter what it generates.

**Verification:** 234 tests, 226 pass, 8 pre-existing skips, 0 fail (4 new).
Classification confirmed against the real report: 0 files ours, 1 file foreign →
"NOT CAUSED BY THIS RUN".

**Files touched:** `src/verify/failing-files.mjs`,
`src/pipeline/steps/07-verify.mjs`; extended `test/failing-files.test.mjs`.

### v0.32 — Host npm instead of Docker; the generated page is finally *shown* — 2026-08-07

Three changes, from the same request: stop building in Docker, show the page the
model actually generated, and make the review UI readable by someone who has not
read the pipeline source.

**1. Docker is off by default.** `VERIFY_DISABLE_DOCKER` now defaults to **true**
(new `boolFromEnvDefaultTrue` helper in `config.mjs`), so verify and preview both
run the target repo's own `npm ci` / `npm run build` / `npm run start` directly on
this host.

The original reasoning for the container path was sound — build against the Node
version the repo's own Dockerfile declares, rather than whatever the host has —
but in practice it was the single largest source of failed runs: image pulls,
bind-mount permissions, and containers outliving the process that spawned them
while holding file handles inside a worktree we were then trying to delete
(`ENOTEMPTY` on `node_modules/@tsparticles/…`, see v0.29). Host npm is the same
command a human would type, in a directory they can `cd` into.

Set `VERIFY_DISABLE_DOCKER=false` to put the container path back. Note the
tradeoff this accepts: the host runs Node 24 while the repo's Dockerfile declares
`node:20-alpine`. Next 14.2 supports both, but a native-module failure that only
appears on one of them is now possible in a way it wasn't before.

**2. The campaign landing page is embedded in the review UI.** This is what a
review gate is *for*, and until now the UI showed a link and a list of filenames.

The blocker was not effort — it was `X-Frame-Options: DENY`, which the target
repo's `next.config.mjs` sends on every route from its `securityHeaders` block.
A browser renders an iframe of that as a permanently blank box, with the reason
visible only in the devtools console. That header is correct for production and
patching the repo to work around our own tooling was not an option.

New `src/preview/frameable-proxy.mjs` — a ~60-line reverse proxy that fronts a
running preview server and strips `x-frame-options` and
`content-security-policy` on the way out. It gets its **own port**, not a path
prefix on the API server, because a Next page references its assets with
root-absolute URLs (`/_next/static/…`); under a prefix every one of those would
resolve against the API root and 404. Its own origin means no HTML rewriting and
nothing to keep in sync with whatever Next emits next. It is bound to 127.0.0.1
and each instance is pinned to exactly one upstream at construction — a request
cannot steer it elsewhere (there is a test for that).

`previews` gains `proxy_port` and `embed_url`. `url` still points straight at the
preview server, so "open in a new tab" and "render in the iframe" stay
independently meaningful. Proxy handles live in an in-process map keyed by
preview row id — unlike the preview server there is no pid to persist, and a
service restart takes them down along with the previews they front, which
boot-time reconciliation stops anyway.

**3. Preview falls through to `next dev` when `next start` can't serve.** The
process path now tries every serve script the repo declares, in
`SERVE_SCRIPT_PREFERENCE` order, instead of only the first. `start` needs a built
`.next`; when verify failed and `CONTINUE_ON_VERIFY_FAILURE` staged the draft
anyway, there is no build output, `next start` exits instantly, and the old code
gave up — so the one run where seeing the page matters most was the run that
showed nothing. `dev` compiles on demand and renders the page even while an
unrelated file in the repo won't typecheck. It gets a 120s ready timeout rather
than 60s, since it compiles the route on first request.

**4. The run detail page is now tabbed, and says what it means.** Page preview /
Generated code / Plan & checks / Activity log, opening on whichever is
informative for the run's current state.

- **Page preview** — the live page in an iframe, with desktop/tablet/phone width
  switching, reload, open-in-new-tab and stop.
- **Generated code** — the actual source of every staged file, with line numbers,
  a lightweight three-token highlighter and copy-to-clipboard. It previously
  showed paths and character counts, which told you a page existed but nothing
  about what was in it.
- Every stage now carries a plain-English sentence ("Choosing which sections
  reuse an existing design and which need AI") instead of only its internal key,
  in the stepper tooltip, the header line, and the campaign list's stage column.
  Verify badges gained hover text; "skipped" became "not run".
- The approve/abandon gate moved to a bar directly under the header, so the
  decision isn't below a full page of scrolling. It turns red when
  `verifyBypassed` is set.
- The log console gained a "problems only" filter.
- Responsive at 1080/860/720px: the code viewer stacks, the stepper scrolls
  horizontally rather than wrapping into ragged rows, and the run table drops its
  two least important columns on a phone.

**Verification:** 244 tests, 236 pass, 8 pre-existing skips, 0 fail (6 new,
covering header stripping, path/method/body forwarding, absolute-redirect
rewriting, 502-on-dead-upstream and upstream pinning). `ui`: `tsc -b && vite
build` clean, `oxlint` clean. Graph compiles; server boots and `/healthz` returns
200 with the new columns migrated in.

**Files touched:** `src/config.mjs`, `.env`, `src/preview/frameable-proxy.mjs`
(new), `src/preview/preview-server.mjs`, `src/state/database-schema.mjs`,
`test/frameable-proxy.test.mjs` (new), `ui/src/api.ts`,
`ui/src/pages/RunDetailPage.tsx`, `ui/src/pages/CampaignListPage.tsx`,
`ui/src/pages/NewCampaignPage.tsx`, `ui/src/App.css`.

### v0.33 — Honeypot typed as required broke every lead form — 2026-08-07

A real run (`f2fa8b7d`) burned three consecutive Docker builds on one type
error in its own generated hero, and the repair loop could not talk its way out
of it:

```
interface IFormData { …; company_website: string }        // required
yup.object().shape({ …, company_website: yup.string() })  // optional
useForm<IFormData>({ resolver: yupResolver(schema) })

Type 'Resolver<{ company_website?: string | undefined; … }>' is not
assignable to type 'Resolver<IFormData, any, IFormData>'.
```

The honeypot is optional **by definition** — a human visitor always leaves it
empty — so any validation schema will infer it optional, and declaring it
required in the TypeScript type can never typecheck. The lead form contract
described the honeypot's markup, styling and submit behaviour in detail but said
nothing about its *type*, so the model had no reason to get this right.

**Fix 1 — the contract says it now.** `buildLeadFormPromptFragment` states that
the honeypot must be `company_website?: string`, quotes the exact `tsc` error it
causes otherwise, and generalises the rule: when a schema is passed to `useForm`
through a resolver, the type argument must match what the schema infers exactly
— optional for optional, required for required.

**Fix 2 — a precheck catches it in milliseconds.** New `checkHoneypotOptional()`
in `precheck-section-file.mjs` flags a non-optional honeypot property, so the
repair loop gets an instant single-file error instead of paying a full
`npm ci` + build to learn it. Gated on the file actually importing
react-hook-form, so a marketing section that legitimately carries a "company
website" field is never touched — the module's no-false-positives rule. Not
gated on `strictTypes`: this is a plain assignability error that fails under any
tsconfig.

Note the check holds even if the mismatch is "fixed" the other way, by making
the schema require the honeypot — that would typecheck and then silently block
every genuine visitor from submitting the form.

**Verification:** 250 tests, 242 pass, 8 pre-existing skips, 0 fail (6 new). The
positive case is the verbatim failing file from run `f2fa8b7d`; the negative
cases cover an optional honeypot, a yup schema entry, a zod `.optional()`, a
form-less section, and a commented-out declaration.

**Files touched:** `src/leadform/contract.mjs`,
`src/verify/precheck-section-file.mjs`, `test/precheck-section-file.test.mjs`.

### v0.34 — The preview was showing the wrong page — 2026-08-07

A runtime error reported from a preview —

```
Failed to parse src "Francesca Blake" on `next/image`
```

— turned out to come from the target repo's **home page**, not from anything
this service generated. Confirmed by exhaustion: the string appears in no file
in the repo and in none of the six generated files (it is live API data), and
not one generated file so much as imports `next/image`.

**Root cause: `PAGE_URL_PATH_TEMPLATE` was never set.** With it unset,
`pageUrlPath` is null, so the preview URL degrades to the bare server root —
the target repo's home page — and the reviewer is looking at somebody else's
bug. It also silently disabled hero-fit/SEO/a11y on every run since the
feature shipped. Now set to `/campaigns/{slug}`, matching the route
`WRITE_PATH_ALLOWLIST=src/app/campaigns/{slug}/` produces.

**Second bug, found while fixing the first.** Setting that variable would have
crashed every run, because the three browser-backed checks were never
survivable: `playwright` is an npm dependency, but the ~150MB browser it drives
is a separate download that `npm ci` does not fetch. `chromium.launch()` then
rejects, and that rejection escaped `runFullVerifySuite`'s `Promise.all`
uncaught — a tool that was simply never installed presenting as a hard pipeline
failure at verify.

New `verify/browser-availability.mjs` probes once per process (the answer can't
change mid-lifetime) and caches. When no browser is launchable, the three
checks report `null` — "not run" — alongside the concrete remedy
(`npx playwright install chromium`), which is the honest answer: build/lint
already passed, and a missing optional tool is not a failing page. Run
`npx playwright install chromium` to turn the checks back on.

**Verification:** 253 tests, 245 pass, 8 pre-existing skips, 0 fail (3 new). The
skip-path test builds a real minimal Node repo so the suite genuinely passes
build/lint and *reaches* the browser branch — a fixture that short-circuits
earlier would prove nothing. It self-skips where chromium is installed.

**Files touched:** `.env`, `src/verify/browser-availability.mjs` (new),
`src/verify/run-full-verify-suite.mjs`, `test/browser-availability.test.mjs`
(new), `full_doc.md`.

### v0.35 — Static section wrappers were missing `"use client"` — 2026-08-08

A run failed verify three times with a report that said nothing useful:

```
uncaughtException TypeError: Unexpected response from worker: undefined
  at ChildProcessWorker._onMessage (…/next/dist/compiled/jest-worker/index.js)
```

Fifteen lines, no source file, no compile error. Running the **same** build by
hand in the same workdir minutes later printed the actual cause:

```
You're importing a component that needs useState. It only works in a Client
Component but none of its parents are marked with "use client".
  ./src/components/frames/landing/analyze/SyllabusAccordionFrame.tsx
  ./src/app/campaigns/<slug>/sections/CurriculumSection2.tsx
  ./src/app/campaigns/<slug>/page.tsx
```

Three separate defects, in decreasing order of importance.

**1. The real bug — `fill-static-frame.mjs` emitted no client boundary.** The
static-section templater produced a wrapper importing a frame that calls
`useState`, with neither the wrapper nor the composed page marked
`"use client"` — so nothing in the chain was a Client Component and webpack
refused it. Not an LLM slip: this is our own deterministic template, so every
static section wrapping an interactive frame was broken the same way.

Wrappers now open with `"use client";` unconditionally. Detecting the need
properly would mean resolving transitive imports — `FaqAccordionFrame` doesn't
call a hook itself, it imports `Accordion`, which does — so a one-level scan
would miss half the cases. The asymmetry settles it: a wrapper marked client-side
that didn't need it costs a slightly larger bundle, while missing one costs a
failed build and a wasted retry. These wrappers are always the same shape (a
synchronous component rendering a frame with inline literal data, never async,
never server-only), so there is nothing `"use client"` can break here.

**2. `Next.js` was reported to the user as a failing file.** `PATH_RE` matches
any token ending in a source extension, and Next's own version banner
`▲ Next.js 14.2.35` ends in `.js`. Combined with the `node_modules` path from
the worker stack trace — which `extractAllBlamedFiles` never filtered, since it
passes no allowlist — the classifier announced *"the target repository does not
build on its own: Next.js, …/jest-worker/index.js"*. Both are now excluded:
dependency internals always, and any token with no `/` in it. The cost is that
a blamed file at the repo root is no longer detected, which only weakens a hint;
a fabricated filename actively misleads. Generated files always live under
`src/app/campaigns/<slug>/` and are unaffected.

**3. The worker crash now explains itself.** Next compiles in child workers and
pipes their output back to the parent. When a worker dies before replying —
OOM-killed under memory pressure being the usual reason — the parent crashes on
the empty message and never prints what the worker had found. `build-and-lint.mjs`
recognises the signature and appends a note saying it is an infrastructure
failure rather than a source defect, with the command to re-run by hand.

**Not reproduced end-to-end:** the worktree that exhibited this was abandoned
(and correctly cleaned up) before the fix landed, so the evidence is the
reproduced error with its import trace plus unit tests asserting the emitted
wrapper. The next real run is the confirmation.

**Verification:** 258 tests, 250 pass, 8 pre-existing skips, 0 fail (5 new).
The `node_modules`/banner tests use the verbatim stored report from run
`ea209fac`.

**Files touched:** `src/sections/fill-static-frame.mjs`,
`src/verify/failing-files.mjs`, `src/verify/build-and-lint.mjs`,
`test/fill-static-frame.test.mjs`, `test/failing-files.test.mjs`.

### v0.36 — Root cause of the fortnight: `node --watch` was breaking every build — 2026-08-08

**The whole thing. Found, reproduced, fixed.**

Running the service with `npm run dev` executes it under `node --watch`, and
Node's watch mode sets **`WATCH_REPORT_DEPENDENCIES=1`** in the process
environment. That variable tells a Node process to report every module it loads
back to its parent by pushing `{ 'watch:require': … }` messages down its IPC
channel.

It is inherited by every child, and every child of those children. `next build`
farms compilation and type-checking out to jest-worker child processes connected
over IPC — which then emit `watch:require` messages into the very channel
jest-worker uses for its own protocol. jest-worker reads a message shape it has
never heard of and the parent dies:

```
uncaughtException TypeError: Unexpected response from worker: undefined
  at ChildProcessWorker._onMessage (…/next/dist/compiled/jest-worker/index.js)
```

The parent then exits without printing anything the workers had found, which is
why every such report was ~15 lines with a stack trace into Next's own bundle
and no source file in it.

**Reproduced directly**, in a real worktree:

| command | result |
|---|---|
| `npm run build` | 71s, compiles, reports the real type error |
| `WATCH_REPORT_DEPENDENCIES=1 npm run build` | **1.9s**, `Unexpected response from worker: undefined` |

Why it stayed hidden for two weeks: it depends on nothing in the code and
everything in how the service happened to be launched. `npm start` builds fine;
`npm run dev` never can. Docker hid it too — a container gets a fresh
environment — so "verify only fails without Docker" read as an argument about
Docker rather than about the environment. Every earlier fix (v0.28 prechecks,
v0.31 target-repo type error, v0.32 host npm, v0.35 `"use client"`) was real and
necessary, and none of them could have made a run pass while this was in play.

**Fix.** New `src/spawn-env.mjs`: `cleanEnvForChildProcess()` returns
`process.env` with `WATCH_REPORT_DEPENDENCIES` removed and any `--watch` /
`--watch-path` stripped out of `NODE_OPTIONS`. Applied at every spawn site —
`verify/build-and-lint.mjs`, `verify/docker-build.mjs`,
`verify/ephemeral-server.mjs`, and both process paths in
`preview/preview-server.mjs`.

A warning already existed telling people not to use `npm run dev`. A warning is
not a fix; the service is now correct however it is started. The warning stays,
because the *other* half of the `--watch` problem — a source edit restarting the
process and killing a run in flight — is untouched by this.

**Verified end-to-end:** with `WATCH_REPORT_DEPENDENCIES=1` deliberately set in
the parent, `verifyBuild()` against a real worktree now runs the full 45-second
build and reports the genuine type error in the generated section, instead of
crashing in 2 seconds.

`build-and-lint.mjs`'s worker-crash annotation was rewritten to name this cause
first — the symptom is generic enough that a future reader hitting it for some
other reason should not have to rediscover any of the above.

**Verification:** 265 tests, 257 pass, 8 pre-existing skips, 0 fail (7 new). One
of them spawns a real child process and asserts the variable genuinely does not
survive into it, rather than only checking the returned object.

**Files touched:** `src/spawn-env.mjs` (new), `src/verify/build-and-lint.mjs`,
`src/verify/docker-build.mjs`, `src/verify/ephemeral-server.mjs`,
`src/preview/preview-server.mjs`, `src/server.mjs`, `test/spawn-env.test.mjs`
(new).

### v0.37 — Customizability, phases 1–3a: content rules, the plan gate, and copy editing without an AI — 2026-08-08

The service had exactly one point of human control: approve or abandon a
finished page. Everything else — tone, structure, section list, every word —
was whatever the model decided, and the only way to change any of it was to ask
an AI to regenerate a whole section. Three changes, marketing-first.

**1. The brief can state rules, not just facts.** `briefSchema` gains `tone`,
`brandNotes`, `mustInclude[]`, `avoid[]`, `referenceUrl`, `sectionTypes[]`,
`pageLength` and `reviewPlan`. New `schemas/content-rules-prompt.mjs` renders
them as their own labelled, numbered block for both the guide stage and the
per-section agent, framed as outranking the model's own judgement.

Why named fields rather than more free text: a rule you want honoured every
time ("never call it cheap") competes for attention with everything else when
it's buried in one paragraph. The reference URL is explicitly marked as *not
fetched* — without that the model writes as though it had read the page.

Structural rules go to the guide stage only. The per-section agent can write
exactly one file, so restating which sections exist just invites it to argue
with a settled decision.

`aiRequiredSections` and `deadline` were **already accepted by the schema and
never sent by the form** — working capability, invisible. Now exposed, along
with everything above, in a four-step wizard. Campaigns can also be duplicated
(`GET /campaigns/:runId/brief`), which deliberately withholds the old slug.

**2. The plan gate — the centrepiece.** The pipeline now stops after
`generate_guide` at a new non-terminal status `awaiting_plan_approval`. A human
edits the hero headline, SEO tags and section list — reorder, retype, add,
remove, reword — then approves, and only then does anything get generated.
Editing here is free; the same change afterwards costs an AI run per section.

The implementation is small because the machinery already existed.
`resumeInterruptedRuns()` re-drives a run by calling `runCodegen()` with the
persisted research and guide, both of which short-circuit their own LLM calls.
`approvePlan()` is that same call with the human-edited guide substituted in
and `planApproved: true`. **No checkpointer, no second graph entry point** —
one conditional edge on `generate_guide` and a new state channel.

`approve-or-edit-plan.mjs` mirrors `approve-or-abandon-run.mjs`, which is the
same idea one stage later. Human edits go through the identical
truncate-then-validate path the model's own output does — a person overruns an
SEO limit at least as often as a model, and neither should lose their work over
a cosmetic overage. The hero is pinned first and cannot be removed: it carries
the lead form, and verify's hero-fit check assumes it is the first thing on the
page.

`AWAITING_HUMAN_STATUSES` gains the new status, so boot-time reconciliation
leaves a parked run alone rather than "resuming" it straight past the human
standing at the gate, and DELETE stays a 409.

**3. Editing copy with no LLM at all.** A static section's content is a plain
object that `populateFrame` merges over the frame's defaults — so changing a
word is a data edit, not a code change. New
`sections/describe-fillable-fields.mjs` walks a candidate's `fillableFields`
**Zod schema** and emits form descriptors; the new `edit-copy` refine action
re-runs `populateFrame` with the submitted values, re-verifies and stages a new
draft version.

Because the form and the validation are derived from the same schema, a form
that submits is one the server accepts — it is not possible to enter invalid
data. Instant, free, and the control a marketing user will touch most: before
this, fixing a typo meant an AI rewrite of the whole section, with a fresh
chance to break the build.

The walker is deliberately narrow — string, array-of-string, array-of-object —
and reports anything else as unsupported rather than rendering a control that
would submit something the schema rejects. A test asserts every real catalog
candidate produces a fully renderable form, so a future entry using an
unfamiliar shape fails loudly rather than becoming a silently uneditable
section.

**Found while building it:** `buildStaticSectionFile` called `populateFrame`
with **no overrides**, so every static section rendered the frame's stock
marketing copy regardless of the campaign. It now threads and records
`dataUsed`, which is also what makes editing persist across edits. Switching
layout carries matching copy across key by key rather than discarding it.

**Verification:** 294 tests, 286 pass, 8 pre-existing skips, 0 fail (29 new).
`ui`: `tsc -b && vite build` and `oxlint` clean. Graph compiles; server boots;
the gate was exercised against a real database — plan read back with per-section
mode and layout choices, edited, persisted, status unchanged.

**Still to come (phases 3b/4):** draft version history and diffs, code editing
behind an Advanced toggle, more frame candidates per section type with
thumbnails, style presets, and token/cost tracking (the `token_usage` table
still has zero writers).

**Files touched:** `src/schemas/campaign-brief-schema.mjs`,
`src/schemas/content-rules-prompt.mjs` (new),
`src/pipeline/approve-or-edit-plan.mjs` (new),
`src/sections/describe-fillable-fields.mjs` (new),
`src/pipeline/run-campaign-pipeline.mjs`, `src/pipeline/refine-section.mjs`,
`src/pipeline/steps/03-generate-guide.mjs`,
`src/sections/section-agent-prompt.mjs`, `src/sections/generate-sections.mjs`,
`src/state/sqlite-campaign-repository.mjs`, `src/config.mjs`, `src/server.mjs`,
`ui/src/api.ts`, `ui/src/pages/NewCampaignPage.tsx`,
`ui/src/pages/RunDetailPage.tsx`, `ui/src/pages/CampaignListPage.tsx`,
`ui/src/App.css`, plus four new test files.

### v0.38 — Two broken catalog entries, and a poisoned base branch — 2026-08-09

Found by actually running the pipeline end to end for the first time, which
also confirmed v0.36: **the jest-worker crash is gone.** Builds now compile and
report real, specific errors.

**1. Two frame catalog entries had partial `defaultData`.** The file header has
always said `defaultData` must be a FULL copy of the frame's own default object,
never partial, because `data` is an all-or-nothing prop with no deep-merge. Two
entries violated it, and both broke the build of any campaign planning that
section:

- `instructor / trainer-profiles` declared `{ heading }` while
  `TrainerProfilesData` also requires `profiles` →
  *Property 'profiles' is missing in type '{ heading: string; }'*.
  Each profile carries a `StaticImageData` that exists only as a PNG import
  inside the target repo, so it cannot be expressed here at all. Overriding
  just the heading was never possible. Now **bare render**, which is what the
  header already prescribed for photo-dependent frames.
- `pricing / pricing-packages-grid` declared three intro-copy fields while
  `PricingPackagesGridData` also requires `packages` and `consultationUrl`.
  Completing it faithfully would mean copying Bronze–Titanium, $10,000 to
  $40,000, each with a live fastpaydirect payment link for one specific
  certification programme — onto every campaign that plans a pricing section.
  Pricing is the section that most has to be campaign-specific, so the entry is
  **removed entirely**; `classifySections` degrades pricing to ai-required and
  the AI writes one for the campaign actually being run.

Neither was caught because the frames live in the TARGET repo and nothing here
had ever read them. `test/static-frame-catalog.test.mjs` now does: it parses
each frame's `*Data` interface out of the base clone and asserts every required
prop is present in `defaultData`. It skips (loudly) when no base clone exists,
rather than passing vacuously.

**2. A broken generated page is committed on `dev`.**
`src/app/campaigns/soc-analyst-fast-track-bootcamp/sections/DetailsSection1.tsx`
fails with *Property 'icon' does not exist on type '{ text: string; }'*. It
reached `dev` through the `CONTINUE_ON_VERIFY_FAILURE` escape hatch: verify
failed, the draft was staged anyway, it was approved, a PR was opened, and the
PR was merged. It now breaks **every** subsequent run, exactly as
`soc-health-check/page.tsx` does — the classifier correctly reports
"NOT CAUSED BY THIS RUN".

This is the escape hatch working as designed and being used past the point it
was meant for. `CONTINUE_ON_VERIFY_FAILURE=true` is a temporary unblock, not a
mode to run in: every approval it permits can poison the base branch for
everything that follows.

**3. A stored error looked like a live one.** The run page rendered `run.error`
with no date, so a two-day-old failure from an already-fixed bug read exactly
like something happening now — which is precisely how it was reported. The
banner now carries "recorded <when>" plus, for finished runs, "this run is
finished, nothing is still failing", and the header shows the run's age.

**Also observed:** the service was SIGKILLed (exit 137) mid-run on this
machine, under ~11Gi of 18Gi already in use with a Next build in flight. Not a
code fault, but worth knowing: a campaign run plus a full `next build` needs
real headroom.

**Verification:** 295 tests, 287 pass, 8 pre-existing skips, 0 fail (1 new).
Two live runs against the real target repo: one parked at the plan gate in ~20s
with content rules honoured (`pageLength: short` → 3 sections, `mustInclude`
reflected in the section list), was edited over `PATCH /plan`, approved, and ran
through generation → verify → preview → `staged_for_review`. A second confirmed
the instructor fix emits `<TrainerProfilesFrame />` with no `data` prop and that
the campaign's own sections compile — the only remaining type error is in the
foreign file above.

**Files touched:** `src/design-catalog/static-frame-catalog.mjs`,
`test/static-frame-catalog.test.mjs`, `ui/src/pages/RunDetailPage.tsx`,
`ui/src/App.css`.

### v0.39 — Static sections now get AI-authored copy, not the frame's canned defaults — 2026-08-10

Found by inspecting a real run's "Generated code" tab: a campaign called
"Weekend Photography Starter Course" was rendering a FAQ about Income Share
Agreements and cybersecurity certifications, and a details section warning
about data breaches — the exact same words `static-frame-catalog.mjs` carries
so `fillableFields` has something to validate against. Every static section
on every campaign has always rendered these identical placeholder words,
because nothing ever passed campaign copy into `buildStaticSectionFile` as
`overrides` — `populateFrame` always ran with `overrides: {}`. A static
section being "static" (no coding agent, pure templating) was never supposed
to mean "not campaign-specific," only "not code."

**Fix: `sections/generate-static-content.mjs`.** One plain `generateText()`
call per fillable static section (JSON-in, JSON-out, not a coding-agent run)
asking for copy shaped like `describeFillableFields(candidate.fillableFields)`
— the exact schema `populateFrame()` validates the result against, so the
prompt shape and the validator can never drift apart. Any failure along the
way (network error, unparsable JSON, a shape the schema rejects) falls back
to `{}` — the frame's own real `defaultData` wins, exactly the old behavior —
never worth failing a run over. Bare-render candidates (`testimonials`/
`instructor`, whose real defaults are photos this service can't source) are
short-circuited to `{}` before any call is made.

New root doc `static-section-data.md` is the human-readable catalog this
draws from: for each static-catalog section type, which frame, whether it's
campaign-fillable, and the exact field shape. Deliberately NOT the runtime
source of truth (that stays the Zod schema, so the two can't drift) — it's
there so a human can see the whole shape landscape without reading five
`.tsx` files in the target repo's `analyze/` folder.

**Wiring, kept opt-in on purpose:** `generateSections()` gained an
`authorStaticContent` flag, default `false` — every existing test calls it
directly with no flag and must keep seeing the old, network-free behavior
(`test/generate-sections.test.mjs`'s "no LLM/network involved" test says so
explicitly in its own name). `pipeline/steps/06-generate-sections.mjs` (the
real pipeline entrypoint) passes `authorStaticContent: true` unconditionally.
`pipeline/refine-section.mjs`'s `"new"` action (adding a fresh static section
to an existing run) had the identical bug — `populateFrame({ candidate,
componentName })` with zero overrides — and now calls the same generator.
`"use-different-frame"` was left alone: every section type today has exactly
one static candidate, so there is nothing to switch to yet (Module 7 —
catalog curation — is what would make that path exercised).

**Verification:** 300 tests, 292 pass, 8 pre-existing skips, 0 fail (5 new,
in `test/generate-static-content.test.mjs`). The new tests cover the pure
shape-builder and the no-network early-return for bare-render candidates;
the actual `generateText()` success path is untested directly, same as
`guide()`/`research()` already were — it needs a real API key and network,
which this environment doesn't have.

**Files touched:** `src/sections/generate-static-content.mjs` (new),
`test/generate-static-content.test.mjs` (new), `static-section-data.md`
(new), `src/sections/generate-sections.mjs`,
`src/pipeline/steps/06-generate-sections.mjs`,
`src/pipeline/refine-section.mjs`.

### v0.40 — The guide plans each section separately instead of all at once — 2026-08-10

Follow-up to v0.39, prompted by looking at a real plan-gate screen: the
section summaries — the actual instruction the later coding/content stage
writes each section from ("The summary is the instruction the AI writes that
section from, so being specific pays off," per the UI's own copy) — were
one generic sentence each, because the whole plan (hero title, SEO copy, AND
every section's summary) came from ONE `generateText()` call. Asking a model
to write nine sections' worth of specific content briefs in the same breath
it's also deciding the page structure produces exactly what you'd expect:
shallow, interchangeable one-liners. The schema already allowed up to 400
characters per summary (`LIMITS.sectionSummary`); the prompt just never asked
for more than 100.

**`pipeline/steps/03-generate-guide.mjs` is now two phases, mirroring the fan-out
already used for actual section generation** (`sections/generate-sections.mjs`:
every ai-required section gets its own independent coding-agent run, all
concurrent, rather than one call writing the whole page):

1. **Outline** (`generateOutline`) — one call, same as before, but now asks
   only for structure: hero title, SEO copy, and an ordered section list of
   `{type, theme}`, where `theme` is a short (≤100 char) angle/purpose per
   section — just enough to keep sections from overlapping each other.
2. **Elaboration** (`elaborateSection`) — one independent call PER section,
   all run concurrently via `Promise.all`. Each gets the full campaign
   context, its own theme, the OTHER sections' themes (so it doesn't repeat
   their ground), and that section type's design-catalog reference — and is
   asked for a real 2-4 sentence, up-to-400-character content brief specific
   enough that "someone with no other context should be able to write the
   whole section from this brief alone."

The two phases' outputs are assembled into the exact same `{heroTitle,
heroHasVideo, seoTitle, seoMetaDescription, sections: [{type, summary}]}`
shape the rest of the pipeline already expects, then pushed through the same
`truncateGuideFields`/`validateGuide` used before — no schema change, no UI
change, no change to any downstream consumer (`approve-or-edit-plan.mjs`,
`sections/section-agent-prompt.mjs`, `sections/generate-static-content.mjs`
all keep reading `summary` exactly as they did). An elaboration failure for
one section (network error, bad JSON) never fails the run — it falls back to
that section's own outline theme as the summary, same "never fail over a
copy-quality feature" posture as v0.39.

Trade-off, accepted deliberately: this turns 1 LLM call into 1 + N (N = section
count, ≤9) per plan. Same trade the coding fan-out already made for the same
reason — more, narrower calls beat one call doing everything shallowly.

**Verification:** 300 tests, 292 pass, 8 pre-existing skips, 0 fail — this
step has no direct unit test in either version (same as `research()`; both
need a real network call and API key, which this environment doesn't have),
so the full suite is what confirms nothing else broke: `content-guide-schema.test.mjs`
(the schema `guide()` outputs into, unchanged) and everything downstream of
`state.guide` still pass untouched.

**Files touched:** `src/pipeline/steps/03-generate-guide.mjs`.

### v0.41 — Bugfix — 2026-08-11 — Poisoned sibling campaign no longer fails every run

**Symptom:** Every new campaign failed verify three times, then fell through
`CONTINUE_ON_VERIFY_FAILURE`, with:

```
./src/app/campaigns/soc-analyst-fast-track-bootcamp/sections/DetailsSection1.tsx
Type error: Property 'icon' does not exist on type '{ text: string; }'.
verify: NOT CAUSED BY THIS RUN — …
```

The ESLint `useEslintrc` / `extensions` line in the same report is noise —
Next 14 logs it when ESLint 9 rejects those options, then returns `null` and
continues; it does not fail the build.

**Root cause:** That DetailsSection1 was merged onto `dev` via the escape hatch
(verify failed → staged → approved → PR merged). `next build` typechecks the
whole app, so one broken sibling campaign fails every later run. The classifier
was already correct; the retry loop was not — it regenerated our sections three
times against a defect regenerating cannot fix.

**Fix (this service):**
1. After worktree checkout, quarantine every `src/app/campaigns/*` directory
   except the slug being generated. Deletions stay local; `commitPaths` only
   stages what this run wrote, so PRs remain additive.
2. When verify blames only foreign files, set `verifyForeignFailure` and skip
   further `generate_sections` retries (still honour `CONTINUE_ON_VERIFY_FAILURE`
   for staging).

**Fix (target repo):** `./fix-target-repo.sh` now also type-annotates
`defaultBenefits` in DetailsSection1 so `dev` itself builds again. Run it and
type `yes` to push.

**Verification:** new quarantine + decide-after-verify tests; related suite
26/26 pass.

**Files touched:** `src/git/quarantine-sibling-campaigns.mjs`,
`src/pipeline/decide-after-verify.mjs`, `src/pipeline/steps/04-clone-target-repo.mjs`,
`src/pipeline/steps/07-verify.mjs`, `src/pipeline/run-campaign-pipeline.mjs`,
`fix-target-repo.sh`, `test/quarantine-sibling-campaigns.test.mjs`,
`test/decide-after-verify.test.mjs`, `test/continue-on-verify-failure.test.mjs`.

### v0.42 — Bugfix — 2026-08-11 — Photography course no longer ships cybersecurity sections

**Symptom:** Weekend Photography Starter Course preview showed Aspire Tech
cybersecurity testimonials, an ISA FAQ, and an Azure/AWS/Splunk syllabus under
a photography heading/CTA.

**Root cause (three different static-frame failures, one page):**
1. **Curriculum** — `SyllabusAccordionFrame` only accepts heading/button via
   `data`; accordion items are hardcoded from shared `FrameData`. AI correctly
   rewrote the heading and still left cert modules underneath.
2. **Testimonials** — bare-render photo carousel always ships cyber bank-pro
   quotes; this service can't source replacement photos.
3. **FAQ** — fully fillable, but when `generateStaticSectionContent` returned
   `{}` the pipeline silently merged catalog defaults (ISA copy) onto the page.

**Fix:** Remove `curriculum`, `testimonials`, and `instructor` from the static
catalog (same treatment as `pricing`) so they classify as ai-required. For
remaining fillable static sections, require list-body overrides
(`staticOverridesAreUsable`); incomplete/empty results fall back to an
ai-required coding-agent section instead of shipping canned cyber copy.

**Verification:** 51 related tests pass.

**Files touched:** `src/design-catalog/static-frame-catalog.mjs`,
`src/sections/generate-static-content.mjs`, `src/sections/generate-sections.mjs`,
`static-section-data.md`, `test/generate-static-content.test.mjs`,
`test/classify-sections.test.mjs`, `test/approve-or-edit-plan.test.mjs`,
`test/describe-fillable-fields.test.mjs`.
