import { GENERATED_IMAGE_HEIGHT, GENERATED_IMAGE_WIDTH } from "../ports.mjs";
import { decodeBase64Image } from "../bytes.mjs";
import { retryOnNetworkOrHttp, withRetry } from "../retry.mjs";

function abortSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/**
 * Cloudflare Workers AI (FLUX.1 schnell). Synchronous REST; image is base64.
 */
export class CloudflareWorkersAIImageGenerator {
  constructor({
    cloudflareAccountId,
    cloudflareApiToken,
    cloudflareModel = "@cf/black-forest-labs/flux-1-schnell",
    cloudflareBaseUrl = "https://api.cloudflare.com/client/v4",
    fetchImpl,
    retries = 3,
    retryDelayMs = 800,
  } = {}) {
    if (!cloudflareAccountId || !cloudflareApiToken) {
      throw new Error("Cloudflare image generator missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("Cloudflare image generator requires fetchImpl");
    }
    this.accountId = cloudflareAccountId;
    this.apiToken = cloudflareApiToken;
    this.model = cloudflareModel || "@cf/black-forest-labs/flux-1-schnell";
    this.baseUrl = String(cloudflareBaseUrl || "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
  }

  async generate(prompt) {
    const url = `${this.baseUrl}/accounts/${this.accountId}/ai/run/${this.model}`;
    const res = await withRetry(
      () =>
        this.fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt,
            width: GENERATED_IMAGE_WIDTH,
            height: GENERATED_IMAGE_HEIGHT,
          }),
          signal: abortSignal(60_000),
        }),
      {
        retries: this.retries,
        retryDelayMs: this.retryDelayMs,
        retryOn: retryOnNetworkOrHttp,
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Cloudflare HTTP ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }
    const body = await res.json().catch(() => null);
    const b64 = body?.result?.image ?? body?.image ?? body?.result?.images?.[0];
    if (!b64 || typeof b64 !== "string") {
      throw new Error("Cloudflare response missing image");
    }
    return decodeBase64Image(b64, "image/jpeg");
  }
}
