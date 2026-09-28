import { jsonField, responseToImage } from "../bytes.mjs";
import { retryOnNetworkOrHttp, pollUntil, withRetry } from "../retry.mjs";

function abortSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

function taskIdFrom(body) {
  return (
    jsonField(body, "task_id", "taskId", "id") ??
    jsonField(body?.data, "task_id", "taskId", "id")
  );
}

function statusFrom(body) {
  return String(
    jsonField(body, "status", "state") ?? jsonField(body?.data, "status", "state") ?? ""
  ).toLowerCase();
}

function imageUrlFrom(body) {
  const data = body?.data ?? body;
  const candidates = [
    data?.image_url,
    data?.imageUrl,
    data?.image,
    data?.url,
    Array.isArray(data?.image_urls) ? data.image_urls[0] : null,
    Array.isArray(data?.images) ? data.images[0]?.url ?? data.images[0] : null,
    data?.output,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
  }
  return null;
}

/**
 * JourneyAPI (proxy over Midjourney / FLUX / Nano Banana): POST /imagine,
 * poll /fetch with task_id until finished/failed, then download the image.
 */
export class JourneyAPIImageGenerator {
  constructor({
    journeyApiKey,
    journeyModel = "flux",
    journeyBaseUrl = "https://api.journeyapi.io",
    fetchImpl,
    retries = 3,
    retryDelayMs = 800,
    pollIntervalMs = 2_000,
    pollTimeoutMs = 180_000,
  } = {}) {
    if (!journeyApiKey) {
      throw new Error("JourneyAPI image generator missing JOURNEY_API_KEY");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("JourneyAPI image generator requires fetchImpl");
    }
    this.apiKey = journeyApiKey;
    this.model = journeyModel || "flux";
    this.baseUrl = String(journeyBaseUrl || "https://api.journeyapi.io").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async generate(prompt) {
    const startRes = await withRetry(
      () =>
        this.fetchImpl(`${this.baseUrl}/imagine`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ prompt, model: this.model }),
          signal: abortSignal(30_000),
        }),
      {
        retries: this.retries,
        retryDelayMs: this.retryDelayMs,
        retryOn: retryOnNetworkOrHttp
      }
    );
    if (!startRes.ok) {
      const detail = await startRes.text().catch(() => "");
      throw new Error(`JourneyAPI HTTP ${startRes.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }
    const startBody = await startRes.json().catch(() => null);
    const taskId = taskIdFrom(startBody);
    if (!taskId) throw new Error("JourneyAPI response missing task_id");

    const done = await pollUntil({
      fn: async () => {
        const res = await this.fetchImpl(`${this.baseUrl}/fetch`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ task_id: taskId }),
          signal: abortSignal(20_000),
        });
        if (!res.ok) throw new Error(`JourneyAPI fetch HTTP ${res.status}`);
        return res.json();
      },
      isDone: (body) => {
        const status = statusFrom(body);
        return ["finished", "succeeded", "success", "complete", "completed", "done"].includes(status) || Boolean(imageUrlFrom(body));
      },
      isFailed: (body) => {
        const status = statusFrom(body);
        return ["failed", "error", "errored", "canceled", "cancelled"].includes(status);
      },
      failMessage: (body) => `JourneyAPI generation failed: ${jsonField(body, "error", "message", "fail_reason") || "failed"}`,
      timeoutMs: this.pollTimeoutMs,
      intervalMs: this.pollIntervalMs,
    });

    const imageUrl = imageUrlFrom(done);
    if (!imageUrl) throw new Error("JourneyAPI finished without an image URL");
    const download = await this.fetchImpl(imageUrl, { signal: abortSignal(20_000) });
    return responseToImage(download);
  }
}
