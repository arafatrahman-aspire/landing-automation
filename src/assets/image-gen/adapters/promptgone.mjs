import { decodeBase64Image, jsonField, responseToImage } from "../bytes.mjs";
import { retryOnNetworkOrHttp, pollUntil, withRetry } from "../retry.mjs";

function abortSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

async function imageFromPrediction(body, contentType, rawRes, fetchImpl) {
  if (contentType.startsWith("image/")) {
    return responseToImage(rawRes);
  }
  const output = jsonField(body, "output", "image", "url", "result");
  const url = Array.isArray(output) ? output[0] : typeof output === "string" && output.startsWith("http") ? output : output?.url;
  if (typeof url === "string" && url.startsWith("http")) {
    const download = await fetchImpl(url, { signal: abortSignal(20_000) });
    return responseToImage(download);
  }
  const b64 = typeof output === "string" && !output.startsWith("http") ? output : jsonField(body, "image_base64", "image");
  if (typeof b64 === "string" && b64.length > 80) {
    return decodeBase64Image(b64, jsonField(body, "mime", "mime_type") || "image/png");
  }
  return null;
}

/**
 * PromptGone (proxy over FLUX / Nano Banana / Imagen): POST /run, then poll
 * /predictions/{id} until the body is an image or the JSON status is terminal.
 */
export class PromptGoneImageGenerator {
  constructor({
    promptgoneApiKey,
    promptgoneAppKey,
    promptgoneModel = "flux",
    promptgoneBaseUrl = "https://api.promptgone.ai",
    fetchImpl,
    retries = 3,
    retryDelayMs = 800,
    pollIntervalMs = 2_000,
    pollTimeoutMs = 120_000,
  } = {}) {
    if (!promptgoneApiKey || !promptgoneAppKey) {
      throw new Error("PromptGone image generator missing PROMPTGONE_API_KEY or PROMPTGONE_APP_KEY");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("PromptGone image generator requires fetchImpl");
    }
    this.apiKey = promptgoneApiKey;
    this.appKey = promptgoneAppKey;
    this.model = promptgoneModel || "flux";
    this.baseUrl = String(promptgoneBaseUrl || "https://api.promptgone.ai").replace(/\/+$/, "");
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
        this.fetchImpl(`${this.baseUrl}/run`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            app_key: this.appKey,
            model: this.model,
            input: { prompt },
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
      throw new Error(`PromptGone HTTP ${startRes.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }
    const startBody = await startRes.json().catch(() => null);
    const id =
      jsonField(startBody, "id", "prediction_id", "predictionId") ??
      jsonField(startBody?.data, "id", "prediction_id");
    if (!id) throw new Error("PromptGone response missing prediction id");

    let lastRaw = null;
    const done = await pollUntil({
      fn: async () => {
        const res = await this.fetchImpl(`${this.baseUrl}/predictions/${id}`, {
          headers: this.headers(),
          signal: abortSignal(20_000),
        });
        lastRaw = res;
        const contentType = String(res.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!res.ok && !contentType.startsWith("image/")) {
          throw new Error(`PromptGone poll HTTP ${res.status}`);
        }
        if (contentType.startsWith("image/")) {
          return { kind: "image", res, contentType };
        }
        const body = await res.json().catch(() => null);
        return { kind: "json", res, contentType, body };
      },
      isDone: (step) => {
        if (step.kind === "image") return true;
        const status = String(jsonField(step.body, "status", "state") ?? "").toLowerCase();
        if (["succeeded", "success", "complete", "completed", "finished"].includes(status)) return true;
        const output = jsonField(step.body, "output", "image", "url");
        return Boolean(output);
      },
      isFailed: (step) => {
        if (step.kind === "image") return false;
        const status = String(jsonField(step.body, "status", "state") ?? "").toLowerCase();
        return ["failed", "error", "errored", "canceled", "cancelled"].includes(status);
      },
      failMessage: (step) =>
        `PromptGone generation failed: ${jsonField(step.body, "error", "message") || "errored"}`,
      timeoutMs: this.pollTimeoutMs,
      intervalMs: this.pollIntervalMs,
    });

    if (done.kind === "image") return responseToImage(done.res ?? lastRaw);
    const image = await imageFromPrediction(done.body, done.contentType, done.res ?? lastRaw, this.fetchImpl);
    if (!image) throw new Error("PromptGone prediction finished without an image");
    return image;
  }
}
