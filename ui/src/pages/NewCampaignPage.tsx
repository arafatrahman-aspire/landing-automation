import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createCampaign } from "../api";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export default function NewCampaignPage() {
  const navigate = useNavigate();
  const [campaignName, setCampaignName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [offer, setOffer] = useState("");
  const [audience, setAudience] = useState("");
  const [cta, setCta] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [requiresJobField, setRequiresJobField] = useState(false);
  const [brief, setBrief] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onNameChange(value: string) {
    setCampaignName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { runId } = await createCampaign({
        slug,
        campaignName,
        offer,
        audience,
        cta,
        videoUrl: videoUrl.trim() || undefined,
        requiresJobField,
        brief,
      });
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>New campaign</h2>
          <p className="page-subtitle">
            Describe the offer — the pipeline researches, plans, writes, and verifies a self-contained landing page,
            then opens a pull request for you to review.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          <form className="brief-form" onSubmit={onSubmit}>
            {error && <p className="error">{error}</p>}

            <div className="form-section">
              <div className="form-row">
                <label>
                  Campaign name
                  <input
                    value={campaignName}
                    onChange={(e) => onNameChange(e.target.value)}
                    required
                    minLength={3}
                    maxLength={120}
                    placeholder="Spring Security Bootcamp"
                  />
                </label>
                <label>
                  Slug
                  <input
                    value={slug}
                    onChange={(e) => {
                      setSlug(e.target.value);
                      setSlugTouched(true);
                    }}
                    required
                    pattern="[a-z0-9-]+"
                    minLength={3}
                    maxLength={60}
                    placeholder="spring-security-bootcamp"
                  />
                </label>
              </div>

              <label>
                Offer
                <textarea
                  value={offer}
                  onChange={(e) => setOffer(e.target.value)}
                  required
                  minLength={5}
                  maxLength={500}
                  rows={2}
                  placeholder="What's being offered — the course, product, or event."
                />
              </label>
              <label>
                Audience
                <textarea
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  required
                  minLength={5}
                  maxLength={500}
                  rows={2}
                  placeholder="Who this page needs to convince."
                />
              </label>

              <div className="form-row">
                <label>
                  CTA
                  <input
                    value={cta}
                    onChange={(e) => setCta(e.target.value)}
                    required
                    minLength={2}
                    maxLength={60}
                    placeholder="Book a free demo"
                  />
                </label>
                <label>
                  Demo video URL <span className="optional">(optional)</span>
                  <input
                    type="url"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="https://..."
                  />
                </label>
              </div>

              <label>
                Brief notes <span className="optional">(anything else the copy should reflect)</span>
                <textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={4000} rows={4} />
              </label>

              <label className="checkbox-row">
                <input type="checkbox" checked={requiresJobField} onChange={(e) => setRequiresJobField(e.target.checked)} />
                Require a job title on the lead form <span className="optional">(on for B2B/professional courses, off for consumer campaigns)</span>
              </label>
            </div>

            <div className="form-actions">
              <button type="submit" disabled={submitting}>
                {submitting ? "Starting…" : "Generate landing page"}
              </button>
              <Link to="/" className="button button-ghost">
                Cancel
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
