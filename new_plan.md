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

- A human curates `design/catalog.mjs`: a mapping from section type (`hero`, `timeline`, `details`, `faq`, `testimonials`, `curriculum`, `pricing`, `instructor`, `footer-cta`, etc.) to one or more canonical example file paths in the target repo, with a short human-written note on when to use which.
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
- `verify/hero-fit.mjs` renders the staged page in a headless browser at a desktop size (e.g. 1440×900) and a mobile size (e.g. 390×844), measures the bounding boxes of the title, the video-or-details block, and the form, and fails the check if any of them falls below the visible viewport at either size — no scrolling required to see all three.
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

| Phase | Deliverable | Notes |
|---|---|---|
| 1 | Core pipeline: intake → research → guide → manifest → clone → code, with the existing write-guard (layers 1–4) | Foundation; can be tested fully offline against a local bare-repo fixture |
| 2 | Design-context catalog + resolver; section-catalog enum in the guide schema | Human curates the initial catalog against the real target repo before this phase is considered done |
| 3 | Deterministic verify suite: build/lint (existing pattern) plus `hero-fit.mjs`, `seo-lint.mjs`, `a11y-lint.mjs` | Build a fixture library of pages that should pass/fail each check at both viewport sizes |
| 4 | Database staging layer: `draft_files`, `runs`, versioning; `staging/materialize.mjs` | This replaces "write straight to a branch" as the default output of `code` |
| 5 | Preview sandbox: containerized `preview_build`, port registry, reverse-proxy routing, idle teardown | Depends on the VM/Docker deployment being in place (§7) |
| 6 | LLM validation layer (`validate/`) and its report schema, surfaced via the run-status API | Build a small golden set of "clearly on-brand" vs. "clearly off-brand" examples to sanity-check the reviewer prompt before trusting it |
| 7 | Review workflow: approve / edit (structured + raw) / reject-with-feedback (regenerate, capped at 3) / abandon, wired into the orchestrator | Edit path must re-trigger verify before allowing another preview |
| 8 | Commit/push/PR stage moved to fire only after approval, reusing the git/GitHub modules as-is | Low risk — this logic already exists, it just moves later in the graph |
| 9 | Lead form component contract: honeypot, conditional job field, POST to the parent platform's lead endpoint, preview no-op mode | Blocked on the parent platform exposing (or already having) the receiving endpoint — flag this to that team early |
| 10 | Marketing-facing review UI: campaign creation, live preview embed, approve/edit/reject actions | Can start once Phase 5 (preview) and Phase 7 (review workflow) are functional |
| 11 | Observability, hardening, and the maintenance runbooks below | Should land before this handles real campaigns, not after |

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
- **Preview sandbox pool**: short-lived, one container per active review, hard resource caps, explicitly torn down by `preview/sandbox.mjs` on approval, rejection, or idle timeout — never silently auto-restarted, since a crashed preview should surface as "preview failed, please regenerate," not reappear unexpectedly.
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
