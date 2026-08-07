import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  getRun,
  getRunLog,
  getRunDraft,
  getPreview,
  stopPreview,
  deleteCampaign,
  approveCampaign,
  abandonCampaign,
  getSections,
  refineSection,
  type RunSummary,
  type Draft,
  type Preview,
  type SectionSummary,
  type RefineAction,
} from "../api";

// Must stay in sync with src/design-catalog/section-types.mjs's SECTION_TYPES — duplicated
// here since the UI can't import a backend .mjs module directly.
const SECTION_TYPES = ["hero", "details", "timeline", "testimonials", "faq", "curriculum", "pricing", "instructor", "footer-cta"];

const TERMINAL = new Set([
  "completed",
  "failed",
  "failed_clone",
  "failed_verification",
  "failed_push",
  "failed_push_incomplete",
  "abandoned",
]);

const STATUS_CLASS: Record<string, string> = {
  completed: "status-ok",
  failed: "status-bad",
  failed_clone: "status-bad",
  failed_verification: "status-bad",
  failed_push: "status-bad",
  failed_push_incomplete: "status-warn",
  abandoned: "status-warn",
  staged_for_review: "status-warn",
};

const STAGES: { key: string; label: string }[] = [
  { key: "intake", label: "Intake" },
  { key: "research", label: "Research" },
  { key: "clone", label: "Clone" },
  { key: "guide", label: "Plan" },
  { key: "classify_sections", label: "Classify" },
  { key: "generate_sections", label: "Generate" },
  { key: "verify", label: "Verify" },
  { key: "stage_draft", label: "Stage" },
  { key: "preview_build", label: "Preview" },
  { key: "committing", label: "Commit" },
  { key: "pushing", label: "Push" },
  { key: "opening_pr", label: "Open PR" },
];

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

/* ---------------- Live log console ---------------- */

type LogLine = { id: number; time: string; level: string; stage: string | null; message: string };

// The backend writes plain text lines shaped "[iso-ts] [level] message", where
// most messages are themselves prefixed "stage: ...". Parsing that back out
// lets each line be colored and grouped instead of rendered as a flat blob.
const LOG_LINE_RE = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*([\s\S]*)$/;
const KNOWN_STAGES = new Set(
  STAGES.map((s) => s.key).concat([
    "generate_sections",
    "classify_sections",
    "open_pr",
    "resume",
    "refine",
    // Legacy stage names still present in the logs of runs created before the
    // Hybrid Section Assembly change — kept so old runs still render badges.
    "file_manifest",
    "code",
  ])
);

function parseLog(raw: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const match = LOG_LINE_RE.exec(line);
    if (!match) {
      // A continuation line (e.g. a stack trace) — attach it to the line above
      // rather than dropping it or pretending it's its own entry.
      const prev = lines[lines.length - 1];
      if (prev) prev.message += `\n${line}`;
      continue;
    }
    const [, time, level, rest] = match;
    const stageMatch = /^([a-z_]+):\s*/.exec(rest);
    const stage = stageMatch && KNOWN_STAGES.has(stageMatch[1]) ? stageMatch[1] : null;
    lines.push({
      id: lines.length,
      time: time.slice(11, 19), // HH:MM:SS — the date is noise at this density
      level: level.toLowerCase(),
      stage,
      message: stage ? rest.slice(stageMatch![0].length) : rest,
    });
  }
  return lines;
}

// Highlights the parts of a message a human actually scans for: verdicts,
// file paths, and counts.
function severityOf(line: LogLine): string {
  if (line.level === "error") return "err";
  const m = line.message.toUpperCase();
  if (m.includes("FAILED") || m.includes("REJECTED")) return "err";
  if (m.includes("WARNING") || m.includes("SKIPPED")) return "warn";
  if (m.includes("PASSED") || m.includes("DONE") || m.includes("SUCCEEDED")) return "ok";
  return "info";
}

function LogConsole({ raw, live }: { raw: string; live: boolean }) {
  const lines = parseLog(raw);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Only auto-scroll when the reader is already at the bottom — yanking the
  // view down while they're reading scrollback is worse than not following.
  function handleScroll() {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  useEffect(() => {
    if (stickToBottom.current) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [raw]);

  return (
    <div className={`console ${live ? "is-live" : ""}`}>
      <div className="console-bar">
        <span className="console-dot console-dot-r" />
        <span className="console-dot console-dot-y" />
        <span className="console-dot console-dot-g" />
        <span className="console-title">run log</span>
        {live && (
          <span className="console-live">
            <span className="console-live-dot" />
            live
          </span>
        )}
        <span className="console-count">{lines.length} lines</span>
      </div>
      <div className="console-body" ref={bodyRef} onScroll={handleScroll}>
        {lines.length === 0 && <div className="console-empty">waiting for output…</div>}
        {lines.map((line) => (
          <div key={line.id} className={`console-line sev-${severityOf(line)}`}>
            <span className="console-time">{line.time}</span>
            {line.stage && <span className="console-stage">{line.stage}</span>}
            <span className="console-msg">{line.message}</span>
          </div>
        ))}
        {live && <div className="console-cursor" />}
      </div>
    </div>
  );
}

function Stepper({ run }: { run: RunSummary }) {
  const currentIndex = STAGES.findIndex((s) => s.key === run.stage);
  const isTerminal = TERMINAL.has(run.status);
  const isFailure = isTerminal && run.status !== "completed";

  return (
    <ol className="stepper">
      {STAGES.map((s, i) => {
        let cls = "";
        if (run.status === "completed") cls = "done";
        else if (isFailure && i === currentIndex) cls = "failed";
        else if (i < currentIndex || (isFailure && i < currentIndex)) cls = "done";
        else if (!isTerminal && i === currentIndex) cls = "current";
        return (
          <li key={s.key} className={`stepper-step ${cls}`}>
            <span className="stepper-dot">{cls === "done" ? "✓" : cls === "failed" ? "!" : ""}</span>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h ${mins % 60}m`;
}

function PreviewPanel({ runId, preview, onStopped }: { runId: string; preview: Preview; onStopped: () => void }) {
  const [stopping, setStopping] = useState(false);

  async function handleStop() {
    setStopping(true);
    try {
      await stopPreview(runId);
      onStopped();
    } finally {
      setStopping(false);
    }
  }

  const isRunning = preview.status === "running";

  return (
    <div className="section-block card">
      <div className="card-header">
        <h3>Preview</h3>
        <span className={`status-pill ${isRunning ? "status-live" : "status-warn"}`}>{preview.status}</span>
      </div>
      <div className="card-body">
        <dl className="plan-meta" style={{ marginBottom: isRunning ? 16 : 0 }}>
          <dt>URL</dt>
          <dd>
            <a href={preview.url} target="_blank" rel="noreferrer">
              {preview.url}
            </a>
          </dd>
          <dt>Runs via</dt>
          <dd>{preview.kind === "docker" ? "Docker (repo's own Dockerfile)" : "host process"}</dd>
          {isRunning && (
            <>
              <dt>Expires in</dt>
              <dd>{timeUntil(preview.expiresAt)}</dd>
            </>
          )}
        </dl>
        {isRunning && (
          <div className="form-actions">
            <a href={preview.url} target="_blank" rel="noreferrer" className="button button-secondary">
              Open in new tab
            </a>
            <button type="button" className="button-ghost" disabled={stopping} onClick={handleStop}>
              {stopping ? "stopping…" : "Stop preview"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Phase 9 / module.md Module 4 (new_plan.md §9.7) — per-section
 *  refinement IS the review step. Scoped to exactly one slot: never
 *  touches the original frame file or any other section's rows. */
function RefineModal({
  runId,
  section,
  onClose,
  onRefined,
}: {
  runId: string;
  section: SectionSummary;
  onClose: () => void;
  onRefined: () => void;
}) {
  const [pendingAction, setPendingAction] = useState<RefineAction | null>(null);
  const [frameId, setFrameId] = useState(section.frameId ?? section.candidates[0]?.id ?? "");
  const [instructions, setInstructions] = useState("");
  const [newType, setNewType] = useState(SECTION_TYPES.find((t) => t !== section.type && t !== "hero") ?? "details");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: RefineAction) {
    setBusy(true);
    setError(null);
    try {
      const params =
        action === "use-different-frame"
          ? { frameId }
          : action === "new"
            ? { sectionType: newType, instructions: instructions.trim() || undefined }
            : { instructions: instructions.trim() || undefined };
      await refineSection(runId, section.slot, action, params);
      onRefined();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <h3>
            Refine <code>{section.type}</code>
          </h3>
          <button type="button" className="button-ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <div className="card-body">
          <p className="empty" style={{ marginTop: 0 }}>
            Slot <code>{section.slot}</code> — currently {section.mode}
            {section.frameId ? ` (${section.frameId})` : ""}. Every action here replaces only this section — the rest of
            the page is untouched — then re-verifies the whole assembled page before refreshing the preview.
          </p>
          {error && <div className="error">{error}</div>}

          {!pendingAction && (
            <div className="form-actions" style={{ flexWrap: "wrap" }}>
              {section.mode === "static" && section.candidates.length > 0 && (
                <button type="button" className="button-secondary" onClick={() => setPendingAction("use-different-frame")}>
                  Use a different frame
                </button>
              )}
              {section.mode === "static" && (
                <button type="button" className="button-secondary" onClick={() => setPendingAction("redesign")}>
                  Redesign with AI
                </button>
              )}
              {section.mode === "ai-required" && (
                <button type="button" className="button-secondary" onClick={() => setPendingAction("modify")}>
                  Modify with AI
                </button>
              )}
              <button type="button" className="button-secondary" onClick={() => setPendingAction("new")}>
                Change section type
              </button>
            </div>
          )}

          {pendingAction === "use-different-frame" && (
            <div className="form-section">
              <label>
                Frame
                <select value={frameId} onChange={(e) => setFrameId(e.target.value)}>
                  {section.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} — {c.description}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-actions">
                <button type="button" className="button" disabled={busy} onClick={() => submit("use-different-frame")}>
                  {busy ? "applying…" : "Apply"}
                </button>
                <button type="button" className="button-ghost" disabled={busy} onClick={() => setPendingAction(null)}>
                  Back
                </button>
              </div>
            </div>
          )}

          {(pendingAction === "modify" || pendingAction === "redesign") && (
            <div className="form-section">
              <label>
                Instructions <span className="optional">(what should change)</span>
                <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
              </label>
              <div className="form-actions">
                <button type="button" className="button" disabled={busy} onClick={() => submit(pendingAction)}>
                  {busy ? "generating…" : "Apply"}
                </button>
                <button type="button" className="button-ghost" disabled={busy} onClick={() => setPendingAction(null)}>
                  Back
                </button>
              </div>
            </div>
          )}

          {pendingAction === "new" && (
            <div className="form-section">
              <label>
                New section type
                <select value={newType} onChange={(e) => setNewType(e.target.value)}>
                  {SECTION_TYPES.filter((t) => t !== "hero").map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Instructions <span className="optional">(optional, only used if this type needs AI generation)</span>
                <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
              </label>
              <div className="form-actions">
                <button type="button" className="button" disabled={busy} onClick={() => submit("new")}>
                  {busy ? "applying…" : "Apply"}
                </button>
                <button type="button" className="button-ghost" disabled={busy} onClick={() => setPendingAction(null)}>
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The gallery — every section is a row you can open a scoped refine modal
 *  from. Only meaningful during review (status === "staged_for_review");
 *  the backend rejects a refine attempt outside that status anyway. */
function SectionsPanel({ runId, onRefined }: { runId: string; onRefined: () => void }) {
  const [sections, setSections] = useState<SectionSummary[] | null>(null);
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setSections(await getSections(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (error) return <div className="error">{error}</div>;
  if (!sections || sections.length === 0) return null;

  const openSection = sections.find((s) => s.slot === openSlot) ?? null;

  return (
    <div className="section-block card">
      <div className="card-header">
        <h3>Sections</h3>
      </div>
      <div className="card-body">
        <ul className="ref-file-list">
          {sections.map((s) => (
            <li key={s.slot}>
              <code>{s.type}</code> — {s.mode}
              {s.frameId ? ` (${s.frameId})` : ""}
              <button type="button" className="button-ghost" style={{ marginLeft: 12 }} onClick={() => setOpenSlot(s.slot)}>
                Refine
              </button>
            </li>
          ))}
        </ul>
      </div>
      {openSection && (
        <RefineModal
          runId={runId}
          section={openSection}
          onClose={() => setOpenSlot(null)}
          onRefined={() => {
            load();
            onRefined();
          }}
        />
      )}
    </div>
  );
}

/** Phase 7 — the human approval gate. Only rendered while
 *  status === "staged_for_review"; nothing this service generates reaches
 *  git before Approve is clicked. */
function ReviewPanel({ runId, onDecided, verifyBypassed }: { runId: string; onDecided: () => void; verifyBypassed?: boolean }) {
  const [busy, setBusy] = useState<"approve" | "abandon" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleApprove() {
    if (!confirm("Approve this campaign? This commits the staged files, pushes a branch, and opens a pull request.")) return;
    setBusy("approve");
    setActionError(null);
    try {
      await approveCampaign(runId);
      onDecided();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleAbandon() {
    if (!confirm("Abandon this campaign? Nothing gets committed or pushed — this just ends the run.")) return;
    setBusy("abandon");
    setActionError(null);
    try {
      await abandonCampaign(runId);
      onDecided();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="section-block card">
      <div className="card-header">
        <h3>Review</h3>
        <span className="status-pill status-warn">awaiting your decision</span>
      </div>
      <div className="card-body">
        {verifyBypassed ? (
          <div className="danger-banner">
            <strong>This page does NOT build.</strong> Verification failed on every attempt and the draft was staged
            anyway because <code>CONTINUE_ON_VERIFY_FAILURE</code> is on. Approving it will open a pull request
            containing code that does not compile. Read the build errors in the log below first.
          </div>
        ) : (
          <p style={{ marginTop: 0 }}>
            Verification passed and a preview is staged above. Nothing has been committed or pushed yet — approve to open a
            pull request, or abandon to end this run without touching git.
          </p>
        )}
        {actionError && (
          <div className="error" style={{ marginBottom: 16 }}>
            {actionError}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="button" disabled={busy !== null} onClick={handleApprove}>
            {busy === "approve" ? "approving…" : "Approve & open PR"}
          </button>
          <button type="button" className="button-ghost" disabled={busy !== null} onClick={handleAbandon}>
            {busy === "abandon" ? "abandoning…" : "Abandon"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckBadge({ label, value }: { label: string; value: boolean | null }) {
  const cls = value === null ? "badge-skipped" : value ? "badge-pass" : "badge-fail";
  const text = value === null ? "skipped" : value ? "pass" : "fail";
  return (
    <span className={`check-badge ${cls}`}>
      {label}: {text}
    </span>
  );
}

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [log, setLog] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const [runData, logData, draftData, previewData] = await Promise.all([
          getRun(runId!),
          getRunLog(runId!),
          getRunDraft(runId!),
          getPreview(runId!),
        ]);
        if (cancelled) return;
        setRun(runData);
        setLog(logData);
        setDraft(draftData);
        setPreview(previewData);
        // A preview can still be alive well after the run itself finishes
        // (that's the point) — keep polling until both the run AND any
        // preview are done, not just the run.
        const runActive = !TERMINAL.has(runData.status);
        const previewActive = previewData?.status === "running";
        if (runActive || previewActive) {
          timer = setTimeout(poll, 2000);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId]);

  async function refetchRun() {
    if (!runId) return;
    try {
      setRun(await getRun(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // A refine action re-stages the draft and restarts the preview — refresh
  // everything that could have changed, not just the run status, so the
  // reviewer sees the new content immediately instead of waiting for the
  // next 2s poll tick.
  async function refetchAfterRefine() {
    if (!runId) return;
    try {
      const [runData, draftData, previewData] = await Promise.all([getRun(runId), getRunDraft(runId), getPreview(runId)]);
      setRun(runData);
      setDraft(draftData);
      setPreview(previewData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!run) return <p className="empty">Loading…</p>;

  const isTerminal = TERMINAL.has(run.status);

  async function handleDelete() {
    if (!confirm("Delete this campaign? This only removes this service's local record — any branch/PR already pushed to GitHub is untouched.")) {
      return;
    }
    setDeleting(true);
    try {
      await deleteCampaign(run!.runId);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  return (
    <div>
      <p style={{ marginBottom: 16 }}>
        <Link to="/">&larr; Campaigns</Link>
      </p>

      <div className="card run-header-card">
        <div className="run-title-row">
          <div>
            <h2>{run.campaignName ?? run.slug}</h2>
            <span className="run-slug">
              <code>{run.slug}</code>
            </span>
          </div>
          {isTerminal && (
            <button type="button" className="danger-link" disabled={deleting} onClick={handleDelete}>
              {deleting ? "deleting…" : "Delete campaign"}
            </button>
          )}
        </div>

        <div className="run-meta">
          <span className={`status-pill ${STATUS_CLASS[run.status] ?? "status-live"}`}>{statusLabel(run.status)}</span>
          {!isTerminal && <span className="live-indicator">updating…</span>}
        </div>

        <Stepper run={run} />
      </div>

      {run.status === "completed" && (
        <div className="pr-banner">
          {run.prUrl ? (
            <p>
              PR opened:{" "}
              <a href={run.prUrl} target="_blank" rel="noreferrer">
                {run.prUrl}
              </a>
            </p>
          ) : (
            <p>
              Dry run completed — branch <code>{run.branchName}</code> was pushed locally (no real PR opened,{" "}
              <code>DRY_RUN_NO_PR=true</code>).
            </p>
          )}
        </div>
      )}
      {run.error && (
        <div className="error">
          <strong>Error:</strong> {run.error}
        </div>
      )}

      {run.verifyChecks && (
        <div className="section-block">
          <h3>Verify {run.verifyAttempts ? `— attempt ${run.verifyAttempts}` : ""}</h3>
          <div className="check-badges">
            <CheckBadge label="Build/lint" value={run.verifyChecks.build} />
            <CheckBadge label="Hero fit" value={run.verifyChecks.hero} />
            <CheckBadge label="SEO" value={run.verifyChecks.seo} />
            <CheckBadge label="Accessibility" value={run.verifyChecks.a11y} />
          </div>
        </div>
      )}

      {run.guide && (
        <div className="section-block card">
          <div className="card-header">
            <h3>Plan</h3>
          </div>
          <div className="card-body">
            <dl className="plan-meta">
              <dt>Hero title</dt>
              <dd>{run.guide.heroTitle}</dd>
              <dt>Hero video</dt>
              <dd>{run.guide.heroHasVideo ? "yes — video embed" : "no — details summary instead"}</dd>
              <dt>SEO title</dt>
              <dd>{run.guide.seoTitle}</dd>
              <dt>Meta description</dt>
              <dd>{run.guide.seoMetaDescription}</dd>
            </dl>
            <table className="section-table">
              <thead>
                <tr>
                  <th>Section</th>
                  <th>Summary</th>
                  <th>Reference files</th>
                </tr>
              </thead>
              <tbody>
                {run.guide.sections.map((section) => {
                  const ref = run.sectionReferences?.find((r) => r.sectionType === section.type);
                  return (
                    <tr key={section.type}>
                      <td>
                        <code>{section.type}</code>
                      </td>
                      <td>{section.summary}</td>
                      <td>
                        {ref ? (
                          <ul className="ref-file-list">
                            {ref.files.map((f) => (
                              <li key={f.path} className={f.found ? "ref-found" : "ref-missing"}>
                                {f.found ? "✓" : "✗"} <code>{f.path}</code>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="empty">(not yet resolved)</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview && (
        <PreviewPanel
          runId={run.runId}
          preview={preview}
          onStopped={() => setPreview((p) => (p ? { ...p, status: "stopped" } : p))}
        />
      )}

      {run.status === "staged_for_review" && <SectionsPanel runId={run.runId} onRefined={refetchAfterRefine} />}

      {run.status === "staged_for_review" && <ReviewPanel runId={run.runId} onDecided={refetchRun} verifyBypassed={run.verifyBypassed} />}

      {draft && (
        <div className="section-block card">
          <div className="card-header">
            <h3>Files</h3>
            <span className="empty">version {draft.version}</span>
          </div>
          <div className="card-body">
            <ul className="ref-file-list">
              {draft.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code> <span className="empty">({f.content.length.toLocaleString()} chars)</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="section-block">
        <h3>Log</h3>
        <LogConsole raw={log} live={!TERMINAL.has(run.status) && run.status !== "staged_for_review"} />
      </div>
    </div>
  );
}
