# Landing Page Automation — Architecture, Implementation & Maintenance Plan

**What this covers:** an AI-driven pipeline that generates campaign landing pages for an external frontend repository — one the company doesn't control the deployment of — and delivers them as a reviewed Pull Request. A human sees a real, working preview of the page and can approve, edit, or ask for a regeneration **before any code touches git history**. Once approved, a PR is opened; a developer merges it and deploys the target repo manually (that repo does not auto-deploy on merge).

---

## 1. Goals

- Marketing creates a campaign from a UI (brief: name, offer, audience, CTA, notes, optional demo video URL).
- An AI pipeline researches, drafts content, and writes real `.tsx`/`.jsx`/CSS files matching the target repo's existing design system and shared component library.
- The page is **SEO-friendly** and built for **aggressive lead capture**: a short title, a demo video (or campaign details if no video), and a lead form are all visible **without scrolling**, on both desktop and mobile.
- Below the fold, the page composes from a fixed catalog of section types (timeline, details, FAQ, etc.), which the AI may reuse as-is or redesign.
- Before anything is committed to git, marketing (and/or a technical reviewer) sees a **real, accurate preview** of the page and can **approve it, edit it, or send it back for regeneration** with feedback.
- Only on approval does the pipeline open a Pull Request against the target repo. A developer reviews and merges; deployment after that is a manual step outside this system.
- Every automated step has explicit guardrails: the coding agent can only write files it declared in advance, only within human-approved paths, never touches files that existed before the run, and never merges anything itself.

## 2. Non-goals

- This system does not deploy the target repo. Merge and deploy are human/dev-owned steps.
- This system does not store leads. Leads captured by the generated form are sent to the existing parent landing-page platform's lead pipeline, not stored here.
- This system does not manage the target repo's design system — it consumes it (reads existing shared components as reference) but doesn't own or version it.
- No auto-merge, ever. A human always makes the final merge decision on GitHub.

---

## 3. Pipeline Overview

```
                 ┌────────┐    ┌──────────┐    ┌────────────────┐    ┌──────────┐
POST /campaigns │ intake  │───▶│ research  │───▶│ generate_guide  │───▶│file_manifest│
(brief JSON)     └────────┘    └──────────┘    └────────────────┘    └────┬─────┘
                                                                            │
                    ┌───────────────────────────────────────────────────────┘
                    ▼
              ┌─────────┐      ┌──────────┐
              │  clone   │─────▶│  code    │◀──────────────────────────┐
              │(scratch, │      │(agentic  │                            │
              │ uncommitted)│    │ loop,     │                           │ regenerate
              └─────────┘      │ writes to │                           │ (AI cycle,
                                │ scratch)  │                           │  max 3, with
                                └────┬─────┘                            │  human feedback)
                                     ▼                                  │
                              ┌────────────┐                            │
                              │   verify    │  deterministic:           │
                              │             │  build, lint, hero-fit,   │
                              └────┬───────┘  seo-lint, a11y-lint       │
                          fail,    │ pass                                │
                     retries left  │                                     │
                          └────────┤                                     │
                     fail,         ▼                                     │
                  exhausted   ┌──────────┐                                │
                  → END       │ validate  │  LLM judgment:                │
                  (failed)    │           │  design conformance,          │
                               └────┬─────┘  content fidelity,            │
                                    ▼         SEO copy quality             │
                             ┌─────────────┐  (report only,                │
                             │ stage_draft  │   never auto-retries)        │
                             │ (write files │                              │
                             │  + report to │                              │
                             │  database)   │                              │
                             └────┬────────┘                               │
                                  ▼                                        │
                           ┌──────────────┐                                │
                           │preview_build  │  materializes DB draft into    │
                           │(sandboxed,     │  a real build, serves it on    │
                           │ ephemeral)     │  an internal preview URL       │
                           └────┬─────────┘                                │
                                ▼                                          │
                          ┌───────────────┐                                │
                          │ await_review    │──── edit (human changes ─────┘
                          │ (human sees      │      files directly in DB,
                          │  preview + both   │      re-verify, re-preview)
                          │  reports)          │
                          └──┬─────────┬─────┘
                     approve │         │ reject / abandon
                             ▼         ▼
                     ┌──────────┐  ┌─────────────────┐
                     │  commit   │  │ teardown_preview  │
                     │ push      │  │ END (abandoned)   │
                     │ open_pr   │  └─────────────────┘
                     │ END       │
                     │(completed)│
                     └──────────┘
```

Three things worth calling out about this flow:

1. **Nothing reaches git — not even a draft branch — until a human approves.** The scratch clone used during `code`/`verify`/`preview_build` is never pushed; it's a disposable workspace. The durable staged artifact is the **database**, not a git branch.
2. **Two distinct kinds of "checking" happen, and they behave differently on failure.** `verify` is deterministic (build/lint/layout/SEO-tag/a11y) and retries automatically, same as a failed test suite. `validate` is an LLM forming a judgment about brand fit, content accuracy, and SEO *quality* — it never triggers an automatic retry; it only ever produces a report a human reads at `await_review`.
3. **A human has three options at review, not two.** Approve, reject (cycle back into `code` with feedback, AI regenerates, capped at 3 cycles), or **edit directly** — change the staged files/content in the database themselves, which re-runs `verify` and re-renders the preview without invoking the AI again.

---

## 4. Architecture

### 4.1 Module map

```
landing-page-automation/
├── server.mjs · config.mjs
├── ai/          text.mjs · coding-agent.mjs · tools.mjs
├── design/      catalog.mjs · resolve.mjs · schema.mjs
├── verify/      build.mjs · hero-fit.mjs · seo-lint.mjs · a11y-lint.mjs
├── validate/    design-review.mjs · content-review.mjs · report-schema.mjs
├── staging/     draft-store.mjs · materialize.mjs
├── preview/     sandbox.mjs · proxy.mjs
├── review/      edit-handler.mjs · decision-handler.mjs
├── leadform/    contract.mjs · rate-limit.mjs
├── delivery/    git.mjs · github.mjs
├── orchestrator/ graph.mjs · steps.mjs
├── schemas/     brief.mjs · file-manifest.mjs
├── state/       db.mjs
├── dev/         run-agent-standalone.mjs
└── test/        mirrors src/ 1:1, plus write-tool-allowlist.test.mjs (the most
                 important one — exercises all guard layers together)
```

| Folder | Responsibility |
|---|---|
| `ai/` | One-shot calls (research, guide, manifest) and the agentic coding loop with its four tools + write guard |
| `design/` | Human-curated section-type → reference-file catalog, resolved per campaign |
| `verify/` | Deterministic, auto-retried checks: build, lint, hero fit, SEO tags, accessibility |
| `validate/` | LLM judgment checks (design conformance, content fidelity, SEO copy quality) — report-only, never auto-retried |
| `staging/` | Reads/writes draft file versions in the database; materializes a draft onto disk for verify/preview/commit |
| `preview/` | Sandboxed container lifecycle for live previews, plus the internal proxy routing |
| `review/` | Applies human edits (re-triggering verify) and records approve/reject/abandon decisions |
| `leadform/` | Generates the lead-capture component and its rate-limit/honeypot contract |
| `delivery/` | Git CLI operations and the GitHub REST calls (clone, commit, push, open PR) |
| `orchestrator/` | The state machine tying every stage together, and its step implementations |
| `schemas/` | Zod validation for the campaign brief and the file manifest |
| `state/` | SQLite: runs, draft versions, verify/validation reports, review decisions |

### 4.2 Data model

The database is the source of truth for everything **until approval**. Git only becomes involved after that point.

- **`campaigns`** — id, slug, brief JSON (name, offer, audience, CTA, notes, video URL, `requiresJobField` flag), created_at.
- **`runs`** — id, campaign_id, status, stage, cycle_count, created_at, updated_at.
- **`draft_files`** — run_id, version, path, content (text), purpose. Every AI write and every human edit produces a new version row set, never overwrites in place — full history of how a page evolved is free.
- **`verify_reports`** — run_id, version, build_ok, lint_ok, hero_fit_ok, seo_lint_ok, a11y_ok, raw_report JSON.
- **`validation_reports`** — run_id, version, design_findings JSON, content_findings JSON, seo_quality_findings JSON.
- **`previews`** — run_id, version, port, container_id, preview_url, expires_at.
- **`review_decisions`** — run_id, version, decision (approve / reject / edit / abandon), feedback_text, edited_paths JSON (if decision = edit), decided_by, decided_at.

Status values a run can be in: `researching`, `drafting`, `coding`, `verifying`, `validating`, `staged_for_review`, `editing`, `regenerating`, `approved`, `pushing`, `pr_open`, `failed_verification`, `failed_push`, `failed_push_incomplete` (branch pushed, PR not confirmed — needs a human to open it manually), `abandoned`.

### 4.3 Design context: generating from the real design system

Reference frames are real code — actual `.tsx`/`.jsx`/HTML+CSS files from the target repo's existing shared component library — not screenshots or a separate design-token file. The coding agent already has `read_file`/`list_files` tools to explore the repo, but relying on it to guess which files matter produces inconsistent results. Instead:

- A human curates `design-catalog/reference-examples.mjs`: a mapping from section type (`hero`, `timeline`, `details`, `faq`, `testimonials`, `curriculum`, `pricing`, `instructor`, `footer-cta`, etc.) to one or more canonical example file paths in the target repo, with a short human-written note on when to use which.
- At `generate_guide` and `file_manifest`, the resolver fetches the actual contents of the relevant reference files and injects them into the coding agent's context — so "reuse or redesign a component" always starts from a concrete, real example, never a blank page.
- This catalog is edited by a human whenever the target repo's component library changes — same "human sets the boundary, not the AI" philosophy as the write-path allowlist below.

### 4.4 Section model: fixed catalog, free redesign within it

- `generate_guide` chooses section order **only from the fixed catalog** — a Zod enum, not free text. It cannot invent a new section type.
- Within a chosen section, the coding agent may reuse the reference component unmodified, adapt it, or write new markup — full creative latitude at the implementation level, none at the composition level.
- Every section, however extensively redesigned, still passes through the same write guard and deterministic verify checks (design tokens, semantic HTML, no hardcoded colors outside the theme) as any other file.

### 4.5 The hero: title + video/details + lead form, above the fold, on both viewports

This is the most business-critical structural constraint, so it's enforced two ways — a prompt-level contract for the AI, and a deterministic, non-negotiable check afterward:

**What the agent is told to build:**
- One above-the-fold block containing: a shortened campaign title, a video-or-details block, and the lead form.
- Video and lead form sit **side by side** at desktop widths; they stack vertically on mobile.
- If no video URL was provided, that slot is replaced with a compact campaign-details summary (what / when / who) — never left empty.
- No hard character limit on the title, but explicit sizing guidance: keep it in a comfortable range (roughly 40–60 characters) and use responsive sizing (e.g. CSS `clamp()` or the existing type scale) so a longer title shrinks gracefully instead of wrapping awkwardly or pushing the form out of view.

**What gets checked automatically, every time, at both viewport sizes:**
- `verify/check-hero-visibility.mjs` renders the staged page in a headless browser at a desktop size (e.g. 1440×900) and a mobile size (e.g. 390×844), measures the bounding boxes of the title, the video-or-details block, and the form, and fails the check if any of them falls below the visible viewport at either size — no scrolling required to see all three.
- On failure, the exact overflow (in pixels, per viewport) is fed back to the coding agent as a structured error, exactly like a failed lint rule. This is retryable, because it's objective — not a matter of taste.

### 4.6 Two-layer validation

Deliberately **two separate systems**, not one validation agent doing everything — mixing "is this technically correct" with "does this feel on-brand" in a single LLM call produces results that are neither reliably retryable nor cleanly explainable to a human reviewer.

**Layer 1 — Deterministic verification** (`verify/`, automatic retry up to a configured cap, same lane as build/lint):

| Check | What it catches |
|---|---|
| Build & lint | Compile errors, lint violations, using the target repo's own scripts |
| Hero fit | Above-the-fold violations at desktop and mobile |
| SEO lint | Title/meta-description length, single `<h1>`, sane heading order, missing `alt` text, missing canonical tag, missing/invalid structured data (JSON-LD for the campaign/course type), missing Open Graph tags, missing viewport meta |
| Accessibility lint | Contrast issues, ARIA misuse, unlabeled form fields (via axe-core) |

**Layer 2 — LLM judgment review** (`validate/`, always produces a report, never auto-retries):

| Check | Method | What it catches |
|---|---|
| Design conformance | Multimodal comparison: screenshot of the staged page vs. screenshots of the reference components it was supposed to draw from | Technically valid but off-brand spacing, tone, or imagery choices |
| Content fidelity | Text comparison: campaign brief/guide vs. rendered copy | Dropped pain points, mismatched CTA, missing FAQ items |
| SEO copy quality | LLM review of the actual title/meta-description text, not just its length | Generic or keyword-stuffed copy that passes the deterministic length check but reads poorly |

Layer 2's findings are shown next to the live preview at `await_review`. They never trigger an automatic loop back into `code` — a human decides what to do with them, whether that's approving anyway, editing directly, or sending it back for AI regeneration with the finding quoted as feedback.

### 4.7 Staged preview: code lives in the database first

This is the core of what you asked for, spelled out precisely:

1. Once `verify` passes, the coding agent's output is written to `draft_files` in the database as a new version for this run — **this is the canonical staged artifact**, not a git branch.
2. To render an accurate preview (not an approximation), `staging/materialize.mjs` writes that exact database content onto disk inside a fresh scratch clone of the target repo (uncommitted), then runs the target repo's real `install`/`build`, and `preview_build` serves it from an isolated, resource-capped sandbox container bound to an internal port.
3. The reverse proxy exposes it at an internal, access-controlled URL (e.g. `preview.internal.<domain>/{runId}/`) — not public, not indexable — for the reviewer to open.
4. Because the preview is a real build of the real repo with the real shared components, there's no separate "preview renderer" to keep in sync with production rendering — what's previewed is exactly what will be committed.
5. At `await_review`, three things can happen:
   - **Approve** → the currently-staged draft version's files are committed (only the paths declared in the manifest), pushed to a new branch, and a PR is opened.
   - **Edit** → the reviewer changes content or code directly (see below), which creates a new draft version, automatically re-runs `verify` (a human edit can break the build or the hero-fit check too — it gets the same treatment as an AI write), and re-renders the preview from the new version.
   - **Reject with feedback** → the feedback text, plus the full history of verify/validate reports, is passed back into `code`; the AI regenerates. Capped at **3 cycles**; past that, the run requires an explicit human decision to abandon it or take it over manually.
6. On approval, rejection-exhaustion, or an idle timeout (recommend ~2 hours), the sandbox container is torn down and its port reclaimed.

**On "edit" specifically** — two edit modes, both writing back to `draft_files`:
- **Structured edit**: common fields (title text, subheadline, CTA copy, video URL, form field toggles) exposed as simple UI inputs mapped to known placeholders in the generated components — low risk of breaking the build.
- **Raw edit**: a technical reviewer can open the actual file content (JSX/CSS text) in an editor and change it directly — higher latitude, but strictly limited to files already in this run's manifest (an editor in this UI cannot add a new path outside what was already declared and allowlisted), and always re-verified before the next preview render.

### 4.8 Lead form

- Fields: name, phone, email, and **job title only when the campaign's `requiresJobField` flag is set** (set at campaign creation — e.g. on by default for B2B/professional courses, off for consumer campaigns).
- Leads are sent to the **parent landing-page platform's existing lead-intake pipeline**, not stored by this system and not sent to the target repo's own backend. This requires that platform to expose a public, CORS-enabled endpoint accepting a campaign identifier alongside the lead fields — a small, one-time integration requirement to line up before this ships, not something this system builds itself.
- Every generated form includes a hidden honeypot field and basic client-side format validation (phone/email shape) as a first line of defense. The authoritative rate limit is enforced server-side on the receiving endpoint (IP-based throttling at minimum; a CAPTCHA is an easy addition if abuse shows up).
- In preview mode, the form is wired to a no-op/test flag so reviewers can see and click through the form without generating a real lead.

### 4.9 Execution sandboxing

Serving a real, running instance of AI-written code for review — as opposed to only building/linting it — is real execution, and needs its own containment, independent of the file-write guardrails:

- Each `preview_build` runs in its own isolated, resource-capped container (CPU/memory limits, wall-clock timeout, auto-teardown on idle).
- No production secrets (`GITHUB_TOKEN`, API keys, the shared secret protecting this service's own API) are mounted into the preview container — only whatever env the target app's own build genuinely needs.
- Network egress from the preview container is restricted to what the app needs to render (and, in preview mode, to hit the lead endpoint's no-op path).
- Preview URLs use unguessable IDs and sit behind the internal reverse proxy — this is often unapproved marketing copy and shouldn't be crawlable or publicly reachable.
- A capped pool of concurrent preview containers prevents one bad run (e.g., an infinite loop in generated code) from exhausting host resources; runs past the cap get a clear "at capacity, try again shortly" status rather than degrading everything else.

---

## 5. Guardrails for the Coding Agent

Layered so that a failure in any one layer doesn't compromise the whole system:

| Layer | Enforces |
|---|---|
| **1. Path containment** | No absolute paths, no traversal, resolved path must stay inside the scratch clone |
| **2. Pristine-file guard** | The agent can never write to any file that existed before the run started (captured via `git ls-files` right after clone), with the sole exception of files it wrote itself earlier in the same run |
| **3. Human-set path allowlist** | Writes are only permitted within directories a human has explicitly configured after inspecting the target repo (e.g. `app/campaigns/{slug}/`) |
| **4. File-plan match** | The agent may only write files it declared in its own manifest *before* coding began — no writing files it didn't plan for |
| **5. Section-catalog constraint** | Page composition can only draw section types from the fixed catalog — the model can't invent new section types on the fly |
| **6. Design-context grounding** | Section implementation always starts from a real reference file pulled from the target repo's own component library, not free-styled |
| **7. Hero structural contract** | Above-the-fold placement of title/video-or-details/form, checked by measuring rendered output — not taken on the model's word |
| **8. Deterministic verify suite** | Build, lint, hero fit, SEO tags, accessibility — all retried automatically against structured error feedback, capped at a configured max attempts |
| **9. LLM judgment review** | Brand conformance, content fidelity, SEO copy quality — always surfaced to a human, never used to auto-retry |
| **10. Execution sandbox** | Resource, network, and secret isolation for anything that actually *runs* AI-written code |
| **11. Database staging before git** | No commit, branch, or push happens until a human has explicitly approved a specific draft version — git history stays clean of unreviewed drafts entirely |
| **12. Edit re-verification** | Any human edit to staged code is re-run through the full deterministic verify suite before it can be previewed or approved — edits aren't exempt from the same checks AI output goes through |
| **13. Regeneration cap** | Maximum 3 human-feedback regeneration cycles per run before it requires an explicit abandon/manual-takeover decision |
| **14. No shell-exec tool** | The agent has exactly four tools (`list_files`, `read_file`, `write_file`, `finish_coding`) and cannot run arbitrary commands; build/verification is run by the orchestrator, never the model |
| **15. Human-only merge** | This system opens PRs; it never calls the merge endpoint, under any circumstance |

Two organizing principles worth stating plainly, since most of the above falls out of them:

- **Anything objectively checkable is a deterministic script's job, not an LLM's opinion.** Layout fit, tag presence, alt text, single-H1 — all measured, not asked-about.
- **Anything genuinely subjective is a report for a human, never an automatic gate.** Brand feel and copy quality get surfaced clearly; they don't silently pass or silently loop.

---

## 6. Implementation Plan

**⚠️ Renumbered 2026-07-28 to match reality — read this note before trusting any "Phase N" reference anywhere in this project.** This table originally numbered phases 1–11. `documentation.md`'s actual version-log entries (v0.1, v0.3, v0.5, v0.11, v0.15) have always called the exact same milestones "Phase 0" through "Phase 4" — a real, off-by-one inconsistency between this file and the changelog that actually shipped, not a stylistic choice. That mismatch is exactly what made "do phase 5" ambiguous in conversation. The table below is renumbered to match `documentation.md` (0-indexed) — that's now the one canonical numbering for this whole project. A **Status** column is added so "what's left" never again has to be reconstructed from memory.

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Core pipeline: intake → research → guide → manifest → clone → code, with the existing write-guard (layers 1–4) | ✅ Done — `documentation.md` v0.1 |
| 1 | Design-context catalog + resolver; section-catalog enum in the guide schema | ✅ Done — v0.3. `design-catalog/reference-examples.mjs`'s reference paths are still placeholders, unverified against the real target repo (module.md Module 7) |
| 2 | Deterministic verify suite: build/lint plus `hero-fit.mjs`, `seo-lint.mjs`, `a11y-lint.mjs` | ✅ Done — v0.5. hero-fit/seo/a11y have never run against a real Chromium in this dev sandbox (module.md Module 8) |
| 3 | Database staging layer: `draft_files`, `runs`, versioning | ✅ Done — v0.11, extended v0.17 with per-section `section_slot` versioning (§9.6) |
| 4 | Preview sandbox: containerized `preview_build`, port registry, idle teardown | ✅ Done — v0.15 |
| 5 | LLM validation layer (`validate/`) — design conformance / content fidelity / SEO-quality report | ❌ **Superseded by §9 below — not being built as originally scoped.** The per-section gallery review (§9.7) replaces the need for a separate LLM judgment report. |
| 6 | Review workflow: approve / edit (structured + raw) / reject-with-feedback / abandon | ❌ **Superseded by §9 below as originally scoped** (no raw-file editor, no separate structured-edit UI — §9.7's section gallery is the only review surface). **The underlying need — a real human gate before anything reaches git — is still open**, just implemented as §9.7 + Phase 7 below instead of this phase's original design. |
| 7 | Commit/push/PR stage moved to fire only after approval | ✅ Done — v0.19. Graph now ends at `preview_build`; `pipeline/approve-or-abandon-run.mjs`'s `approveRun`/`abandonRun` are the real human gate. Reject-with-feedback-and-regenerate deliberately deferred to pair with Module 4 (module.md). |
| 8 | Lead form component contract: honeypot, conditional job field, preview no-op mode | ✅ Done — v0.20. Real parent-platform lead-endpoint integration remains a separate external dependency, deliberately not built. Worth a follow-up: the real target repo's existing hero components actually use GHL iframes for lead capture, not a custom form — see v0.20's note. |
| 9 | Marketing-facing review UI: campaign creation, live preview embed, approve/edit/reject actions | ✅ Done — v0.21, built as §9's gallery/modal (module.md Module 4) rather than a raw approve/edit/reject UI. `pipeline/refine-section.mjs` (`use-different-frame`/`modify`/`redesign`/`new`), `GET .../sections`, `POST .../sections/:slot/refine`, `SectionsPanel`/`RefineModal` in the UI. Bulk regenerate (module.md Module 6) still separate, deliberately last-priority. |
| 10 | Observability, hardening, and the maintenance runbooks (§7) | 🔶 Partial — basic `/healthz` only; no cost tracking, no alerting |

---

## 7. Maintenance Plan (VM / Docker Deployment)

### 7.1 Topology

```
                    ┌─────────────────────────────┐
 marketing UI ─────▶│  reverse proxy (Caddy/nginx)  │
                    └───────────┬───────────────────┘
                                │
                ┌───────────────┼─────────────────────┐
                ▼                                       ▼
      ┌──────────────────┐                  ┌───────────────────────┐
      │  API container      │                  │  preview sandbox pool   │
      │  (server.mjs,         │◀── orchestrates ─▶│  (one container per      │
      │  orchestrator,          │                  │   active review, capped) │
      │  SQLite volume)         │                  └───────────────────────┘
      └──────────────────┘
                │
                ▼
        GitHub REST API (PR open only, after approval)
```

- **API container**: long-running, holds the SQLite database on a persistent volume, runs the orchestrator, serves the HTTP status/review API. Restart policy `unless-stopped`.
- **Preview sandbox pool**: short-lived, one container per active review, hard resource caps, explicitly torn down by `preview/preview-server.mjs` on approval, rejection, or idle timeout — never silently auto-restarted, since a crashed preview should surface as "preview failed, please regenerate," not reappear unexpectedly.
- **Reverse proxy**: owns TLS, routes the API, and routes each run's internal preview path.

### 7.2 Startup / crash recovery

On API container restart, a reconciliation pass scans for non-terminal runs from the previous process lifetime:
- Runs stuck in `coding`/`verifying`/`validating` → marked `failed`, safe to discard (nothing was ever pushed).
- Runs stuck in `staged_for_review`/`editing` → the draft in the database is untouched and safe; the preview container reference is marked `expired` and a fresh preview is rebuilt on next access, rather than trusting a possibly-dead container.
- Runs stuck between push and PR confirmation → marked `failed_push_incomplete`; the branch is already on the remote, so a human opens the PR manually. This is flagged by an alert (§7.4), not silently left for someone to discover later.

### 7.3 Secrets & rotation runbook

- Inventory: `GITHUB_TOKEN` (fine-grained PAT, contents + pull-requests, scoped to the target repo only), the shared secret protecting this service's own API, and the AI provider API key(s).
- Recommended rotation cadence: quarterly for the GitHub PAT at minimum, immediately on any suspected leak.
- Rotation steps: generate the new credential → update the environment/secret store → rolling-restart the API container → confirm a dry-run end-to-end pass succeeds → revoke the old credential → log the rotation.
- Preview containers never receive any of these secrets (§4.9) — there's nothing to rotate on that side beyond whatever the target app's own runtime genuinely needs to build.

### 7.4 Observability

- **Structured logs**: JSON lines per run/stage, retained and rotated on the host (or shipped to a lightweight aggregator if/when volume justifies it).
- **Metrics**: run counts by terminal status, verify-retry counts, validation-finding rates, active preview count vs. pool cap, regeneration-cycle distribution.
- **Alerting**: a webhook (Slack/email) at minimum on `failed_push_incomplete` (needs manual PR opening) and on preview-pool capacity being repeatedly hit.
- **Health checks**: `/healthz` reports process liveness, database reachability, and current preview-pool headroom.

### 7.5 Backups & retention

- SQLite database file: scheduled copy to separate storage — trivial given it's a single file, and it now holds every staged draft version, every review decision, and every report, so it's worth treating as the real system-of-record it is.
- Scratch clone workspaces and preview containers: cleaned up on terminal state, with a sweep job as a backstop for anything left over from a crash (e.g., older than 24h).
- Logs: rotate/retain per your organization's normal policy.

### 7.6 Scaling

A single API process plus SQLite is sufficient at low-to-moderate campaign volume. If concurrent reviews regularly exceed the preview-pool cap, the next step is a real job queue (e.g. Redis + a worker pool) in front of the orchestrator, multiple API workers, and SQLite → Postgres for multi-writer safety. This is a deliberate later step, not built up front, since it adds real operational weight for no benefit until volume actually demands it.

### 7.7 Incident runbooks

| Incident | First response |
|---|---|
| Run stuck in `preview_build` | Check the sandbox container's health; if it's dead, mark the preview `expired` and prompt a rebuild rather than debugging the dead container |
| `failed_push_incomplete` | Alert fires automatically; a human opens the PR manually from the already-pushed branch |
| Target repo's own build is broken for reasons unrelated to the generated files | `verify` will legitimately fail — don't burn AI regeneration attempts on it; surface a distinct "target repo unhealthy" status instead of looping the coding agent against an unrelated failure |
| GitHub API auth or rate-limit failure | Check PAT expiry/scope first before assuming a code issue |
| Preview sandbox repeatedly hits its resource cap | Investigate that specific run's generated code (infinite loop, heavy dependency) before raising the cap |
| **PR merged, but the site isn't updated** | Expected — this target repo does not auto-deploy on merge. Deployment is a manual step owned by the developer who merged it, outside this system's responsibility. Worth flagging as a standing improvement recommendation to that repo's owners (CI/CD auto-deploy would remove a manual step and a class of "merged but not live" confusion), but not something this pipeline should try to work around. |

### 7.8 Release process for this service itself

- A staging pass exercising the full pipeline — including a real approve/edit/reject-and-regenerate loop — against a local bare-repo fixture, with PR-opening disabled, before any change touching real target-repo credentials goes live.
- The design-context catalog and section catalog are versioned alongside code changes and reviewed the same way, since they're effectively part of the coding agent's contract.

### 7.9 Cost / token tracking

Log token usage per run per stage — research, guide, manifest, the coding loop, and now the LLM validation review (a new, non-trivial cost source, since it's a multimodal call on every successful verify pass). A simple weekly rollup by stage and provider is enough to catch runaway cost early and is far cheaper to have from day one than to reconstruct later.

---

## 8. Handoff Boundary: Where This System's Responsibility Ends

Worth stating explicitly, since it shapes both the maintenance plan and expectations for the dev team: this system's job finishes when a Pull Request is opened against the target repo. A developer reviews the diff and the preview evidence attached to the PR description, merges it, and then **manually deploys the target repo** — that repo does not auto-deploy on merge today. Everything after "PR opened" is outside this system's automation and outside its monitoring; the incident runbook above (§7.7) reflects that boundary rather than trying to paper over it. If auto-deploy is ever added to the target repo, this boundary shrinks naturally with no changes required on this system's side.

---

## 9. Amendment — Hybrid Section Assembly (2026-07-27, supersedes §6 Phases 5–6; directly implements Phase 7)

**Status as of 2026-07-28:** module.md Modules 1–3 done and tested (section classification, static templating, per-section AI fan-out, section-slot staging). First real end-to-end run against the real target repo hit and fixed a genuine config bug (`documentation.md` v0.18 — `WRITE_PATH_ALLOWLIST` didn't match this repo's `src/app/` convention). **Phase 7 (the real approval gate) is now done — v0.19.** The one piece still open from the original ask is per-section modify/refine (module.md Module 4) — reject-with-feedback-and-regenerate is deliberately paired with that, not built standalone.

**Status:** approved direction, implementation in progress. This section is additive/superseding — §6's phase table stays as a historical record of the original sequencing, but Phases 5 ("LLM validation layer") and 6/7 ("review workflow: approve/edit/reject", "commit/push/PR moved to fire only after approval") are replaced by what's described here, not built as originally scoped. §4.7's "staged preview: code lives in the database first" and §5's guardrail list still apply — this amendment changes *how* a draft gets assembled and reviewed, not the "nothing reaches git until approved" guarantee.

### 9.1 Why

The original plan generates the entire page through one monolithic agentic coding loop, then gates it behind a single review-and-approve step. In practice most sections of a landing page (FAQ, pricing, testimonials, footer CTA, …) don't need an LLM to write bespoke code every time — they're the same handful of layouts with different copy. Only the hero (and anything a campaign brief explicitly calls out) genuinely benefits from bespoke generation. Splitting the work this way gets a marketer a real, full-page preview in minutes instead of waiting on one long agent run, and lets them refine exactly the section that needs it instead of re-reviewing the whole page.

### 9.2 Section classification (replaces "guide chooses sections" as the whole story)

- `schemas/campaign-brief-schema.mjs` gains an optional `aiRequiredSections: SectionType[]` field — the marketer can flag specific section types as needing bespoke AI generation instead of static templating (e.g., "I want a custom pricing layout this time").
- Resolution rule, applied in code, not asked of the LLM: `hero` is **always** `ai-required`. Every other section is `static` **unless** it's in the brief's `aiRequiredSections`, or the fixed frame catalog (§9.3) has no static candidate for that section type at all (nothing to template against, so it falls back to `ai-required` automatically).
- `guide` still produces the ordered section list (type + summary) exactly as today; classification is a separate, pure, deterministic pass over that list — independently testable without a live LLM call.

### 9.3 Static frame catalog (new: `design-catalog/static-frame-catalog.mjs`)

Candidate static components are sourced from the **target repo's own analyzed component library** — `src/components/frames/landing/analyze/` in the `atss-frontend` repo, a set of ~53 legacy "Frame*" components catalogued and renamed by section type earlier in this project, each already following one uniform shape: `function XFrame({ data = defaultXData }: { data?: XData })`. `design-catalog/static-frame-catalog.mjs` is the human-curated bridge from the fixed `SECTION_TYPES` enum (`design-catalog/section-types.mjs`) to these real components — analogous to `design-catalog/reference-examples.mjs`, but for literal reuse (§9.4) instead of LLM grounding.

Each catalog entry declares:
- `component` / `importPath` — which real frame and how to import it.
- `defaultData` — a full, real copy of that frame's own built-in default data (never partial — see §9.4 for why).
- `fillableFields` — a Zod schema for the *subset* of top-level fields campaign copy is allowed to override (headings, FAQ items, CTA text, …). Fields not listed (real photos, payment links, fixed business config) always stay exactly as the frame's own default.
- Frames whose real defaults include non-serializable values (photo imports — testimonials, instructor bios) declare no `fillableFields`/`defaultData` at all and always render with no `data` prop, i.e. the frame's own untouched default. This is a deliberate limitation: this service has no way to generate or source real photos, so it never guesses.

`hero` intentionally has no catalog entry — per §9.2, hero is never static.

### 9.4 Static population (new: `populate-frame.mjs`, no AI, no coding-agent loop)

Pure templating: validates whatever campaign copy the guide produced for a section against that candidate's `fillableFields` schema, merges it over the frame's **full** real `defaultData` (`{...defaultData, ...overrides}` — full, not partial, because the target components take `data` as an all-or-nothing prop with no internal deep-merge; a partial object would blank out every field the merge didn't cover, including images the catalog can't reproduce), and emits a small wrapper file that imports the frame verbatim and renders it with the merged literal. Runs in parallel across every static section — cheap, deterministic, no model call, independently unit-testable with plain JS fixtures.

### 9.5 AI generation, scoped per section (decision: one independent agent run per section)

Each `ai-required` section (hero, plus any flagged) gets its **own** coding-agent invocation — not one shared loop writing multiple files off one file-manifest, as the original pipeline's `code` step did. These run concurrently with each other and with the static population pass (§9.4). This costs more orchestration (N independent runs instead of one) in exchange for independent retry/regeneration per section later (§9.7) without perturbing sections that already passed.

### 9.6 First assembly

Once every section (populated + AI-generated) is ready: each section is staged as its **own** `draft_files` row — the schema gains a **section-slot column** (decision: per-section versioning, not page-level-only) so refining one section later doesn't bump or lose history for the others. A first-cut `page.tsx` composes them in declared order and is staged too. This triggers the **first real gate**: the full deterministic verify suite (build/lint/hero-fit/seo/a11y) runs against the assembled page, not per-section — a section swap can affect page-wide checks (hero-fit, SEO, a11y), so the gate is always whole-page. On pass → `preview_build`, same as today — the marketer sees the whole page, target: minutes, not a multi-step wizard.

### 9.7 Per-section refinement — this IS the review step (decision: replaces §6 Phase 6 entirely; is what Phase 7's approval gate reviews)

No separate raw-file approve/edit/reject workflow gets built. The preview UI's rendered sections are each clickable, reopening a gallery/modal scoped to just that slot (use a different frame / modify / redesign / new) — every action writes a **new draft version for that slot only**, never touching the original frame file or any other section's rows. Every refinement re-runs the **full-page** verify suite (not just the section) before re-preview, for the same page-wide-check reason as §9.6. There is no separate LLM "validation report" layer (original §6 Phase 5) and no raw-text editor (original §4.7's "raw edit" mode) — the section-level gallery is the entire review surface.

### 9.8 Bulk regenerate (escape hatch, rare path)

One explicit "regenerate with new direction" action re-runs §9.5 across **every** section with a fresh prompt, forcing `mode: ai-required` for all sections for that one run — discards any accepted per-section refinements, so it's gated behind an explicit confirmation, not reachable accidentally.

### 9.9 Approval → existing pipeline (unchanged)

Approve still does exactly what §4.7/§5 already specify: commit only the manifest-declared paths, push, open a PR. Reject/edit/regenerate cycles (capped at 3) are unchanged in spirit, just operating at the per-section grain described above instead of whole-page.

### 9.10 Build order

1. Section-mode schema (`brief-schema.mjs`, `guide-schema.mjs`) + `design-catalog/static-frame-catalog.mjs` + `populate-frame.mjs` — no AI risk, ships first, independently testable.
2. Parallel assembly (§9.5/§9.6) + first full-page verify/preview — proves the fast-path end to end.
3. Per-section click-to-refine (§9.7) wired into a new gallery/modal UI.
4. Bulk-regenerate (§9.8) — last, lowest priority.

See `module.md` for the granular, file-level task breakdown against this build order.
