import { GENERATED_IMAGE_HEIGHT, GENERATED_IMAGE_WIDTH } from "../ports.mjs";
import { jsonField, responseToImage } from "../bytes.mjs";
import { retryOnNetworkOrHttp, pollUntil, withRetry } from "../retry.mjs";

function abortSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/**
 * Leonardo AI: POST to start a generation, poll until COMPLETE/FAILED, then
 * download the first generated image URL.
 */
export class LeonardoAIImageGenerator {
  constructor({
    leonardoApiKey,
    leonardoBaseUrl = "https://cloud.leonardo.ai/api/rest/v1",
    fetchImpl,
    retries = 3,
    retryDelayMs = 800,
    pollIntervalMs = 2_000,
    pollTimeoutMs = 120_000,
  } = {}) {
    if (!leonardoApiKey) {
      throw new Error("Leonardo image generator missing LEONARDO_API_KEY");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("Leonardo image generator requires fetchImpl");
    }
    this.apiKey = leonardoApiKey;
    this.baseUrl = String(leonardoBaseUrl || "https://cloud.leonardo.ai/api/rest/v1").replace(/\/+$/, "");
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
      accept: "application/json",
    };
  }

  async generate(prompt) {
    const startRes = await withRetry(
      () =>
        this.fetchImpl(`${this.baseUrl}/generations`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            prompt,
            width: GENERATED_IMAGE_WIDTH,
            height: GENERATED_IMAGE_HEIGHT,
            num_images: 1,
          }),
          signal: abortSignal(30_000),
        }),
      {
        retries: this.retries,
        retryDelayMs: this.retryDelayMs,
        retryOn: retryOnNetworkOrHttp,
      }
    );
    if (!startRes.ok) {
      const detail = await startRes.text().catch(() => "");
      throw new Error(`Leonardo HTTP ${startRes.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }
    const startBody = await startRes.json().catch(() => null);
    const generationId =
      jsonField(startBody?.sdGenerationJob, "generationId", "generation_id") ??
      jsonField(startBody, "generationId", "generation_id", "id");
    if (!generationId) throw new Error("Leonardo response missing generationId");

    const job = await pollUntil({
      fn: async () => {
        const res = await this.fetchImpl(`${this.baseUrl}/generations/${generationId}`, {
          headers: this.headers(),
          signal: abortSignal(20_000),
        });
        if (!res.ok) throw new Error(`Leonardo poll HTTP ${res.status}`);
        return res.json();
      },
      isDone: (body) => {
        const status = String(jsonField(body?.generations_by_pk, "status") ?? jsonField(body, "status") ?? "").toUpperCase();
        return status === "COMPLETE" || status === "COMPLETED";
      },
      isFailed: (body) => {
        const status = String(jsonField(body?.generations_by_pk, "status") ?? jsonField(body, "status") ?? "").toUpperCase();
        return status === "FAILED" || status === "ERROR";
      },
      failMessage: () => "Leonardo generation FAILED",
      timeoutMs: this.pollTimeoutMs,
      intervalMs: this.pollIntervalMs,
    });

    const images =
      job?.generations_by_pk?.generated_images ??
      job?.generated_images ??
      job?.generations_by_pk?.generatedImages ??
      [];
    const imageUrl = images[0]?.url ?? images[0]?.src;
    if (typeof imageUrl !== "string" || !imageUrl) {
      throw new Error("Leonardo COMPLETE response missing image URL");
    }
    const download = await this.fetchImpl(imageUrl, { signal: abortSignal(20_000) });
    return responseToImage(download);
  }
}
