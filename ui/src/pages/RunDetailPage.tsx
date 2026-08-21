import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  getRun,
  getRunLog,
  getRunDraft,
  getPreview,
  stopPreview,
  startPreview,
  deleteCampaign,
  approveCampaign,
  abandonCampaign,
  getSections,
  refineSection,
  refinePage,
  recolorCampaign,
  getPlan,
  savePlan,
  approvePlan,
  abandonPlan,
  uploadCampaignImage,
  type RunSummary,
  type Draft,
  type DraftFile,
  type Preview,
  type SectionSummary,
  type RefineAction,
  type CopyField,
  type CopyValues,
  type GuidePlan,
  type Plan,
  type ResearchNotes,
  type CampaignBrief,
  type ColorScheme,
  type CampaignImage,
} from "../api";

// Must stay in sync with src/design-catalog/section-types.mjs's SECTION_TYPES — duplicated
// here since the UI can't import a backend .mjs module directly.
const SECTION_TYPES = ["hero", "details", "timeline", "testimonials", "faq", "curriculum", "pricing", "instructor", "footer-cta"];

/** Marketing-facing names — keep in sync with NewCampaignPage SECTIONS labels. */
const SECTION_META: Record<string, { label: string; blurb: string; icon: string }> = {
  hero: { label: "Hero", blurb: "Top of the page — headline and sign-up", icon: "✦" },
  details: { label: "What's included", blurb: "Benefits and concrete details", icon: "▣" },
  timeline: { label: "How it works", blurb: "Step-by-step walkthrough", icon: "→" },
  curriculum: { label: "Curriculum", blurb: "Syllabus or module breakdown", icon: "☰" },
  instructor: { label: "Instructors", blurb: "Who teaches or delivers it", icon: "☺" },
  testimonials: { label: "Testimonials", blurb: "Quotes from past customers", icon: "❝" },
  pricing: { label: "Pricing", blurb: "Packages and costs", icon: "$" },
  faq: { label: "FAQ", blurb: "Common questions, answered", icon: "?" },
  "footer-cta": { label: "Closing call to action", blurb: "Final push at the bottom", icon: "◎" },
};

function sectionLabel(type: string) {
  return SECTION_META[type]?.label ?? type;
}

function sectionIcon(type: string) {
  return SECTION_META[type]?.icon ?? "•";
}

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
  awaiting_plan_approval: "status-warn",
};

// Character limits for SERP-facing fields (src/schemas/content-guide-schema.mjs).
// Section summaries have no cap — they are creative briefs, not SEO fields.
// SEO fields are truncated server-side rather than rejected — better to see
// the ceiling than to have your last words vanish.
const PLAN_LIMITS = { heroTitle: 80, seoTitle: 70, seoMetaDescription: 200 };

/* Each pipeline stage gets a plain-English sentence, not just its internal
 * name. The stepper used to show bare keys like "classify_sections" and
 * "stage_draft", which say nothing to anyone who hasn't read the pipeline
 * source — the label is what you scan, the description is what tells you
 * what the service is actually doing to your campaign right now. */
const STAGES: { key: string; label: string; description: string }[] = [
  { key: "intake", label: "Intake", description: "Validating your brief and reserving a run." },
  { key: "research", label: "Research", description: "Gathering context about the offer and audience." },
  { key: "clone", label: "Clone", description: "Checking out the target repository into a private workspace." },
  { key: "guide", label: "Plan", description: "Deciding the page's sections, hero copy and SEO tags." },
  { key: "awaiting_plan_approval", label: "Your review", description: "Waiting for you to check the plan before anything gets written." },
  { key: "classify_sections", label: "Classify", description: "Choosing which sections reuse an existing design and which need AI." },
  { key: "generate_sections", label: "Generate", description: "Writing the actual section components, one at a time." },
  { key: "verify", label: "Verify", description: "Installing, building and linting the repo with the new page in it." },
  { key: "stage_draft", label: "Stage", description: "Saving the finished files so you can review them." },
  { key: "preview_build", label: "Preview", description: "Starting a live server so you can see the page." },
  { key: "committing", label: "Commit", description: "Committing the approved files to a new branch." },
  { key: "pushing", label: "Push", description: "Pushing that branch to GitHub." },
  { key: "opening_pr", label: "Open PR", description: "Opening the pull request for a human to merge." },
];

/* What each status means in one sentence, for the banner under the header.
 * Anything not listed falls back to "still working" — mid-pipeline statuses
 * are transient enough that the stage description carries the meaning. */
const STATUS_EXPLANATION: Record<string, string> = {
  awaiting_plan_approval:
    "The AI has planned the page and is waiting for you. Nothing has been written yet — changes made here are free, changes made after generation are not.",
  staged_for_review: "The page is built and waiting for your decision. Nothing has been committed or pushed yet.",
  completed: "Approved and delivered — the pull request is open.",
  abandoned: "You ended this run. Nothing was committed or pushed.",
  failed: "The run stopped before producing a page. The log below has the reason.",
  failed_clone: "Couldn't check out the target repository. Usually a credentials or branch problem.",
  failed_verification: "The page was generated but the repository would not build with it.",
  failed_push: "The files were committed but the push to GitHub failed.",
  failed_push_incomplete: "The push partially succeeded — check GitHub before re-running.",
};

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
  const [errorsOnly, setErrorsOnly] = useState(false);
  const all = parseLog(raw);
  const lines = errorsOnly ? all.filter((l) => severityOf(l) === "err" || severityOf(l) === "warn") : all;
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
  }, [raw, errorsOnly]);

  const problemCount = all.filter((l) => severityOf(l) === "err" || severityOf(l) === "warn").length;

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
        {problemCount > 0 && (
          <button type="button" className="console-filter" onClick={() => setErrorsOnly((v) => !v)}>
            {errorsOnly ? "show everything" : `problems only (${problemCount})`}
          </button>
        )}
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
          <li key={s.key} className={`stepper-step ${cls}`} title={s.description}>
            <span className="stepper-dot">{cls === "done" ? "✓" : cls === "failed" ? "!" : ""}</span>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

/* How long ago something happened, in words.
 *
 * This exists because of a real round trip that cost an afternoon: a run's
 * stored `error` was rendered with no date at all, so a two-day-old failure
 * from a bug that had since been fixed read exactly like something that had
 * just happened. A stored error is a historical record; it has to look like one. */
function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h ${mins % 60}m`;
}

/* ---------------- The generated page, actually shown ---------------- */

const DEVICES = [
  { id: "desktop", label: "Desktop", width: null as number | null },
  { id: "tablet", label: "Tablet", width: 834 },
  { id: "phone", label: "Phone", width: 390 },
];

function PreviewEmptyState({
  runId,
  canRestart,
  isLive,
  onStarted,
}: {
  runId: string;
  canRestart: boolean;
  isLive: boolean;
  onStarted: (next: Preview) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      onStarted(await startPreview(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="card empty-state preview-restart-card">
      <p>
        {isLive
          ? "No preview yet — one starts automatically once the page has been generated and staged."
          : "No preview server is running for this campaign. Previews are started at the end of a run and expire after a while."}
      </p>
      {canRestart ? (
        <div className="preview-restart-actions">
          <button type="button" className="button" disabled={starting} onClick={handleStart}>
            {starting ? "Starting preview…" : "Show preview"}
          </button>
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Embeds the real running preview server in an iframe.
 *
 *  This can only work through `preview.embedUrl` — the proxy URL. The target
 *  repo sends `X-Frame-Options: DENY` on every route, so pointing the iframe
 *  at `preview.url` directly renders a permanently blank box with an error
 *  only visible in the browser console. See src/preview/frameable-proxy.mjs. */
function PagePreview({
  runId,
  preview,
  canRestart,
  onStopped,
  onRestarted,
}: {
  runId: string;
  preview: Preview;
  canRestart: boolean;
  onStopped: () => void;
  onRestarted: (next: Preview) => void;
}) {
  const [device, setDevice] = useState("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  async function handleStop() {
    setStopping(true);
    setRestartError(null);
    try {
      await stopPreview(runId);
      onStopped();
    } finally {
      setStopping(false);
    }
  }

  async function handleStart() {
    setStarting(true);
    setRestartError(null);
    try {
      onRestarted(await startPreview(runId));
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const isRunning = preview.status === "running";
  const width = DEVICES.find((d) => d.id === device)?.width ?? null;

  if (!isRunning) {
    return (
      <div className="card empty-state preview-restart-card">
        <p>
          The preview server for this run has stopped. Previews expire after a while to avoid leaving servers running —
          the generated code itself is still available under <strong>Generated code</strong>.
        </p>
        {canRestart ? (
          <div className="preview-restart-actions">
            <button type="button" className="button" disabled={starting} onClick={handleStart}>
              {starting ? "Starting preview…" : "Show preview"}
            </button>
            {restartError ? <p className="form-error">{restartError}</p> : null}
          </div>
        ) : (
          <p className="empty">Restart is only available while this draft is staged for review.</p>
        )}
      </div>
    );
  }

  return (
    <div className="preview-wrap">
      <div className="preview-toolbar">
        <div className="device-switch" role="group" aria-label="Preview width">
          {DEVICES.map((d) => (
            <button
              key={d.id}
              type="button"
              className={device === d.id ? "active" : ""}
              onClick={() => setDevice(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <span className="preview-url" title={preview.url}>
          {preview.url}
        </span>
        <div className="preview-actions">
          <button type="button" className="button-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Reload
          </button>
          <a href={preview.url} target="_blank" rel="noreferrer" className="button-ghost">
            Open in new tab
          </a>
          <button type="button" className="button-ghost" disabled={stopping} onClick={handleStop}>
            {stopping ? "stopping…" : "Stop"}
          </button>
        </div>
      </div>

      {preview.embedUrl ? (
        <div className="preview-stage">
          <div className="preview-device" style={width ? { width, maxWidth: "100%" } : undefined}>
            <iframe
              key={reloadKey}
              src={preview.embedUrl}
              title="Generated campaign landing page"
              className="preview-frame"
              // The previewed page is code an LLM just wrote, served from a
              // local port. Sandboxed so it can run its own scripts and submit
              // its lead form, but can't navigate this app away from itself.
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            />
          </div>
        </div>
      ) : (
        <div className="card empty-state">
          <p>
            This preview can't be embedded — it was started before the frameable proxy existed, or the proxy failed to
            bind a port. Open it in a new tab instead.
          </p>
          <a href={preview.url} target="_blank" rel="noreferrer" className="button">
            Open the page
          </a>
        </div>
      )}

      <p className="preview-footnote">
        Served by {preview.kind === "docker" ? "a container built from the repo's own Dockerfile" : "the repo's own dev server"} ·
        expires in {timeUntil(preview.expiresAt)}
      </p>
    </div>
  );
}

/* ---------------- The generated code, actually readable ---------------- */

// One pass, alternation-ordered so comments and strings claim their text
// before the keyword branch can. Purely cosmetic: a token this misreads is a
// word rendered in the wrong colour, never wrong content.
const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|from|export|default|const|let|var|function|return|if|else|async|await|type|interface|extends|class|new|null|undefined|true|false)\b/g;

function highlight(source: string) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of source.matchAll(TOKEN_RE)) {
    const start = m.index!;
    if (start > last) out.push(source.slice(last, start));
    const cls = m[1] ? "tok-comment" : m[2] ? "tok-string" : "tok-keyword";
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>
    );
    last = start + m[0].length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

function fileName(p: string): string {
  return p.split("/").pop() ?? p;
}

/** The files panel used to be a list of paths and byte counts — which told you
 *  a page had been generated but not one thing about what was in it. This
 *  shows the actual source, since reading it is the entire point of a review
 *  gate that sits in front of a pull request. */
function CodeViewer({ files }: { files: DraftFile[] }) {
  const [activePath, setActivePath] = useState(files[0]?.path ?? "");
  const [copied, setCopied] = useState(false);

  // A refine run replaces files; if the selected one disappears, fall back to
  // the first rather than rendering an empty pane.
  const active = files.find((f) => f.path === activePath) ?? files[0];

  const lines = useMemo(() => (active ? active.content.split("\n") : []), [active]);

  async function copy() {
    if (!active) return;
    await navigator.clipboard.writeText(active.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!active) return <p className="empty">No files staged yet.</p>;

  return (
    <div className="code-viewer">
      <aside className="code-files">
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            className={f.path === active.path ? "active" : ""}
            onClick={() => setActivePath(f.path)}
            title={f.path}
          >
            <span className="code-file-name">{fileName(f.path)}</span>
            <span className="code-file-dir">{f.path}</span>
          </button>
        ))}
      </aside>
      <div className="code-pane">
        <div className="code-pane-bar">
          <code>{active.path}</code>
          <span className="empty">{lines.length} lines</span>
          <button type="button" className="button-ghost" onClick={copy}>
            {copied ? "copied ✓" : "Copy"}
          </button>
        </div>
        <pre className="code-body">
          <code>
            {lines.map((line, i) => (
              <span className="code-line" key={i}>
                <span className="code-lineno">{i + 1}</span>
                <span className="code-text">{highlight(line)}</span>
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}

/* ---------------- The plan gate ---------------- */

/** A labelled field with a live character budget. The server truncates rather
 *  than rejects, so the count is a warning, not a validation error. */
function CountedField({
  label,
  value,
  max,
  onChange,
  multiline = false,
  disabled = false,
}: {
  label: string;
  value: string;
  max: number;
  onChange: (next: string) => void;
  multiline?: boolean;
  disabled?: boolean;
}) {
  const over = value.length > max;
  return (
    <label className="counted-field">
      <span className="counted-field-head">
        {label}
        <span className={`counted-field-count ${over ? "over" : ""}`}>
          {value.length}/{max}
        </span>
      </span>
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} disabled={disabled} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      )}
      {over && <span className="field-note">Over the limit — this will be trimmed when saved.</span>}
    </label>
  );
}

/** Compact read-only panels that surface work the pipeline already did —
 *  research keywords, pain points, FAQs, and the submitted brief. Marketers
 *  should see this without digging through the activity log. */
function TagList({ items, empty }: { items?: string[] | null; empty?: string }) {
  if (!items || items.length === 0) {
    return empty ? <p className="empty insight-empty">{empty}</p> : null;
  }
  return (
    <ul className="insight-tags">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function BulletList({ items, empty }: { items?: string[] | null; empty?: string }) {
  if (!items || items.length === 0) {
    return empty ? <p className="empty insight-empty">{empty}</p> : null;
  }
  return (
    <ul className="insight-bullets">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

const IMAGE_SLOT_LABELS: Record<string, string> = {
  hero: "Hero section",
  details: "Details section",
  timeline: "Timeline section",
};

function AssignedPhotos({
  runId,
  images,
  onImageUploaded,
}: {
  runId: string;
  images: CampaignImage[];
  onImageUploaded: (slot: string, image: CampaignImage) => void;
}) {
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const SLOTS = ["hero", "details", "timeline"];

  async function handleFileChange(slot: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so same file can be re-selected after an error
    e.target.value = "";
    setUploadErrors((prev) => ({ ...prev, [slot]: "" }));
    setUploading((prev) => ({ ...prev, [slot]: true }));
    try {
      const result = await uploadCampaignImage(runId, slot, file);
      onImageUploaded(slot, result.image);
    } catch (err) {
      setUploadErrors((prev) => ({ ...prev, [slot]: err instanceof Error ? err.message : "Upload failed" }));
    } finally {
      setUploading((prev) => ({ ...prev, [slot]: false }));
    }
  }

  return (
    <ul className="research-photos">
      {SLOTS.map((slot) => {
        const img = images.find((i) => i.slot === slot);
        const isUploading = uploading[slot] ?? false;
        const error = uploadErrors[slot];
        return (
          <li key={slot} className="research-photo">
            {img ? (
              <img src={img.publicUrl} alt={img.alt || slot} />
            ) : (
              <div className="research-photo-placeholder">
                <span>{IMAGE_SLOT_LABELS[slot] ?? slot}</span>
                <span className="empty">No image assigned</span>
              </div>
            )}
            <span className="research-photo-meta">
              <strong>{IMAGE_SLOT_LABELS[slot] ?? slot}</strong>
              {img ? ` · ${img.source}` : ""}
            </span>
            {error ? <span className="research-photo-error">{error}</span> : null}
            <input
              ref={(el) => { fileInputRefs.current[slot] = el; }}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: "none" }}
              onChange={(e) => handleFileChange(slot, e)}
            />
            <button
              className="button button-secondary research-photo-upload-btn"
              disabled={isUploading}
              onClick={() => fileInputRefs.current[slot]?.click()}
            >
              {isUploading ? "Uploading\u2026" : img ? "Replace photo" : "Upload photo"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function hasResearchContent(notes: ResearchNotes | null | undefined): boolean {
  if (!notes) return false;
  return Boolean(
    (notes.keywords && notes.keywords.length) ||
      (notes.painPoints && notes.painPoints.length) ||
      (notes.faqQuestions && notes.faqQuestions.length) ||
      (notes.notes && notes.notes.trim()) ||
      (notes.images && notes.images.length)
  );
}

function ResearchInsightsCard({
  notes,
  runId,
  onImageUploaded,
}: {
  notes: ResearchNotes | null | undefined;
  runId?: string;
  onImageUploaded?: (slot: string, image: CampaignImage) => void;
}) {
  if (!hasResearchContent(notes)) {
    return (
      <div className="section-block card insight-card">
        <div className="card-header">
          <h3>Research insights</h3>
          <span className="empty">from the research step</span>
        </div>
        <div className="card-body">
          <p className="empty insight-empty">
            Research appears here after the Research step finishes (or immediately if research was skipped).
          </p>
          {runId && onImageUploaded ? (
            <div className="insight-block insight-block-wide" style={{ marginTop: 16 }}>
              <h4>Campaign photos</h4>
              <p className="insight-hint">
                Upload your own images for each section slot. They will be stored and applied to the draft instantly.
              </p>
              <AssignedPhotos runId={runId} images={[]} onImageUploaded={onImageUploaded} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="section-block card insight-card">
      <div className="card-header">
        <h3>Research insights</h3>
        <span className="empty">
          {[
            notes!.keywords?.length ? `${notes!.keywords.length} keywords` : null,
            notes!.painPoints?.length ? `${notes!.painPoints.length} pain points` : null,
            notes!.faqQuestions?.length ? `${notes!.faqQuestions.length} FAQs` : null,
            notes!.images?.length ? `${notes!.images.length} photos` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="card-body insight-grid">
        <div className="insight-block">
          <h4>SEO &amp; search keywords</h4>
          <p className="insight-hint">Use these in the search title, meta description, and section copy.</p>
          <TagList items={notes!.keywords} empty="No keywords returned." />
        </div>
        <div className="insight-block">
          <h4>Audience pain points</h4>
          <p className="insight-hint">Problems the page should acknowledge and answer.</p>
          <BulletList items={notes!.painPoints} empty="No pain points returned." />
        </div>
        <div className="insight-block">
          <h4>FAQ candidates</h4>
          <p className="insight-hint">Questions worth covering in an FAQ section.</p>
          <BulletList items={notes!.faqQuestions} empty="No FAQ candidates returned." />
        </div>
        {notes!.notes?.trim() ? (
          <div className="insight-block insight-block-wide">
            <h4>Research notes</h4>
            <p className="insight-notes">{notes!.notes}</p>
          </div>
        ) : null}
        {runId && onImageUploaded ? (
          <div className="insight-block insight-block-wide">
            <h4>Campaign photos</h4>
            <p className="insight-hint">
              Stock photos fetched for this campaign. Click "Replace photo" or "Upload photo" to swap any slot with your own image — it uploads to storage and updates the draft instantly.
            </p>
            <AssignedPhotos runId={runId} images={notes?.images ?? []} onImageUploaded={onImageUploaded} />
          </div>
        ) : notes?.images && notes.images.length > 0 ? (
          <div className="insight-block insight-block-wide">
            <h4>Assigned photos</h4>
            <p className="insight-hint">Stock photos searched for this campaign (Pexels, then Google Images).</p>
            <AssignedPhotos runId="" images={notes.images} onImageUploaded={() => {}} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BriefSummaryCard({ brief }: { brief: CampaignBrief | null | undefined }) {
  if (!brief) return null;

  const rows: { label: string; value: ReactNode }[] = [
    { label: "Offer", value: brief.offer },
    { label: "Audience", value: brief.audience },
    { label: "Call to action", value: brief.cta },
    { label: "Tone", value: brief.tone },
    { label: "Page length", value: brief.pageLength },
    { label: "Video", value: brief.videoUrl ? <a href={brief.videoUrl} target="_blank" rel="noreferrer">{brief.videoUrl}</a> : null },
    { label: "Reference page", value: brief.referenceUrl ? <a href={brief.referenceUrl} target="_blank" rel="noreferrer">{brief.referenceUrl}</a> : null },
    { label: "Job title on form", value: brief.requiresJobField ? "Required" : brief.requiresJobField === false ? "Not required" : null },
    {
      label: "Colors",
      value: brief.colorScheme?.preset === "custom"
        ? `Custom ${brief.colorScheme.primary} / ${brief.colorScheme.secondary} / ${brief.colorScheme.accent}`
        : brief.colorScheme?.preset === "aspire"
          ? "Aspire TSS"
          : null,
    },
  ].filter((r) => r.value != null && r.value !== "");

  return (
    <div className="section-block card insight-card">
      <div className="card-header">
        <h3>Campaign brief</h3>
        <span className="empty">what you submitted</span>
      </div>
      <div className="card-body">
        <dl className="plan-meta">
          {rows.map((row) => (
            <div className="plan-meta-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {brief.brief?.trim() ? (
          <div className="insight-block" style={{ marginTop: 12 }}>
            <h4>Extra notes</h4>
            <p className="insight-notes">{brief.brief}</p>
          </div>
        ) : null}
        {brief.brandNotes?.trim() ? (
          <div className="insight-block" style={{ marginTop: 12 }}>
            <h4>Brand / voice rules</h4>
            <p className="insight-notes">{brief.brandNotes}</p>
          </div>
        ) : null}
        {(brief.mustInclude?.length || brief.avoid?.length) ? (
          <div className="insight-split" style={{ marginTop: 12 }}>
            {brief.mustInclude?.length ? (
              <div className="insight-block">
                <h4>Must include</h4>
                <BulletList items={brief.mustInclude} />
              </div>
            ) : null}
            {brief.avoid?.length ? (
              <div className="insight-block">
                <h4>Avoid saying</h4>
                <BulletList items={brief.avoid} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The plan gate: edit the page's headline, SEO tags and section list BEFORE
 *  a single section is generated.
 *
 *  This is where a marketing user does their real work. Every change here is
 *  free — nothing has been written yet. The same change after generation means
 *  another AI run per section. */
function PlanEditor({
  runId,
  plan,
  researchNotes,
  brief,
  onChanged,
}: {
  runId: string;
  plan: Plan;
  researchNotes?: ResearchNotes | null;
  brief?: CampaignBrief | null;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<GuidePlan>(plan.guide);
  const [busy, setBusy] = useState<"save" | "approve" | "abandon" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [addType, setAddType] = useState(
    () => SECTION_TYPES.find((t) => t !== "hero" && !plan.guide.sections.some((s) => s.type === t)) ?? "details"
  );

  // Section types not already on the page, offered for "add a section". Hero
  // is excluded: exactly one always exists and the server enforces it.
  const available = SECTION_TYPES.filter((t) => t !== "hero" && !draft.sections.some((s) => s.type === t));

  function patch(next: Partial<GuidePlan>) {
    setDraft((d) => ({ ...d, ...next }));
    setSaved(false);
  }

  function patchSection(index: number, next: Partial<{ type: string; summary: string }>) {
    patch({ sections: draft.sections.map((s, i) => (i === index ? { ...s, ...next } : s)) });
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    // Index 0 is the hero and is pinned there — verify's hero-fit check
    // assumes the hero is the first thing on the page.
    if (target < 1 || target >= draft.sections.length || index < 1) return;
    const next = [...draft.sections];
    [next[index], next[target]] = [next[target], next[index]];
    patch({ sections: next });
  }

  async function run(action: "save" | "approve" | "abandon") {
    setBusy(action);
    setError(null);
    try {
      if (action === "save") {
        await savePlan(runId, draft);
        setSaved(true);
      } else if (action === "approve") {
        if (!confirm("Generate the page from this plan? This starts the AI writing each section and takes a few minutes.")) {
          setBusy(null);
          return;
        }
        await approvePlan(runId, draft);
      } else {
        if (!confirm("Discard this campaign? Nothing has been generated, committed or pushed.")) {
          setBusy(null);
          return;
        }
        await abandonPlan(runId);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const readOnly = !plan.editable;
  const topKeywords = researchNotes?.keywords?.slice(0, 8) ?? [];

  return (
    <div className="plan-editor">
      {readOnly ? (
        <p className="tab-hint">
          This plan has already been used to generate the page, so it can't be changed here. Use the section refine
          controls instead.
        </p>
      ) : (
        <div className="plan-intro">
          <div className="plan-intro-badge">Before we generate</div>
          <h3 className="plan-intro-title">Shape the page in plain language</h3>
          <p className="plan-intro-copy">
            Tweak the headline, pick which sections appear, and tell the AI what each one should say. Changes here are
            free — once you approve, writing the page takes time and credits. Research below is already baked into this
            draft — skim it before you approve.
          </p>
        </div>
      )}

      <BriefSummaryCard brief={brief} />
      <ResearchInsightsCard notes={researchNotes} runId={runId} onImageUploaded={onChanged} />

      <div className="section-block card plan-card">
        <div className="card-header">
          <h3>Headline &amp; search listing</h3>
          <span className="empty">What visitors and Google see first</span>
        </div>
        <div className="card-body">
          <CountedField
            label="Hero headline"
            value={draft.heroTitle}
            max={PLAN_LIMITS.heroTitle}
            onChange={(v) => patch({ heroTitle: v })}
            disabled={readOnly}
          />
          <CountedField
            label="Search result title"
            value={draft.seoTitle}
            max={PLAN_LIMITS.seoTitle}
            onChange={(v) => patch({ seoTitle: v })}
            disabled={readOnly}
          />
          <CountedField
            label="Search result description"
            value={draft.seoMetaDescription}
            max={PLAN_LIMITS.seoMetaDescription}
            onChange={(v) => patch({ seoMetaDescription: v })}
            multiline
            disabled={readOnly}
          />
          {topKeywords.length > 0 ? (
            <div className="seo-keyword-hint">
              <span className="seo-keyword-hint-label">Suggested keywords from research</span>
              <ul className="insight-tags is-compact">
                {topKeywords.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <label className="checkbox-row plan-video-toggle">
            <input
              type="checkbox"
              checked={draft.heroHasVideo}
              disabled={readOnly}
              onChange={(e) => patch({ heroHasVideo: e.target.checked })}
            />
            <span>
              <strong>Show a video in the hero</strong>
              <span className="optional"> Off shows a short what / when / who summary instead</span>
            </span>
          </label>
        </div>
      </div>

      <div className="section-block card plan-card">
        <div className="card-header">
          <h3>Page sections</h3>
          <span className="plan-count-pill">{draft.sections.length} blocks</span>
        </div>
        <div className="card-body">
          <p className="tab-hint" style={{ marginTop: 0 }}>
            Drag the order with the arrows. The summary under each block is the brief the AI writes from — be specific.
          </p>

          <ol className="plan-sections">
            {draft.sections.map((section, i) => {
              const meta = plan.sections.find((s) => s.type === section.type);
              const isHero = i === 0;
              const isAi = meta?.mode === "ai-required";
              const typeOptions = [section.type, ...available.filter((t) => t !== section.type)];
              return (
                <li
                  key={`${section.type}-${i}`}
                  className={`plan-section ${isHero ? "is-hero" : ""} ${isAi ? "is-ai-mode" : "is-layout-mode"}`}
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  <div className="plan-section-accent" aria-hidden="true">
                    <span className="plan-section-icon">{sectionIcon(section.type)}</span>
                  </div>
                  <div className="plan-section-body">
                    <div className="plan-section-head">
                      <span className="plan-section-index">{i + 1}</span>
                      <div className="plan-section-title-wrap">
                        {isHero ? (
                          <span className="plan-section-title">{sectionLabel(section.type)}</span>
                        ) : (
                          <select
                            className="plan-section-type"
                            value={section.type}
                            disabled={readOnly}
                            aria-label={`Section ${i + 1} type`}
                            onChange={(e) => patchSection(i, { type: e.target.value })}
                          >
                            {typeOptions.map((t) => (
                              <option key={t} value={t}>
                                {sectionLabel(t)}
                              </option>
                            ))}
                          </select>
                        )}
                        <span className="plan-section-blurb">
                          {isHero ? "Always first — headline and sign-up form" : SECTION_META[section.type]?.blurb ?? ""}
                        </span>
                      </div>
                      <span className={`mode-tag ${isAi ? "is-ai" : "is-layout"}`}>
                        {isAi ? "AI writes this" : "Ready-made layout"}
                      </span>
                      {!readOnly && !isHero && (
                        <div className="plan-section-actions">
                          <button
                            type="button"
                            className="plan-move"
                            title="Move up"
                            aria-label="Move section up"
                            disabled={i === 1}
                            onClick={() => move(i, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="plan-move"
                            title="Move down"
                            aria-label="Move section down"
                            disabled={i === draft.sections.length - 1}
                            onClick={() => move(i, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="plan-remove"
                            title="Remove section"
                            aria-label="Remove section"
                            onClick={() => patch({ sections: draft.sections.filter((_, j) => j !== i) })}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                      {isHero && <span className="plan-pinned">Pinned</span>}
                    </div>
                    <label className="plan-summary-label">
                      <span>What should this section cover?</span>
                      <textarea
                        className="plan-section-summary"
                        value={section.summary}
                        rows={4}
                        disabled={readOnly}
                        onChange={(e) => patchSection(i, { summary: e.target.value })}
                        placeholder={
                          isHero
                            ? "e.g. Promise the outcome in one line, then invite them to join."
                            : `e.g. For ${sectionLabel(section.type).toLowerCase()}: who it’s for, what they get, and why it matters.`
                        }
                      />
                      <span className="plan-summary-count">{section.summary.length} characters</span>
                    </label>
                  </div>
                </li>
              );
            })}
          </ol>

          {!readOnly && available.length > 0 && draft.sections.length < 9 && (
            <div className="plan-add">
              <div className="plan-add-copy">
                <strong>Add another section</strong>
                <span className="empty">Pick a type, then add it to the bottom of the page.</span>
              </div>
              <div className="plan-add-chips">
                {available.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`plan-add-chip ${addType === t ? "is-selected" : ""}`}
                    onClick={() => setAddType(t)}
                  >
                    <span className="plan-add-chip-icon">{sectionIcon(t)}</span>
                    {sectionLabel(t)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="button"
                onClick={() => {
                  const type = addType && available.includes(addType) ? addType : available[0];
                  patch({ sections: [...draft.sections, { type, summary: "" }] });
                  const remaining = available.filter((t) => t !== type);
                  setAddType(remaining[0] ?? type);
                }}
              >
                Add {sectionLabel(addType && available.includes(addType) ? addType : available[0])}
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!readOnly && (
        <div className="review-bar plan-review-bar">
          <div className="review-bar-text">
            <strong>Ready when you are.</strong> Approve to generate the full page from this plan. Editing after that is
            slower and costs another AI pass per change.
          </div>
          <div className="review-bar-actions">
            <button type="button" className="button" disabled={busy !== null} onClick={() => run("approve")}>
              {busy === "approve" ? "Starting…" : "Approve & generate page"}
            </button>
            <button type="button" className="button-secondary" disabled={busy !== null} onClick={() => run("save")}>
              {busy === "save" ? "Saving…" : saved ? "Saved ✓" : "Save draft"}
            </button>
            <button type="button" className="button-ghost" disabled={busy !== null} onClick={() => run("abandon")}>
              {busy === "abandon" ? "Discarding…" : "Discard"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Editing copy without an AI ---------------- */

/** A form generated from the layout's own schema. Editing a static section's
 *  words is a data change, not a code change — no LLM, no waiting, and nothing
 *  it can submit that the server would reject, because the form and the
 *  validation are built from the same schema.
 *
 *  This is the control a marketing user will reach for most: before it, fixing
 *  a typo meant asking an AI to rewrite the whole section. */
function CopyEditor({
  fields,
  values,
  onChange,
}: {
  fields: CopyField[];
  values: CopyValues;
  onChange: (next: CopyValues) => void;
}) {
  function set(key: string, value: CopyValues[string]) {
    onChange({ ...values, [key]: value });
  }

  return (
    <div className="copy-editor">
      {fields.map((field) => {
        if (field.kind === "unsupported") {
          return (
            <p key={field.key} className="field-note">
              <strong>{field.label}</strong> can't be edited here — use “Modify with AI” for this one.
            </p>
          );
        }

        if (field.kind === "text") {
          const value = typeof values[field.key] === "string" ? (values[field.key] as string) : "";
          const long = value.length > 80;
          return (
            <label key={field.key} className="counted-field">
              <span className="counted-field-head">{field.label}</span>
              {long ? (
                <textarea value={value} rows={3} onChange={(e) => set(field.key, e.target.value)} />
              ) : (
                <input value={value} onChange={(e) => set(field.key, e.target.value)} />
              )}
            </label>
          );
        }

        if (field.kind === "text-list") {
          const list = Array.isArray(values[field.key]) ? (values[field.key] as string[]) : [];
          return (
            <div key={field.key} className="counted-field">
              <span className="counted-field-head">{field.label}</span>
              {list.map((entry, i) => (
                <div key={i} className="repeat-row">
                  <input
                    value={entry}
                    onChange={(e) => set(field.key, list.map((v, j) => (j === i ? e.target.value : v)))}
                  />
                  <button
                    type="button"
                    className="danger-link"
                    // The schema requires at least one entry, so the last one
                    // can't be removed — the server would reject the save.
                    disabled={list.length <= 1}
                    onClick={() => set(field.key, list.filter((_, j) => j !== i))}
                  >
                    remove
                  </button>
                </div>
              ))}
              <button type="button" className="button-secondary" onClick={() => set(field.key, [...list, ""])}>
                Add {field.label.toLowerCase()}
              </button>
            </div>
          );
        }

        // group-list — a repeatable set of named text fields.
        const groups = Array.isArray(values[field.key]) ? (values[field.key] as Record<string, string>[]) : [];
        const blank = Object.fromEntries(field.fields.map((f) => [f.key, ""]));
        return (
          <div key={field.key} className="counted-field">
            <span className="counted-field-head">{field.label}</span>
            {groups.map((group, i) => (
              <div key={i} className="repeat-group">
                <div className="repeat-group-head">
                  <span className="plan-section-index">{i + 1}</span>
                  <button
                    type="button"
                    className="danger-link"
                    disabled={groups.length <= 1}
                    onClick={() => set(field.key, groups.filter((_, j) => j !== i))}
                  >
                    remove
                  </button>
                </div>
                {field.fields.map((member) => (
                  <label key={member.key} className="repeat-member">
                    <span>{member.label}</span>
                    <textarea
                      value={group[member.key] ?? ""}
                      rows={2}
                      onChange={(e) =>
                        set(
                          field.key,
                          groups.map((g, j) => (j === i ? { ...g, [member.key]: e.target.value } : g))
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            ))}
            <button type="button" className="button-secondary" onClick={() => set(field.key, [...groups, blank])}>
              Add {field.label.toLowerCase().replace(/s$/, "")}
            </button>
          </div>
        );
      })}
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
  const editableFields = section.fields?.filter((f) => f.kind !== "unsupported") ?? [];
  const canEditCopy = section.mode === "static" && editableFields.length > 0;
  const label = sectionLabel(section.type);

  const [pendingAction, setPendingAction] = useState<RefineAction | null>(canEditCopy ? "edit-copy" : null);
  const [copy, setCopy] = useState<CopyValues>(section.data ?? {});
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
        action === "edit-copy"
          ? { data: copy }
          : action === "use-different-frame"
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
      <div className="modal card refine-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <div>
            <h3>Edit “{label}”</h3>
            <p className="refine-modal-sub">{SECTION_META[section.type]?.blurb ?? "One section on this page"}</p>
          </div>
          <button type="button" className="button-ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <div className="card-body">
          {error && <div className="error">{error}</div>}

          {pendingAction === "edit-copy" && (
            <div className="form-section">
              <p className="tab-hint" style={{ marginTop: 0 }}>
                Change the wording only. Saves in a few seconds — no AI, and it won’t break the page layout.
              </p>
              <CopyEditor fields={section.fields ?? []} values={copy} onChange={setCopy} />
              <div className="form-actions">
                <button type="button" className="button" disabled={busy} onClick={() => submit("edit-copy")}>
                  {busy ? "Saving…" : "Save wording"}
                </button>
                <button type="button" className="button-ghost" disabled={busy} onClick={() => setPendingAction(null)}>
                  More options
                </button>
              </div>
            </div>
          )}

          {!pendingAction && (
            <div className="refine-action-grid">
              {canEditCopy && (
                <button type="button" className="refine-action-card" onClick={() => setPendingAction("edit-copy")}>
                  <strong>Edit the wording</strong>
                  <span>Quick text changes. No AI.</span>
                </button>
              )}
              <button
                type="button"
                className="refine-action-card refine-action-card-primary"
                onClick={() => setPendingAction(section.mode === "ai-required" ? "modify" : "redesign")}
              >
                <strong>Ask AI to rewrite this section</strong>
                <span>Describe what you want — AI updates only this block, then refreshes the preview.</span>
              </button>
              {section.mode === "static" && section.candidates.length > 1 && (
                <button type="button" className="refine-action-card" onClick={() => setPendingAction("use-different-frame")}>
                  <strong>Try a different layout</strong>
                  <span>Keep the topic; swap the visual design.</span>
                </button>
              )}
              <button type="button" className="refine-action-card" onClick={() => setPendingAction("new")}>
                <strong>Change section type</strong>
                <span>Turn this into a different kind of section (e.g. FAQ → testimonials).</span>
              </button>
            </div>
          )}

          {pendingAction === "use-different-frame" && (
            <div className="form-section">
              <label>
                Layout
                <select value={frameId} onChange={(e) => setFrameId(e.target.value)}>
                  {section.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.description}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-actions">
                <button type="button" className="button" disabled={busy} onClick={() => submit("use-different-frame")}>
                  {busy ? "Applying…" : "Use this layout"}
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
                What should change?
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={4}
                  placeholder={`e.g. “Make this FAQ about a weekend photography course for beginners”`}
                />
              </label>
              <p className="tab-hint">Takes a minute or two. The preview refreshes when it’s done.</p>
              <div className="form-actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy || instructions.trim().length < 3}
                  onClick={() => submit(pendingAction)}
                >
                  {busy ? "AI is rewriting…" : "Rewrite with AI"}
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
                      {sectionLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Extra notes <span className="optional">(optional)</span>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={3}
                  placeholder="Any guidance for the new section…"
                />
              </label>
              <div className="form-actions">
                <button type="button" className="button" disabled={busy} onClick={() => submit("new")}>
                  {busy ? "Updating…" : "Change section type"}
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

function PageAskPanel({ runId, onRefined }: { runId: string; onRefined: () => void }) {
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const result = await refinePage(runId, instructions.trim());
      const n = result.slots?.length ?? 0;
      setLastResult(
        n === 1 ? "Updated 1 section. Preview refreshed." : `Updated ${n} sections. Preview refreshed.`
      );
      setInstructions("");
      onRefined();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-ask card">
      <div className="card-header">
        <h3>Ask AI to change the page</h3>
      </div>
      <div className="card-body">
        <p className="tab-hint" style={{ marginTop: 0 }}>
          Describe what you want in plain language. AI rewrites the relevant sections, checks the page still builds, then
          refreshes the preview.
        </p>
        <label className="page-ask-label">
          Your request
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
            disabled={busy}
            placeholder='e.g. “Rewrite the FAQ and testimonials for a weekend photography course” or “Make the whole page warmer and less technical”'
          />
        </label>
        <div className="page-ask-examples">
          <span className="empty">Try:</span>
          {[
            "Make the FAQ about photography for beginners",
            "Rewrite testimonials to sound like happy photography students",
            "Soften the tone of the whole page",
          ].map((example) => (
            <button
              key={example}
              type="button"
              className="chip-button"
              disabled={busy}
              onClick={() => setInstructions(example)}
            >
              {example}
            </button>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
        {lastResult && !error && <div className="page-ask-success">{lastResult}</div>}
        <div className="form-actions">
          <button type="button" className="button" disabled={busy || instructions.trim().length < 3} onClick={submit}>
            {busy ? "AI is updating the page…" : "Update page with AI"}
          </button>
        </div>
        {busy && (
          <p className="tab-hint">This usually takes a few minutes. Keep this tab open — the preview will refresh when it’s done.</p>
        )}
      </div>
    </div>
  );
}

const ASPIRE_REVIEW_COLORS = { primary: "#125B80", secondary: "#004aad", accent: "#ea4b0c" };

function RecolorPanel({
  runId,
  current,
  onRefined,
}: {
  runId: string;
  current?: ColorScheme | null;
  onRefined: () => void;
}) {
  const [preset, setPreset] = useState<"aspire" | "custom">(current?.preset === "custom" ? "custom" : "aspire");
  const [primary, setPrimary] = useState(current?.primary ?? ASPIRE_REVIEW_COLORS.primary);
  const [secondary, setSecondary] = useState(current?.secondary ?? ASPIRE_REVIEW_COLORS.secondary);
  const [accent, setAccent] = useState(current?.accent ?? ASPIRE_REVIEW_COLORS.accent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const colorScheme: ColorScheme =
        preset === "custom"
          ? { preset: "custom", primary, secondary, accent }
          : { preset: "aspire" };
      await recolorCampaign(runId, colorScheme);
      setOk("Colors updated. Preview refreshed.");
      onRefined();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-ask card">
      <div className="card-header">
        <h3>Page colors</h3>
      </div>
      <div className="card-body">
        <p className="tab-hint" style={{ marginTop: 0 }}>
          Swaps the campaign palette in the generated files (no AI). Shared site frames keep Aspire colors unless this
          campaign already inlined them.
        </p>
        <div className="choice-grid">
          <button type="button" className={`choice-card ${preset === "aspire" ? "active" : ""}`} disabled={busy} onClick={() => setPreset("aspire")}>
            <strong>Aspire TSS</strong>
            <span>#125B80 · #004aad · #ea4b0c</span>
          </button>
          <button type="button" className={`choice-card ${preset === "custom" ? "active" : ""}`} disabled={busy} onClick={() => setPreset("custom")}>
            <strong>Custom</strong>
            <span>Pick three hex colors</span>
          </button>
        </div>
        {preset === "custom" && (
          <div className="form-row color-pickers">
            <label>
              Primary
              <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} disabled={busy} />
            </label>
            <label>
              Secondary
              <input type="color" value={secondary} onChange={(e) => setSecondary(e.target.value)} disabled={busy} />
            </label>
            <label>
              Accent
              <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} disabled={busy} />
            </label>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        {ok && !error && <div className="page-ask-success">{ok}</div>}
        <div className="form-actions">
          <button type="button" className="button" disabled={busy} onClick={submit}>
            {busy ? "Updating colors…" : "Apply colors"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Gallery of sections + page-level AI ask. Only meaningful during review. */
function SectionsPanel({
  runId,
  brief,
  onRefined,
}: {
  runId: string;
  brief?: CampaignBrief | null;
  onRefined: () => void;
}) {
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
    <div className="review-tools">
      <PageAskPanel
        runId={runId}
        onRefined={() => {
          load();
          onRefined();
        }}
      />
      <RecolorPanel
        runId={runId}
        current={brief?.colorScheme}
        onRefined={() => {
          load();
          onRefined();
        }}
      />
      <div className="section-block card">
        <div className="card-header">
          <h3>Or edit one section</h3>
          <span className="empty">{sections.length} on this page</span>
        </div>
        <div className="card-body">
          <p className="tab-hint" style={{ marginTop: 0 }}>
            Prefer a small change? Open one section — edit the words, ask AI to rewrite just that block, or swap its type.
          </p>
          <ul className="section-list">
            {sections.map((s, i) => (
              <li key={s.slot} className="section-row">
                <div className="section-row-main">
                  <span className="section-index">{i + 1}</span>
                  <div>
                    <strong>{sectionLabel(s.type)}</strong>
                    <div className="section-row-meta">
                      {s.mode === "static" ? "Reusable layout + campaign copy" : "Custom design written by AI"}
                    </div>
                  </div>
                </div>
                <button type="button" className="button-secondary" onClick={() => setOpenSlot(s.slot)}>
                  Edit
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
    </div>
  );
}

/** Phase 7 — the human approval gate. Only rendered while
 *  status === "staged_for_review"; nothing this service generates reaches
 *  git before Approve is clicked. */
function ReviewBar({ runId, onDecided, verifyBypassed }: { runId: string; onDecided: () => void; verifyBypassed?: boolean }) {
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
    <div className={`review-bar ${verifyBypassed ? "is-risky" : ""}`}>
      <div className="review-bar-text">
        {verifyBypassed ? (
          <>
            <strong>This page does not build.</strong> Verification failed on every attempt and the draft was staged
            anyway (<code>CONTINUE_ON_VERIFY_FAILURE</code>). Approving opens a pull request containing code that does
            not compile — read the log first.
          </>
        ) : (
          <>
            <strong>Ready for your decision.</strong> Preview the page, ask AI to change anything that looks off, then
            approve when you’re happy. Nothing is committed until you approve.
          </>
        )}
      </div>
      <div className="review-bar-actions">
        <button type="button" className="button" disabled={busy !== null} onClick={handleApprove}>
          {busy === "approve" ? "approving…" : "Approve & open PR"}
        </button>
        <button type="button" className="button-ghost" disabled={busy !== null} onClick={handleAbandon}>
          {busy === "abandon" ? "abandoning…" : "Abandon"}
        </button>
      </div>
      {actionError && <div className="error review-bar-error">{actionError}</div>}
    </div>
  );
}

const CHECK_HELP: Record<string, string> = {
  "Build & lint": "The whole repository compiles and passes its own lint rules with this page added.",
  "Hero fits": "The hero section and its call to action are visible without scrolling.",
  SEO: "The page has a title tag, a meta description and one h1.",
  Accessibility: "Images have alt text, form fields have labels, headings are in order.",
};

function CheckBadge({ label, value }: { label: string; value: boolean | null }) {
  const cls = value === null ? "badge-skipped" : value ? "badge-pass" : "badge-fail";
  const text = value === null ? "not run" : value ? "pass" : "fail";
  return (
    <span className={`check-badge ${cls}`} title={CHECK_HELP[label] ?? ""}>
      {label}: {text}
    </span>
  );
}

/* ---------------- Page ---------------- */

type TabId = "preview" | "code" | "plan" | "log";

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [log, setLog] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<TabId | null>(null);

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

        // The plan only exists from the guide stage onward, and 404s before
        // that — not an error, just "not yet". Refetched on every tick while
        // the run is live so the gate appears the moment it's reached.
        getPlan(runId!)
          .then((p) => !cancelled && setPlan(p))
          .catch(() => {});
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
  const atPlanGate = run.status === "awaiting_plan_approval";
  const isLive = !isTerminal && !atPlanGate && run.status !== "staged_for_review";
  const currentStage = STAGES.find((s) => s.key === run.stage);

  // The tab that matters depends on where the run is: the plan gate is a
  // decision the user is being asked for right now and outranks everything;
  // otherwise a finished page opens on the page itself, and a still-running
  // one on the log that's actually moving. An explicit click always wins.
  const activeTab: TabId =
    tab ?? (atPlanGate ? "plan" : preview?.status === "running" ? "preview" : draft ? "code" : "log");

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

  const tabs: { id: TabId; label: string; badge?: string }[] = [
    { id: "preview", label: "Page preview", badge: preview?.status === "running" ? "live" : undefined },
    { id: "code", label: "Generated code", badge: draft ? String(draft.files.length) : undefined },
    { id: "plan", label: atPlanGate ? "Plan" : "Plan & checks", badge: atPlanGate ? "your turn" : undefined },
    { id: "log", label: "Activity log" },
  ];

  return (
    <div className="run-page">
      <p className="back-link">
        <Link to="/">&larr; All campaigns</Link>
      </p>

      <div className="card run-header-card">
        <div className="run-title-row">
          <div>
            <h2>{run.campaignName ?? run.slug}</h2>
            <span className="run-slug">
              <code>{run.slug}</code>
            </span>
          </div>
          <div className="run-header-actions">
            <span className={`status-pill ${STATUS_CLASS[run.status] ?? "status-live"}`}>{statusLabel(run.status)}</span>
            {isTerminal && (
              <button type="button" className="danger-link" disabled={deleting} onClick={handleDelete}>
                {deleting ? "deleting…" : "Delete"}
              </button>
            )}
          </div>
        </div>

        <p className="run-explanation">
          {STATUS_EXPLANATION[run.status] ??
            (currentStage ? currentStage.description : "Working through the pipeline — watch the activity log for detail.")}
          {isLive && <span className="live-indicator">working</span>}
          {/* Age of the run, always visible. An old run's page looks identical
              to a live one otherwise, which is how a two-day-old stored error
              got mistaken for a fresh failure. */}
          <span className="run-age" title={new Date(run.createdAt).toLocaleString()}>
            started {timeAgo(run.createdAt)}
            {!isLive && run.updatedAt !== run.createdAt && ` · last changed ${timeAgo(run.updatedAt)}`}
          </span>
        </p>

        <Stepper run={run} />
      </div>

      {run.status === "staged_for_review" && (
        <ReviewBar runId={run.runId} onDecided={refetchRun} verifyBypassed={run.verifyBypassed} />
      )}

      {run.status === "completed" && (
        <div className="pr-banner">
          {run.prUrl ? (
            <p>
              Pull request opened:{" "}
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
          <div className="error-head">
            <strong>What went wrong</strong>
            {/* A finished run's error is a record of something that already
                happened, possibly long ago. Without the date it reads as live. */}
            <span className="error-when" title={new Date(run.updatedAt).toLocaleString()}>
              recorded {timeAgo(run.updatedAt)}
              {isTerminal && " · this run is finished, nothing is still failing"}
            </span>
          </div>
          {run.error}
        </div>
      )}

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={activeTab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge && <span className={`tab-badge ${t.badge === "live" ? "is-live" : ""}`}>{t.badge}</span>}
          </button>
        ))}
      </div>

      {activeTab === "preview" && (
        <div className="tab-panel">
          {preview ? (
            <PagePreview
              runId={run.runId}
              preview={preview}
              canRestart={run.status === "staged_for_review"}
              onStopped={() => setPreview((p) => (p ? { ...p, status: "stopped" } : p))}
              onRestarted={(next) => setPreview(next)}
            />
          ) : (
            <PreviewEmptyState
              runId={run.runId}
              canRestart={run.status === "staged_for_review" && Boolean(draft)}
              isLive={isLive}
              onStarted={(next) => setPreview(next)}
            />
          )}
        </div>
      )}

      {activeTab === "code" && (
        <div className="tab-panel">
          {draft ? (
            <>
              <p className="tab-hint">
                Every file this run wrote, version {draft.version}. These are staged only — nothing reaches the
                repository until you approve.
              </p>
              <CodeViewer files={draft.files} />
            </>
          ) : (
            <div className="card empty-state">
              <p>No files staged yet. They appear here as soon as the page has been generated and verified.</p>
            </div>
          )}
        </div>
      )}

      {activeTab === "plan" && (
        <div className="tab-panel">
          {/* At the gate the plan IS the page — an editable draft, not a
              record of what happened. Everything else on this tab describes a
              run that has already generated something, so it's withheld until
              there is something to describe. */}
          {plan && atPlanGate ? (
            <PlanEditor
              runId={run.runId}
              plan={plan}
              researchNotes={run.researchNotes}
              brief={run.request}
              onChanged={refetchRun}
            />
          ) : (
            <>
              <BriefSummaryCard brief={run.request} />
              <ResearchInsightsCard
                notes={run.researchNotes}
                runId={run.runId}
                onImageUploaded={() => refetchRun()}
              />

              {run.verifyChecks && (
                <div className="section-block card">
                  <div className="card-header">
                    <h3>Automated checks</h3>
                    <span className="empty">{run.verifyAttempts ? `attempt ${run.verifyAttempts}` : ""}</span>
                  </div>
                  <div className="card-body">
                    <p className="tab-hint">Run against the whole repository with the new page in it. Hover a badge for what it means.</p>
                    <div className="check-badges">
                      <CheckBadge label="Build & lint" value={run.verifyChecks.build} />
                      <CheckBadge label="Hero fits" value={run.verifyChecks.hero} />
                      <CheckBadge label="SEO" value={run.verifyChecks.seo} />
                      <CheckBadge label="Accessibility" value={run.verifyChecks.a11y} />
                    </div>
                  </div>
                </div>
              )}

              {run.status === "staged_for_review" && (
                <SectionsPanel runId={run.runId} brief={run.request} onRefined={refetchAfterRefine} />
              )}

              {run.guide ? (
                <div className="section-block card">
                  <div className="card-header">
                    <h3>What the AI planned</h3>
                  </div>
                  <div className="card-body">
                    <dl className="plan-meta">
                      <div className="plan-meta-row">
                        <dt>Hero headline</dt>
                        <dd>{run.guide.heroTitle}</dd>
                      </div>
                      <div className="plan-meta-row">
                        <dt>Hero media</dt>
                        <dd>{run.guide.heroHasVideo ? "video embed" : "no video — details summary instead"}</dd>
                      </div>
                      <div className="plan-meta-row">
                        <dt>SEO title</dt>
                        <dd>{run.guide.seoTitle}</dd>
                      </div>
                      <div className="plan-meta-row">
                        <dt>Meta description</dt>
                        <dd>{run.guide.seoMetaDescription}</dd>
                      </div>
                    </dl>
                    {run.researchNotes?.keywords?.length ? (
                      <div className="seo-keyword-hint" style={{ marginBottom: 16 }}>
                        <span className="seo-keyword-hint-label">Research keywords this plan drew on</span>
                        <ul className="insight-tags is-compact">
                          {run.researchNotes.keywords.slice(0, 12).map((k) => (
                            <li key={k}>{k}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <div className="table-wrap">
                      <table className="section-table">
                        <thead>
                          <tr>
                            <th>Section</th>
                            <th>What it says</th>
                            <th>Designs it copied from</th>
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
                </div>
              ) : (
                <div className="card empty-state">
                  <p>The plan appears here once the AI has decided what sections the page needs.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "log" && (
        <div className="tab-panel">
          <p className="tab-hint">Everything the pipeline did, newest at the bottom. This is the first place to look when a run fails.</p>
          <LogConsole raw={log} live={isLive} />
        </div>
      )}
    </div>
  );
}
