import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createCampaign, getCampaignBrief, type CampaignBrief, type PageLength, type Tone } from "../api";

// Must stay in sync with src/design-catalog/section-types.mjs's SECTION_TYPES —
// duplicated here since the UI can't import a backend .mjs module directly.
// The labels are the marketing-facing name for each; the enum values are what
// the API actually takes.
const SECTIONS: { type: string; label: string; blurb: string }[] = [
  { type: "hero", label: "Hero", blurb: "Headline, key promise and the sign-up form. Always included." },
  { type: "details", label: "What's included", blurb: "The concrete detail — what they get, how it works." },
  { type: "timeline", label: "How it works", blurb: "A step-by-step or week-by-week walkthrough." },
  { type: "curriculum", label: "Curriculum", blurb: "Syllabus or module breakdown, usually an accordion." },
  { type: "instructor", label: "Instructors", blurb: "Who teaches or delivers it." },
  { type: "testimonials", label: "Testimonials", blurb: "Quotes from past customers or attendees." },
  { type: "pricing", label: "Pricing", blurb: "Packages and what each one costs." },
  { type: "faq", label: "FAQ", blurb: "Common objections, answered." },
  { type: "footer-cta", label: "Closing call to action", blurb: "One last push at the bottom of the page." },
];

const TONES: { value: Tone; label: string; blurb: string }[] = [
  { value: "professional", label: "Professional", blurb: "Measured and credible. No slang." },
  { value: "friendly", label: "Friendly", blurb: "Warm and conversational." },
  { value: "urgent", label: "Urgent", blurb: "Direct, leads with what's at stake." },
  { value: "technical", label: "Technical", blurb: "Precise, assumes domain knowledge." },
  { value: "playful", label: "Playful", blurb: "Light and energetic." },
];

const LENGTHS: { value: PageLength; label: string; blurb: string }[] = [
  { value: "short", label: "Short", blurb: "2–3 sections" },
  { value: "standard", label: "Standard", blurb: "3–5 sections" },
  { value: "long", label: "Long", blurb: "5–7 sections" },
];

const STEPS = [
  { id: "campaign", label: "Campaign" },
  { id: "offer", label: "Offer & audience" },
  { id: "voice", label: "Voice & rules" },
  { id: "structure", label: "Page structure" },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/* ---------------- Reusable inputs ---------------- */

/** A list of short free-text rules, entered one at a time. Backs `mustInclude`
 *  and `avoid`, which are arrays in the schema precisely so each entry can be
 *  presented to the model as its own numbered requirement rather than getting
 *  lost inside a paragraph. */
function ChipListInput({
  value,
  onChange,
  placeholder,
  max = 10,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  max?: number;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const trimmed = draft.trim();
    if (!trimmed || value.length >= max || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setDraft("");
  }

  return (
    <div className="chip-input">
      {value.length > 0 && (
        <ul className="chip-list">
          {value.map((entry) => (
            <li key={entry}>
              <span>{entry}</span>
              <button type="button" onClick={() => onChange(value.filter((v) => v !== entry))} aria-label={`Remove ${entry}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length < max && (
        <div className="chip-add">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            maxLength={300}
            // Enter would otherwise submit the whole form from a nested input.
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="button-secondary" onClick={add} disabled={!draft.trim()}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function CardChoice<T extends string>({
  options,
  value,
  onChange,
  allowClear = true,
}: {
  options: { value: T; label: string; blurb: string }[];
  value: T | undefined;
  onChange: (next: T | undefined) => void;
  allowClear?: boolean;
}) {
  return (
    <div className="choice-grid">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`choice-card ${value === o.value ? "active" : ""}`}
          onClick={() => onChange(allowClear && value === o.value ? undefined : o.value)}
        >
          <strong>{o.label}</strong>
          <span>{o.blurb}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------- Page ---------------- */

export default function NewCampaignPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const duplicateOf = params.get("duplicateOf");

  const [step, setStep] = useState(0);
  const [campaignName, setCampaignName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [offer, setOffer] = useState("");
  const [audience, setAudience] = useState("");
  const [cta, setCta] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [brief, setBrief] = useState("");
  const [requiresJobField, setRequiresJobField] = useState(false);

  const [tone, setTone] = useState<Tone | undefined>();
  const [brandNotes, setBrandNotes] = useState("");
  const [mustInclude, setMustInclude] = useState<string[]>([]);
  const [avoid, setAvoid] = useState<string[]>([]);
  const [referenceUrl, setReferenceUrl] = useState("");

  const [sectionTypes, setSectionTypes] = useState<string[]>([]);
  const [aiRequiredSections, setAiRequiredSections] = useState<string[]>([]);
  const [pageLength, setPageLength] = useState<PageLength | undefined>();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefilling, setPrefilling] = useState(Boolean(duplicateOf));

  // Duplicating an existing campaign. The API deliberately withholds the old
  // slug (it must be unique per page), so that one field stays empty and the
  // name is left for the user to adjust.
  useEffect(() => {
    if (!duplicateOf) return;
    let cancelled = false;
    getCampaignBrief(duplicateOf)
      .then((b) => {
        if (cancelled) return;
        setCampaignName(b.campaignName ? `${b.campaignName} (copy)` : "");
        setOffer(b.offer ?? "");
        setAudience(b.audience ?? "");
        setCta(b.cta ?? "");
        setVideoUrl(b.videoUrl ?? "");
        setBrief(b.brief ?? "");
        setRequiresJobField(Boolean(b.requiresJobField));
        setTone(b.tone);
        setBrandNotes(b.brandNotes ?? "");
        setMustInclude(b.mustInclude ?? []);
        setAvoid(b.avoid ?? []);
        setReferenceUrl(b.referenceUrl ?? "");
        setSectionTypes(b.sectionTypes ?? []);
        setAiRequiredSections(b.aiRequiredSections ?? []);
        setPageLength(b.pageLength);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setPrefilling(false));
    return () => {
      cancelled = true;
    };
  }, [duplicateOf]);

  function onNameChange(value: string) {
    setCampaignName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  function toggle(list: string[], setList: (next: string[]) => void, type: string) {
    setList(list.includes(type) ? list.filter((t) => t !== type) : [...list, type]);
  }

  // Each step reports whether it is complete, which gates "Next" and lets the
  // step rail show progress. Only the first two steps have required fields.
  const stepValid = [
    campaignName.trim().length >= 3 && /^[a-z0-9-]+$/.test(slug) && slug.length >= 3,
    offer.trim().length >= 5 && audience.trim().length >= 5 && cta.trim().length >= 2,
    true,
    true,
  ];
  const canSubmit = stepValid[0] && stepValid[1];

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // Empty strings and empty arrays are omitted rather than sent: the schema
      // treats "absent" as "no rule", and an empty value would otherwise become
      // a meaningless line in the prompt.
      const payload: CampaignBrief = {
        slug,
        campaignName,
        offer,
        audience,
        cta,
        brief,
        requiresJobField,
        ...(videoUrl.trim() ? { videoUrl: videoUrl.trim() } : {}),
        ...(deadline ? { deadline } : {}),
        ...(tone ? { tone } : {}),
        ...(brandNotes.trim() ? { brandNotes: brandNotes.trim() } : {}),
        ...(mustInclude.length ? { mustInclude } : {}),
        ...(avoid.length ? { avoid } : {}),
        ...(referenceUrl.trim() ? { referenceUrl: referenceUrl.trim() } : {}),
        ...(sectionTypes.length ? { sectionTypes } : {}),
        ...(aiRequiredSections.length ? { aiRequiredSections } : {}),
        ...(pageLength ? { pageLength } : {}),
      };
      const { runId } = await createCampaign(payload);
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (prefilling) return <p className="empty">Loading the campaign you're copying…</p>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>{duplicateOf ? "Duplicate campaign" : "New campaign"}</h2>
          <p className="page-subtitle">
            Describe the offer and how it should sound. The pipeline researches, plans and writes the page, then shows it
            to you before anything is committed.
          </p>
        </div>
      </div>

      <div className="wizard">
        <ol className="wizard-rail">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className={`wizard-step ${i === step ? "active" : ""} ${stepValid[i] && i < step ? "done" : ""}`}
                // Forward jumps are blocked while an earlier required step is
                // incomplete; going back is always allowed.
                disabled={i > step && !stepValid.slice(0, i).every(Boolean)}
                onClick={() => setStep(i)}
              >
                <span className="wizard-num">{i + 1}</span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>

        <div className="card">
          <div className="card-body">
            <form className="brief-form" onSubmit={onSubmit}>
              {error && <p className="error">{error}</p>}

              {step === 0 && (
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
                        autoFocus
                      />
                    </label>
                    <label>
                      Slug <span className="optional">(the page's URL, and its folder in the repo)</span>
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
                    Deadline <span className="optional">(optional — recorded with the campaign, not enforced)</span>
                    <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                  </label>
                </div>
              )}

              {step === 1 && (
                <div className="form-section">
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
                      Call to action
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
                      <input type="url" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://..." />
                    </label>
                  </div>
                  <label>
                    Anything else the copy should reflect <span className="optional">(optional)</span>
                    <textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={4000} rows={4} />
                  </label>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={requiresJobField} onChange={(e) => setRequiresJobField(e.target.checked)} />
                    Ask for a job title on the sign-up form{" "}
                    <span className="optional">(on for B2B/professional campaigns, off for consumer)</span>
                  </label>
                </div>
              )}

              {step === 2 && (
                <div className="form-section">
                  <p className="tab-hint">
                    All optional — but anything you set here is treated as a hard rule that outranks the AI's own
                    judgement, which a note buried in the free-text box above is not.
                  </p>
                  <label>
                    Tone of voice
                    <CardChoice options={TONES} value={tone} onChange={setTone} />
                  </label>
                  <label>
                    Brand rules <span className="optional">(house style, naming, words you never use)</span>
                    <textarea
                      value={brandNotes}
                      onChange={(e) => setBrandNotes(e.target.value)}
                      maxLength={1000}
                      rows={3}
                      placeholder="Always write 'Aspire TSS' in full on first mention. Never describe the price as 'cheap'."
                    />
                  </label>
                  <label>
                    Must appear on the page <span className="optional">(claims, stats or offers you need mentioned)</span>
                    <ChipListInput value={mustInclude} onChange={setMustInclude} placeholder="90% job placement rate" />
                  </label>
                  <label>
                    Must not appear <span className="optional">(claims you can't legally or factually make)</span>
                    <ChipListInput value={avoid} onChange={setAvoid} placeholder="Guaranteed employment" />
                  </label>
                  <label>
                    Reference page <span className="optional">(optional — a page whose structure to echo)</span>
                    <input
                      type="url"
                      value={referenceUrl}
                      onChange={(e) => setReferenceUrl(e.target.value)}
                      placeholder="https://..."
                    />
                    <span className="field-note">
                      The page is not fetched or scraped — it's passed along as a reference the model may already know.
                    </span>
                  </label>
                </div>
              )}

              {step === 3 && (
                <div className="form-section">
                  <p className="tab-hint">
                    Leave everything here alone to let the plan decide. You'll get to review and change the section list
                    before any of the page is written.
                  </p>

                  <label>
                    Page length
                    <CardChoice options={LENGTHS} value={pageLength} onChange={setPageLength} />
                  </label>

                  <fieldset className="section-picker">
                    <legend>Sections to include</legend>
                    <p className="field-note">Nothing selected means the AI picks what suits the campaign.</p>
                    {SECTIONS.map((s) => {
                      const isHero = s.type === "hero";
                      const included = isHero || sectionTypes.includes(s.type);
                      return (
                        <div key={s.type} className={`section-picker-row ${included ? "included" : ""}`}>
                          <label className="checkbox-row">
                            <input
                              type="checkbox"
                              checked={included}
                              // Hero is always generated and always AI-built —
                              // the backend enforces both, so the UI shouldn't
                              // pretend otherwise.
                              disabled={isHero}
                              onChange={() => toggle(sectionTypes, setSectionTypes, s.type)}
                            />
                            <span>
                              <strong>{s.label}</strong>
                              <span className="field-note">{s.blurb}</span>
                            </span>
                          </label>
                          {included && !isHero && (
                            <label className="checkbox-row build-mode">
                              <input
                                type="checkbox"
                                checked={aiRequiredSections.includes(s.type)}
                                onChange={() => toggle(aiRequiredSections, setAiRequiredSections, s.type)}
                              />
                              Design this one from scratch with AI
                            </label>
                          )}
                        </div>
                      );
                    })}
                  </fieldset>

                  {aiRequiredSections.length > 0 && (
                    <p className="field-note">
                      {aiRequiredSections.length + 1} section{aiRequiredSections.length ? "s" : ""} will be written from
                      scratch by AI (the hero always is). Each one is a separate AI run — slower and more expensive than
                      reusing an existing layout, and more likely to need a retry.
                    </p>
                  )}
                </div>
              )}

              <div className="form-actions wizard-actions">
                {step > 0 && (
                  <button type="button" className="button-ghost" onClick={() => setStep(step - 1)}>
                    Back
                  </button>
                )}
                {step < STEPS.length - 1 ? (
                  <button type="button" className="button" disabled={!stepValid[step]} onClick={() => setStep(step + 1)}>
                    Next
                  </button>
                ) : (
                  <button type="submit" disabled={submitting || !canSubmit}>
                    {submitting ? "Starting…" : "Generate landing page"}
                  </button>
                )}
                {/* Everything after step 2 is optional, so let people skip ahead. */}
                {step >= 1 && step < STEPS.length - 1 && canSubmit && (
                  <button type="submit" className="button-ghost" disabled={submitting}>
                    {submitting ? "Starting…" : "Skip the rest and generate"}
                  </button>
                )}
                <Link to="/" className="button button-ghost">
                  Cancel
                </Link>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
