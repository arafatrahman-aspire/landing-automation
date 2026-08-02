# Module Breakdown — Remaining Work

One module per day (roughly). This covers everything left on the whole project, not just one feature — see `new_plan.md` for full architecture detail and `documentation.md` for what's already shipped (v0.1–v0.15). Update the checkboxes as each day's module is finished.

Status key: `[x]` done · `[~]` in progress · `[ ]` not started

---

## Already shipped (context, not a task)

Core pipeline, design-context catalog + resolver, deterministic verify suite (build/lint/hero-fit/SEO/a11y), SQLite staging layer, Docker-based verify, preview sandbox (Docker-first, process fallback). Full detail in `documentation.md` v0.1–v0.15. The pipeline today still auto-continues from `preview_build` straight to `commit → push → open_pr` with no human gate — that's what Module 5 below fixes.

---

## Module 1 — Section-mode schema + static frame catalog ✅ done
`design/frame-catalog.mjs`, `sections/classify.mjs`, `sections/populate-frame.mjs`, `brief-schema.mjs`/`guide-schema.mjs` additions. 34/34 tests passing.

## Module 2 — Wire section assembly into the orchestrator ✅ done
Replaced the single `code` node's whole-page loop with: `classify_sections` (pure, no LLM) → `generate_sections` (fan out: static sections via `populate-frame.mjs`, no LLM; `ai-required` sections each get their own independent coding-agent run, one file each, all concurrent) → deterministic page composition. `file_manifest` node retired (deterministic paths made it redundant) along with its schema file. Graph confirmed to compile; full test suite green; UI build clean. See `documentation.md` v0.16.

## Module 3 — Section-slot staging + first full-page assembly ✅ done (staging half only — see note)
Added a nullable `section_slot` column to `draft_files` (positional ids like `"section-0"`, `NULL` for the composed `page.tsx` row) and `getLatestVersionForSlot()`. `stageDraft()` now tags every staged file with its slot. Full test suite green (133 tests, 125 pass, 8 pre-existing skips, 0 fail); migration path verified against both a synthetic old-shape table AND a copy of the real live `data/campaigns.db`. See `documentation.md` v0.17.
**Note:** the "first full-page assembly + verify" half of this module's original description was actually already delivered by Module 2 (`generate_sections` already composes `page.tsx` and feeds it through the full verify suite before `preview_build`) — so this module ended up being the staging/versioning piece only. Nothing reads `getLatestVersionForSlot` yet and a verify retry still regenerates the whole page, not one slot — that's what Module 4 actually exercises.
**Still outstanding for real confidence: an actual end-to-end run against a real LLM + fixture repo** — every module so far has been verified by real (non-LLM) tests + a compile-time graph smoke test, not a live campaign run. Worth doing before Module 4 builds UI on top of this.

## Module 4 — Per-section refine UI (gallery/modal) ✅ done (built as Phase 9 — new_plan.md §6 is now the canonical numbering)
Backend: `orchestrator/refine-actions.mjs` (`use-different-frame`/`modify`/`redesign`/`new`), `GET /campaigns/:runId/sections`, `POST /campaigns/:runId/sections/:slot/refine`. Frontend: `SectionsPanel`/`RefineModal` in `RunDetailPage.tsx` — click a section, refine just that slot. Every refine writes a new version for that slot only and re-runs full-page verify before re-staging/re-preview. See `documentation.md` v0.21.
Not built: `findExistingImportExamples` retry-context isn't threaded into refine's AI actions (it's a fresh one-off, not a retry loop). Not visually verified in a browser (no browser in this sandbox).

## Module 5 — Real approve/reject gate (replaces auto-commit) ✅ done (approve/abandon — reject deferred)
Graph now ends at `preview_build`; `orchestrator/review-actions.mjs`'s `approveRun`/`abandonRun` are the real human gate — nothing reaches git without an explicit approve. Built as **Phase 7** per `new_plan.md` §6 (this project now uses that numbering as canonical — see the note at the top of §6). Reject-with-feedback-and-regenerate (capped at 3 cycles) is deliberately deferred to pair with Module 4's gallery, since it needs the same feedback UI. See `documentation.md` v0.19.

## Module 6 — Bulk regenerate (escape hatch)
One `POST /campaigns/:runId/regenerate` — forces every section to `ai-required` for a fresh run, discarding (not deleting) prior per-section refinements. Confirmation-gated in the UI, not reachable by accident.

## Module 7 — Design catalog curation against the real target repo
`design/catalog.mjs` (LLM-grounding references) and `design/frame-catalog.mjs` (static reuse candidates, Module 1) both currently point at either placeholder paths or the `atss-frontend` `analyze/` folder. Walk the real repo, confirm every referenced path actually exists, add more static candidates per section type where useful (today it's one candidate per type).

## Module 8 — Verify suite, proven for real
`hero-fit.mjs`/`seo-lint.mjs`/`a11y-lint.mjs` have never run against a real browser in this environment (`npx playwright install chromium` can't reach the network here). On a machine that can install Chromium: run the full suite for real against a real generated page, fix whatever the first real run surfaces.

## Module 9 — Lead form contract ✅ done (built as Phase 8 — new_plan.md §6 is now the canonical numbering)
`leadform/contract.mjs` (fields incl. conditional job title, honeypot, prompt fragment threaded into the hero's generation prompt), `POST /internal/preview-lead-sink` (no-op, honeypot-aware) so reviewers can click through the form without sending a real lead. Real parent-platform lead endpoint integration remains a separate, external dependency, deliberately not built. See `documentation.md` v0.20 — also flags a real tension worth resolving during Module 7's catalog curation: the actual target repo's existing hero components use GHL iframes for lead capture, not a custom form.

## Module 10 — Observability & cost tracking
`token_usage` table exists in the schema but nothing writes to it yet — wire it up per stage/run. Extend `/healthz` with DB reachability + active-preview-count vs. cap. Minimal alerting hook (e.g. a webhook) on `failed_push_incomplete`.

## Module 11 — Ops cleanup pass
Confirm `.env.example` has no real secrets (flagged early in the project, worth a final check). Sweep `README.md`/`documentation.md` for accuracy against what's actually shipped. Any other loose ends surfaced while working the modules above.

---

## Explicitly not being built (superseded — see `new_plan.md` §9)

- A separate LLM "validation report" layer — the per-section gallery review (Module 4/5) replaces it.
- A raw-file text editor for review — refinement only ever happens through the section gallery, never a freeform code editor.
