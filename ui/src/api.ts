const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4300";
const SECRET_KEY = "campaignCodegenApiSecret";

export function getSecret(): string {
  return sessionStorage.getItem(SECRET_KEY) ?? "";
}

export function setSecret(secret: string) {
  sessionStorage.setItem(SECRET_KEY, secret);
}

export function clearSecret() {
  sessionStorage.removeItem(SECRET_KEY);
}

export function hasSecret(): boolean {
  return getSecret().length > 0;
}

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getSecret()}`,
      ...(options.headers ?? {}),
    },
  });

  if (res.status === 401) {
    clearSecret();
    throw new ApiError("Unauthorized — the shared secret was rejected. Reload and re-enter it.", 401);
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

export interface SectionReference {
  sectionType: string;
  note: string;
  files: { path: string; found: boolean }[];
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
  sectionReferences?: SectionReference[] | null;
  verifyChecks?: VerifyChecks | null;
  verifyAttempts?: number;
}

export interface VerifyChecks {
  build: boolean;
  hero: boolean | null;
  seo: boolean | null;
  a11y: boolean | null;
}

export function listCampaigns(): Promise<RunSummary[]> {
  return request<RunSummary[]>("/campaigns");
}

export function getRun(runId: string): Promise<RunSummary> {
  return request<RunSummary>(`/campaigns/${runId}`);
}

export async function getRunLog(runId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/campaigns/${runId}/log`, {
    headers: { Authorization: `Bearer ${getSecret()}` },
  });
  if (res.status === 401) {
    clearSecret();
    throw new ApiError("Unauthorized", 401);
  }
  if (!res.ok) throw new ApiError(`Failed to fetch log (${res.status})`, res.status);
  return res.text();
}

export interface CampaignBrief {
  slug: string;
  campaignName: string;
  offer: string;
  audience: string;
  cta: string;
  brief?: string;
  videoUrl?: string;
}

export function createCampaign(brief: CampaignBrief): Promise<{ runId: string; status: string; statusUrl: string }> {
  return request("/campaigns", { method: "POST", body: JSON.stringify(brief) });
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

export { ApiError };
