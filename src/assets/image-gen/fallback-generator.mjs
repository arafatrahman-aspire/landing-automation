import { DEFAULT_GENERATOR_ORDER } from "./ports.mjs";
import { CloudflareWorkersAIImageGenerator } from "./adapters/cloudflare.mjs";
import { NanoBananaImageGenerator } from "./adapters/nano-banana.mjs";
import { LeonardoAIImageGenerator } from "./adapters/leonardo.mjs";
import { PromptGoneImageGenerator } from "./adapters/promptgone.mjs";
import { JourneyAPIImageGenerator } from "./adapters/journey.mjs";

const REGISTRY = {
  cloudflare: CloudflareWorkersAIImageGenerator,
  nanobanana: NanoBananaImageGenerator,
  leonardo: LeonardoAIImageGenerator,
  promptgone: PromptGoneImageGenerator,
  journey: JourneyAPIImageGenerator,
};

export function parseGeneratorOrder(raw) {
  const names = String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return names.length ? names : [...DEFAULT_GENERATOR_ORDER];
}

/** Map process.env / parsed config env (SCREAMING_SNAKE) onto adapter options. */
export function buildImageGenEnv(env = process.env) {
  return {
    order: env.IMAGE_GENERATOR_ORDER,
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || null,
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN || null,
    cloudflareModel: env.CLOUDFLARE_MODEL,
    cloudflareBaseUrl: env.CLOUDFLARE_BASE_URL,
    googleApiKey: env.GOOGLE_API_KEY || env.GEMINI_API_KEY || null,
    nanoBananaModel: env.NANO_BANANA_MODEL,
    leonardoApiKey: env.LEONARDO_API_KEY || null,
    leonardoBaseUrl: env.LEONARDO_BASE_URL,
    promptgoneApiKey: env.PROMPTGONE_API_KEY || null,
    promptgoneAppKey: env.PROMPTGONE_APP_KEY || null,
    promptgoneModel: env.PROMPTGONE_MODEL,
    promptgoneBaseUrl: env.PROMPTGONE_BASE_URL,
    journeyApiKey: env.JOURNEY_API_KEY || null,
    journeyModel: env.JOURNEY_MODEL,
    journeyBaseUrl: env.JOURNEY_BASE_URL,
  };
}

/**
 * Ordered fallback across configured image-generation providers.
 *
 * Each named adapter is constructed at init; missing API keys throw and that
 * provider is skipped (logged). generate() tries the remaining adapters in
 * order and throws if all fail — or immediately if none were constructed.
 */
export class FallbackImageGenerator {
  constructor({ env = {}, fetchImpl, logger = () => {}, order, pollIntervalMs, pollTimeoutMs } = {}) {
    const names = order ?? parseGeneratorOrder(env.order);
    this.logger = logger;
    this.generators = [];
    const shared = { fetchImpl, pollIntervalMs, pollTimeoutMs };
    for (const name of names) {
      const Ctor = REGISTRY[name];
      if (!Ctor) {
        logger(`campaign images: unknown generator "${name}" — skipped`);
        continue;
      }
      try {
        this.generators.push({ name, generator: new Ctor({ ...env, ...shared }) });
      } catch (err) {
        logger(`campaign images: ${name} skipped (${err.message})`);
      }
    }
  }

  get configured() {
    return this.generators.length > 0;
  }

  get providerNames() {
    return this.generators.map((g) => g.name);
  }

  async generate(prompt) {
    if (this.generators.length === 0) {
      throw new Error("No image generators are configured");
    }
    let lastError = null;
    for (const { name, generator } of this.generators) {
      try {
        const result = await generator.generate(prompt);
        this.logger(`campaign images: generated via ${name}`);
        return { ...result, provider: name };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger(`campaign images: ${name} failed (${lastError.message})`);
      }
    }
    throw new Error(`All image generators failed. Last error: ${lastError?.message ?? "unknown"}`);
  }
}
