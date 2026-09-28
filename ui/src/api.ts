// Browser traffic stays on this origin; the server proxy target comes from .env.
const BASE_URL = "/api";
let csrfToken = "";
export function setCsrfToken(value: string) { csrfToken = value; }
export function clearSession() {
  csrfToken = "";
  window.dispatchEvent(new Event("session-expired"));
}
const nativeFetch = window.fetch.bind(window);
async function sessionFetch(input: string, init: RequestInit = {}) {
  const response = await nativeFetch(input, { ...init, credentials: "same-origin" });
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent("session-check", { detail: response.status }));
  }
  return response;
}

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await sessionFetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      ...(options.headers ?? {}),
    },
  });

  if (res.status === 401) {
    clearSession();
    throw new ApiError("Session expired. Sign in through CMS again.", 401);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const detail = (body as { issues?: string; error?: string }).issues ?? (body as { error?: string }).error;
    throw new ApiError(detail ? String(detail) : `Request failed (${res.status})`, res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface GuidePlan {
  heroTitle: string;
  heroHasVideo: boolean;
  seoTitle: string;
  seoMetaDescription: string;
  sections: { type: string; summary: string }[];
}

/* The plan gate — the human step BEFORE generation. Editing here is free;
 * every change after generation costs another AI run. See
 * src/pipeline/approve-or-edit-plan.mjs. */

export interface PlanSection {
  type: string;
  summary: string;
  /** How this section would be built if approved as-is. */
  mode: "static" | "ai-required";
  candidates: { id: string; description: string }[];
}

export interface Plan {
  /** False once the run has moved past the gate — the plan stays readable,
   *  but saving would silently disagree with the page already generated. */
  editable: boolean;
  status: string;
  guide: GuidePlan;
  sections: PlanSection[];
}

export function getPlan(runId: string): Promise<Plan> {
  return request<Plan>(`/campaigns/${runId}/plan`);
}

export function savePlan(runId: string, guide: GuidePlan): Promise<{ ok: true; guide: GuidePlan }> {
  return request(`/campaigns/${runId}/plan`, { method: "PATCH", body: JSON.stringify(guide) });
}

/** Saves any final edit and starts generation in one call, so the two can't
 *  half-apply. */
export function approvePlan(runId: string, guide?: GuidePlan): Promise<{ ok: true; status: string }> {
  return request(`/campaigns/${runId}/plan/approve`, { method: "POST", body: JSON.stringify(guide ? { guide } : {}) });
}

export function abandonPlan(runId: string): Promise<{ ok: true; status: "abandoned" }> {
  return request(`/campaigns/${runId}/plan/abandon`, { method: "POST" });
}

export interface SectionReference {
  sectionType: string;
  note: string;
  files: { path: string; found: boolean }[];
}

export interface CampaignImage {
  slot: string;
  query: string;
  source: "pexels" | "serpapi" | string;
  publicUrl: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface ResearchNotes {
  keywords?: string[];
  painPoints?: string[];
  faqQuestions?: string[];
  notes?: string;
  images?: CampaignImage[];
  /** LLM-suggested visual search queries per image slot (hero/details/timeline). */
  imageQueries?: { hero?: string[]; details?: string[]; timeline?: string[] };
  /** LLM-suggested image-generation prompts per slot. */
  imagePrompts?: { hero?: string; details?: string; timeline?: string };
}

export interface RunSummary {
  runId: string;
  slug: string;
  campaignName: string | null;
  status: string;
  stage: string | null;
  createdAt: string;
  updatedAt: string;
  prUrl: string | null;
  branchName: string | null;
  error: string | null;
  guide?: GuidePlan | null;
  researchNotes?: ResearchNotes | null;
  request?: CampaignBrief | null;
  sectionReferences?: SectionReference[] | null;
  verifyChecks?: VerifyChecks | null;
  verifyAttempts?: number;
  currentDraftVersion?: number | null;
  /** True when the draft was staged despite a FAILING build
   *  (CONTINUE_ON_VERIFY_FAILURE) — the page is not known to compile. */
  verifyBypassed?: boolean;
}

export interface VerifyChecks {
  build: boolean;
  hero: boolean | null;
  seo: boolean | null;
  a11y: boolean | null;
}

export interface DraftFile {
  path: string;
  content: string;
}

export interface Draft {
  version: number;
  files: DraftFile[];
}

/** Returns null when a run has no staged draft yet — normal before
 *  `verify` first passes, not an error condition for the caller to surface. */
export async function getRunDraft(runId: string): Promise<Draft | null> {
  try {
    return await request<Draft>(`/campaigns/${runId}/draft`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export interface Preview {
  kind: "process" | "docker";
  port: number;
  /** Points straight at the preview server — use this for "open in a new tab". */
  url: string;
  status: string;
  expiresAt: string;
  /** Goes through the frameable proxy (src/preview/frameable-proxy.mjs), which
   *  strips the target repo's `X-Frame-Options: DENY`. This is the only URL an
   *  <iframe> can actually render; null on older rows, or if the proxy failed
   *  to start, in which case the UI degrades to a link. */
  embedUrl: string | null;
}

/** Returns null once a run has no active preview (404) — normal before
 *  `preview_build` runs, or after it's expired/stopped. */
export async function getPreview(runId: string): Promise<Preview | null> {
  try {
    return await request<Preview>(`/campaigns/${runId}/preview`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function stopPreview(runId: string): Promise<void> {
  await request<void>(`/campaigns/${runId}/preview/stop`, { method: "POST" });
}

/** Restart a preview after it expired or was stopped (staged drafts only). */
export async function startPreview(runId: string): Promise<Preview> {
  return request<Preview>(`/campaigns/${runId}/preview/start`, { method: "POST" });
}

export function listCampaigns(): Promise<RunSummary[]> {
  return request<RunSummary[]>("/campaigns");
}

export function getRun(runId: string): Promise<RunSummary> {
  return request<RunSummary>(`/campaigns/${runId}`);
}

export interface RunLogEntry {
  ts: string;
  level: string;
  message: string;
}

export interface RunEventHandlers {
  /** Fired once on connect with the full current run + log. */
  onInit?: (data: { run: RunSummary; log: string }) => void;
  /** Fired whenever the run record changes (status/stage/etc.). */
  onRun?: (run: RunSummary) => void;
  /** Fired once per new log line — append it, don't refetch the whole log. */
  onLog?: (entry: RunLogEntry) => void;
  /** Fired if the stream drops or fails to open; the caller decides how to recover. */
  onError?: (err: unknown) => void;
}

/**
 * Opens a real-time event stream for one run (GET /campaigns/:runId/events —
 * see src/state/run-events-sse.mjs) using `fetch` and a hand-rolled SSE
 * parser rather than the browser's native `EventSource`: EventSource can't
 * retain explicit stream lifecycle control. Authentication uses the same
 * HttpOnly session cookie as ordinary API requests.
 *
 * Returns a function that closes the stream. Safe to call multiple times.
 */
export function watchRunEvents(runId: string, handlers: RunEventHandlers): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await sessionFetch(`${BASE_URL}/campaigns/${runId}/events`, {
        headers: { "X-CSRF-Token": csrfToken },
        signal: controller.signal,
      });
      if (res.status === 401) {
        clearSession();
        throw new ApiError("Unauthorized", 401);
      }
      if (!res.ok || !res.body) {
        throw new ApiError(`Failed to open event stream (${res.status})`, res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            // Anything else (e.g. ": ping" heartbeat comments) is ignored.
          }
          if (dataLines.length === 0) continue;

          const data = JSON.parse(dataLines.join("\n"));
          if (eventName === "init") handlers.onInit?.(data);
          else if (eventName === "run") handlers.onRun?.(data);
          else if (eventName === "log") handlers.onLog?.(data);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return; // closed on purpose — not an error
      handlers.onError?.(err);
    }
  })();

  return () => controller.abort();
}

export async function getRunLog(runId: string): Promise<string> {
  const res = await sessionFetch(`${BASE_URL}/campaigns/${runId}/log`, {
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (res.status === 401) {
    clearSession();
    throw new ApiError("Unauthorized", 401);
  }
  if (!res.ok) throw new ApiError(`Failed to fetch log (${res.status})`, res.status);
  return res.text();
}

export type Tone = "professional" | "friendly" | "urgent" | "technical" | "playful";
export type PageLength = "short" | "standard" | "long";
export type ColorSchemePreset = "aspire" | "custom";

export interface ColorScheme {
  preset: ColorSchemePreset;
  primary?: string;
  secondary?: string;
  accent?: string;
}

/** Mirrors briefSchema in src/schemas/campaign-brief-schema.mjs. Everything
 *  past `videoUrl` is optional: a brief that sets none of it behaves exactly
 *  as briefs did before these existed. */
export interface CampaignBrief {
  slug: string;
  campaignName: string;
  offer: string;
  audience: string;
  cta: string;
  brief?: string;
  videoUrl?: string;
  deadline?: string;
  requiresJobField?: boolean;

  // Content rules — pure prompt input, no effect on the pipeline's shape.
  tone?: Tone;
  brandNotes?: string;
  mustInclude?: string[];
  avoid?: string[];
  referenceUrl?: string;

  // Structure. `sectionTypes` picks WHETHER a section exists;
  // `aiRequiredSections` picks HOW it gets built (bespoke AI vs. reusing an
  // existing layout). They are deliberately separate.
  sectionTypes?: string[];
  pageLength?: PageLength;
  aiRequiredSections?: string[];

  // Omitted = Aspire TSS (#125B80 / #004aad / #ea4b0c).
  colorScheme?: ColorScheme;
}

export function createCampaign(brief: CampaignBrief): Promise<{ runId: string; status: string; statusUrl: string }> {
  return request("/campaigns", { method: "POST", body: JSON.stringify(brief) });
}

/** The brief a past run was created from, for pre-filling the form. Campaigns
 *  get run in variations constantly; retyping every field each time was the
 *  most obvious daily friction in the old flow. */
export function getCampaignBrief(runId: string): Promise<CampaignBrief> {
  return request<CampaignBrief>(`/campaigns/${runId}/brief`);
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "failed_clone",
  "failed_verification",
  "failed_push",
  "failed_push_incomplete",
  "abandoned",
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Only permitted once a run is terminal — the server rejects (409) an
 *  attempt to delete a still-running one. Only removes this service's own
 *  local record; never touches anything already pushed to git/GitHub. */
export async function deleteCampaign(runId: string): Promise<void> {
  await request<void>(`/campaigns/${runId}`, { method: "DELETE" });
}

// Phase 7 — the human approval gate. Only valid while status is
// "staged_for_review" (409 otherwise); nothing this service generates
// reaches git before approveCampaign is called.
export interface ApproveResult {
  ok: true;
  prUrl: string | null;
  prNumber: number | null;
  status: "completed";
}

export function approveCampaign(runId: string): Promise<ApproveResult> {
  return request<ApproveResult>(`/campaigns/${runId}/approve`, { method: "POST" });
}

export function abandonCampaign(runId: string): Promise<{ ok: true; status: "abandoned" }> {
  return request(`/campaigns/${runId}/abandon`, { method: "POST" });
}

// Phase 9 / module.md Module 4 — per-section refinement IS the review
// step. Each slot is independently swappable/regenerable without touching
// the rest of the page.
export interface FrameCandidateSummary {
  id: string;
  description: string;
}

/** Derived from the layout's own Zod schema (src/sections/describe-fillable-fields.mjs),
 *  which is the same schema the save is validated against — so a form built
 *  from these always submits something the server accepts. */
export type CopyField =
  | { key: string; label: string; kind: "text" }
  | { key: string; label: string; kind: "text-list" }
  | { key: string; label: string; kind: "group-list"; fields: { key: string; label: string }[] }
  | { key: string; label: string; kind: "unsupported" };

export type CopyValues = Record<string, string | string[] | Record<string, string>[]>;

export interface SectionSummary {
  type: string;
  mode: "static" | "ai-required";
  path: string;
  componentName: string;
  slot: string;
  frameId?: string;
  candidates: FrameCandidateSummary[];
  /** Empty for AI-written sections and photo-based layouts — both have no
   *  editable data object, which is what tells the UI to offer the AI path. */
  fields: CopyField[];
  data: CopyValues | null;
}

export function getSections(runId: string): Promise<SectionSummary[]> {
  return request<SectionSummary[]>(`/campaigns/${runId}/sections`);
}

/** "edit-copy" is the only one that makes no LLM call — it rewrites the
 *  section's data object and re-verifies. Instant and free. */
export type RefineAction = "edit-copy" | "use-different-frame" | "modify" | "redesign" | "new";

export interface RefineParams {
  frameId?: string;
  instructions?: string;
  sectionType?: string;
  data?: CopyValues;
}

export interface RefineResult {
  ok: true;
  version: number;
  previewStarted: boolean;
  previewReport: string | null;
}

export function refineSection(runId: string, slot: string, action: RefineAction, params: RefineParams = {}): Promise<RefineResult> {
  return request<RefineResult>(`/campaigns/${runId}/sections/${slot}/refine`, {
    method: "POST",
    body: JSON.stringify({ action, ...params }),
  });
}

export interface RefinePageResult extends RefineResult {
  slots: string[];
  planSource: "keywords" | "llm" | "all";
}

/** Plain-language page edit — may rewrite several sections, then re-stage + refresh preview. */
export function refinePage(runId: string, instructions: string): Promise<RefinePageResult> {
  return request<RefinePageResult>(`/campaigns/${runId}/refine-page`, {
    method: "POST",
    body: JSON.stringify({ instructions }),
  });
}

export function recolorCampaign(runId: string, colorScheme: ColorScheme): Promise<RefineResult> {
  return request<RefineResult>(`/campaigns/${runId}/color-scheme`, {
    method: "POST",
    body: JSON.stringify({ colorScheme }),
  });
}

export interface UploadedImage {
  ok: true;
  slot: string;
  publicUrl: string;
  image: CampaignImage;
}

/**
 * Upload a raw image file as the campaign photo for a specific slot.
 * Sends raw bytes — no multipart encoding.
 */
export async function uploadCampaignImage(runId: string, slot: string, file: File): Promise<UploadedImage> {
  const res = await sessionFetch(`${BASE_URL}/campaigns/${runId}/images/${slot}`, {
    method: "POST",
    headers: {
      "Content-Type": file.type,
      "X-CSRF-Token": csrfToken,
    },
    body: file,
  });
  if (res.status === 401) {
    clearSession();
    throw new ApiError("Unauthorized", 401);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const detail = (body as { message?: string; error?: string }).message ?? (body as { error?: string }).error;
    throw new ApiError(detail ? String(detail) : `Upload failed (${res.status})`, res.status);
  }
  return res.json();
}

export { ApiError };
