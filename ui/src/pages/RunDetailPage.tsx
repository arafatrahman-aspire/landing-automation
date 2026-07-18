import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { getRun, getRunLog, deleteCampaign, type RunSummary } from "../api";

const TERMINAL = new Set([
  "completed",
  "failed",
  "failed_clone",
  "failed_verification",
  "failed_push",
  "failed_push_incomplete",
  "abandoned",
]);

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const [runData, logData] = await Promise.all([getRun(runId!), getRunLog(runId!)]);
        if (cancelled) return;
        setRun(runData);
        setLog(logData);
        if (!TERMINAL.has(runData.status)) {
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

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  if (error) return <p className="error">{error}</p>;
  if (!run) return <p>Loading…</p>;

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
      <div className="page-header">
        <Link to="/">&larr; Campaigns</Link>
        {isTerminal && (
          <button type="button" className="danger-link" disabled={deleting} onClick={handleDelete}>
            {deleting ? "deleting…" : "Delete campaign"}
          </button>
        )}
      </div>
      <h2>{run.campaignName ?? run.slug}</h2>
      <div className="run-meta">
        <div>
          <strong>Status:</strong> {run.status}
        </div>
        <div>
          <strong>Stage:</strong> {run.stage ?? "—"}
        </div>
        {!isTerminal && <div className="live-indicator">● updating…</div>}
      </div>

      {run.status === "completed" && (
        <div className="pr-banner">
          {run.prUrl ? (
            <p>
              PR opened: <a href={run.prUrl} target="_blank" rel="noreferrer">{run.prUrl}</a>
            </p>
          ) : (
            <p>
              Dry run completed — branch <code>{run.branchName}</code> was pushed locally (no real PR opened,
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
        <div className="verify-panel">
          <h3>Verify {run.verifyAttempts ? `(attempt ${run.verifyAttempts})` : ""}</h3>
          <div className="check-badges">
            <CheckBadge label="Build/lint" value={run.verifyChecks.build} />
            <CheckBadge label="Hero fit" value={run.verifyChecks.hero} />
            <CheckBadge label="SEO" value={run.verifyChecks.seo} />
            <CheckBadge label="Accessibility" value={run.verifyChecks.a11y} />
          </div>
        </div>
      )}

      {run.guide && (
        <div className="plan-panel">
          <h3>Plan</h3>
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
      )}

      <h3>Log</h3>
      <pre className="log-tail" ref={logRef}>
        {log || "(no log yet)"}
      </pre>
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
