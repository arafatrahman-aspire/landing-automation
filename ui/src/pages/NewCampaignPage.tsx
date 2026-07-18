import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
      <h2>New campaign</h2>
      <form className="brief-form" onSubmit={onSubmit}>
        <label>
          Campaign name
          <input value={campaignName} onChange={(e) => onNameChange(e.target.value)} required minLength={3} maxLength={120} />
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
          />
        </label>
        <label>
          Offer
          <textarea value={offer} onChange={(e) => setOffer(e.target.value)} required minLength={5} maxLength={500} rows={2} />
        </label>
        <label>
          Audience
          <textarea value={audience} onChange={(e) => setAudience(e.target.value)} required minLength={5} maxLength={500} rows={2} />
        </label>
        <label>
          CTA
          <input value={cta} onChange={(e) => setCta(e.target.value)} required minLength={2} maxLength={60} placeholder="Book a free demo" />
        </label>
        <label>
          Demo video URL <span className="optional">(optional — shown in the hero if provided)</span>
          <input type="url" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://..." />
        </label>
        <label>
          Brief notes
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={4000} rows={4} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Starting…" : "Generate landing page"}
        </button>
      </form>
    </div>
  );
}
