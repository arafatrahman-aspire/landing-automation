import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listCampaigns, deleteCampaign, isTerminalStatus, type RunSummary } from "../api";

const STATUS_CLASS: Record<string, string> = {
  completed: "status-ok",
  failed: "status-bad",
  failed_clone: "status-bad",
  failed_verification: "status-bad",
  failed_push: "status-bad",
  failed_push_incomplete: "status-warn",
  abandoned: "status-warn",
};

const FAILED_STATUSES = new Set([
  "failed",
  "failed_clone",
  "failed_verification",
  "failed_push",
  "failed_push_incomplete",
]);

/* The stage column used to print the raw pipeline node name — "classify_sections",
 * "preview_build" — which is precise and means nothing to anyone who hasn't read
 * the graph. Same keys as RunDetailPage's STAGES, phrased for a glance. */
const STAGE_LABEL: Record<string, string> = {
  intake: "Reading the brief",
  research: "Researching",
  clone: "Cloning the repo",
  guide: "Planning the page",
  classify_sections: "Choosing designs",
  generate_sections: "Writing sections",
  verify: "Building & checking",
  stage_draft: "Staging for review",
  preview_build: "Starting preview",
  committing: "Committing",
  pushing: "Pushing",
  opening_pr: "Opening the PR",
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export default function CampaignListPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await listCampaigns();
        if (!cancelled) setRuns(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    load();
    const id = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function handleDelete(run: RunSummary) {
    if (!confirm(`Delete "${run.campaignName ?? run.slug}"? This only removes this service's local record — any branch/PR already pushed to GitHub is untouched.`)) {
      return;
    }
    setDeletingId(run.runId);
    setError(null);
    try {
      await deleteCampaign(run.runId);
      setRuns((prev) => prev?.filter((r) => r.runId !== run.runId) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  if (!runs) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h2>Campaigns</h2>
            <p className="page-subtitle">AI-generated landing pages, delivered as reviewed pull requests.</p>
          </div>
        </div>
        <p className="empty">Loading…</p>
      </div>
    );
  }

  const running = runs.filter((r) => !isTerminalStatus(r.status)).length;
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed = runs.filter((r) => FAILED_STATUSES.has(r.status)).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Campaigns</h2>
          <p className="page-subtitle">AI-generated landing pages, delivered as reviewed pull requests.</p>
        </div>
        <Link to="/new" className="button">
          + New campaign
        </Link>
      </div>

      {error && <p className="error">{error}</p>}

      {runs.length > 0 && (
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-value">{runs.length}</div>
            <div className="stat-label">Total</div>
          </div>
          <div className="stat-card stat-live">
            <div className="stat-value">{running}</div>
            <div className="stat-label">Running</div>
          </div>
          <div className="stat-card stat-ok">
            <div className="stat-value">{completed}</div>
            <div className="stat-label">Completed</div>
          </div>
          <div className="stat-card stat-bad">
            <div className="stat-value">{failed}</div>
            <div className="stat-label">Failed</div>
          </div>
        </div>
      )}

      {runs.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3.5" y="6" width="17" height="14" rx="2" />
              <path d="M3.5 9.5h17" />
              <path d="M8 3.5v3M16 3.5v3" strokeLinecap="round" />
            </svg>
          </div>
          <p>No campaigns yet — create one to watch the pipeline run end to end.</p>
          <Link to="/new" className="button">
            + New campaign
          </Link>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="run-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId}>
                  <td>
                    <Link to={`/runs/${r.runId}`} className="run-name">
                      {r.campaignName ?? r.slug}
                    </Link>
                  </td>
                  <td>
                    <code>{r.slug}</code>
                  </td>
                  <td>
                    <span className={`status-pill ${STATUS_CLASS[r.status] ?? "status-live"}`}>
                      {statusLabel(r.status)}
                    </span>
                  </td>
                  <td className="empty" title={r.stage ?? ""}>
                    {r.stage ? (STAGE_LABEL[r.stage] ?? r.stage) : "—"}
                  </td>
                  <td className="empty" title={new Date(r.createdAt).toLocaleString()}>
                    {relativeTime(r.createdAt)}
                  </td>
                  <td>
                    <div className="row-actions">
                      {/* Running variations of the same campaign is the normal
                          case, so duplicating is offered on every row, not just
                          finished ones. */}
                      <Link to={`/new?duplicateOf=${r.runId}`} className="button-ghost row-action">
                        duplicate
                      </Link>
                      {isTerminalStatus(r.status) ? (
                        <button
                          type="button"
                          className="danger-link"
                          disabled={deletingId === r.runId}
                          onClick={() => handleDelete(r)}
                        >
                          {deletingId === r.runId ? "deleting…" : "delete"}
                        </button>
                      ) : (
                        <span className="live-indicator">running</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
