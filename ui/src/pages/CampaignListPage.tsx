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
};

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

  if (error) return <p className="error">{error}</p>;
  if (!runs) return <p>Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <h2>Campaigns</h2>
        <Link to="/new" className="button">+ New campaign</Link>
      </div>
      {runs.length === 0 ? (
        <p className="empty">No campaigns yet — create one to see the pipeline run.</p>
      ) : (
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
                  <Link to={`/runs/${r.runId}`}>{r.campaignName ?? r.slug}</Link>
                </td>
                <td>{r.slug}</td>
                <td>
                  <span className={`status-pill ${STATUS_CLASS[r.status] ?? "status-live"}`}>{r.status}</span>
                </td>
                <td>{r.stage ?? "—"}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>
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
                    <span className="empty">running…</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
