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
