import { decodeBase64Image } from "../bytes.mjs";
import { retryOnNetworkOrHttp, withRetry } from "../retry.mjs";

function abortSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

function inlineFromParts(parts) {
  for (const part of parts) {
    const inline = part?.inlineData ?? part?.inline_data;
    const data = inline?.data;
    if (typeof data === "string" && data) {
      const mime = inline.mimeType || inline.mime_type || "image/png";
      return decodeBase64Image(data, mime);
    }
  }
  return null;
}

/**
 * Google Gemini image model ("Nano Banana") via REST generateContent.
 * API key: GOOGLE_API_KEY, falling back to GEMINI_API_KEY at config time.
 */
export class NanoBananaImageGenerator {
  constructor({
    googleApiKey,
    nanoBananaModel = "gemini-2.5-flash-image",
    fetchImpl,
    retries = 3,
    retryDelayMs = 800,
  } = {}) {
    if (!googleApiKey) {
      throw new Error("Nano Banana image generator missing GOOGLE_API_KEY / GEMINI_API_KEY");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("Nano Banana image generator requires fetchImpl");
    }
    this.apiKey = googleApiKey;
    this.model = nanoBananaModel || "gemini-2.5-flash-image";
    this.fetchImpl = fetchImpl;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
  }

  async generate(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await withRetry(
      () =>
        this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
          signal: abortSignal(90_000),
        }),
      {
        retries: this.retries,
        retryDelayMs: this.retryDelayMs,
        retryOn: retryOnNetworkOrHttp,
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Nano Banana HTTP ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }
    const body = await res.json().catch(() => null);
    const parts = body?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error("Nano Banana response missing image parts");
    }
    const image = inlineFromParts(parts);
    if (!image) throw new Error("Nano Banana response missing inline image data");
    return image;
  }
}
