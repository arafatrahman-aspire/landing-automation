import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudflareWorkersAIImageGenerator } from "../src/assets/image-gen/adapters/cloudflare.mjs";
import { NanoBananaImageGenerator } from "../src/assets/image-gen/adapters/nano-banana.mjs";
import { LeonardoAIImageGenerator } from "../src/assets/image-gen/adapters/leonardo.mjs";
import { PromptGoneImageGenerator } from "../src/assets/image-gen/adapters/promptgone.mjs";
import { JourneyAPIImageGenerator } from "../src/assets/image-gen/adapters/journey.mjs";
import { FallbackImageGenerator, parseGeneratorOrder } from "../src/assets/image-gen/fallback-generator.mjs";
import { buildGenerationPrompt } from "../src/assets/image-gen/prompt.mjs";
import { DEFAULT_GENERATOR_ORDER } from "../src/assets/image-gen/ports.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9, ...Buffer.alloc(120, 1)]);
const JPEG_B64 = JPEG.toString("base64");

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("Cloudflare constructor throws when keys are missing", () => {
  assert.throws(
    () => new CloudflareWorkersAIImageGenerator({ fetchImpl: async () => new Response() }),
    /CLOUDFLARE/
  );
});

test("Nano Banana constructor throws when the API key is missing", () => {
  assert.throws(
    () => new NanoBananaImageGenerator({ fetchImpl: async () => new Response() }),
    /GOOGLE_API_KEY/
  );
});

test("parseGeneratorOrder defaults and lowercases a CSV list", () => {
  assert.deepEqual(parseGeneratorOrder(""), DEFAULT_GENERATOR_ORDER);
  assert.deepEqual(parseGeneratorOrder("NanoBanana, Cloudflare"), ["nanobanana", "cloudflare"]);
});

test("buildGenerationPrompt prefers imagePrompts and appends no-people constraints", () => {
  const prompt = buildGenerationPrompt({
    slot: "hero",
    campaignName: "Splunk Bootcamp",
    imagePrompts: { hero: "A glowing security operations dashboard in a dark server room." },
  });
  assert.match(prompt, /glowing security operations dashboard/i);
  assert.match(prompt, /no people/i);
  assert.match(prompt, /no text/i);
  assert.doesNotMatch(prompt, /Splunk Bootcamp/);
});

test("buildGenerationPrompt composes from imageQueries when imagePrompts is missing", () => {
  const prompt = buildGenerationPrompt({
    slot: "details",
    campaignName: "Photo Course",
    offer: "Weekend workshop",
    imageQueries: { details: ["cybersecurity dashboard"] },
  });
  assert.match(prompt, /cybersecurity dashboard/i);
  assert.match(prompt, /Photo Course/);
  assert.match(prompt, /photorealistic landscape/i);
});

test("FallbackImageGenerator skips adapters whose env is missing", () => {
  const logs = [];
  const gen = new FallbackImageGenerator({
    env: { googleApiKey: "g" },
    fetchImpl: async () => new Response("no", { status: 500 }),
    logger: (m) => logs.push(m),
  });
  assert.equal(gen.configured, true);
  assert.deepEqual(gen.providerNames, ["nanobanana"]);
  assert.ok(logs.some((m) => /cloudflare skipped/i.test(m)));
});

test("FallbackImageGenerator.generate throws immediately when nothing is configured", async () => {
  const gen = new FallbackImageGenerator({
    env: {},
    fetchImpl: async () => new Response(),
  });
  assert.equal(gen.configured, false);
  await assert.rejects(() => gen.generate("a prompt"), /No image generators are configured/);
});

test("Cloudflare generate decodes a base64 FLUX image", async () => {
  const adapter = new CloudflareWorkersAIImageGenerator({
    cloudflareAccountId: "acc",
    cloudflareApiToken: "tok",
    fetchImpl: async () => jsonResponse({ result: { image: JPEG_B64 } }),
    retries: 1,
  });
  const result = await adapter.generate("a landscape");
  assert.equal(result.mime, "image/jpeg");
  assert.equal(result.ext, "jpg");
  assert.ok(result.bytes.equals(JPEG));
});

test("FallbackImageGenerator tries the next provider after a failure", async () => {
  const logs = [];
  const calls = [];
  const gen = new FallbackImageGenerator({
    env: {
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      googleApiKey: "g",
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/ai/run/")) return new Response("nope", { status: 400 });
      if (String(url).includes("generativelanguage.googleapis.com")) {
        return jsonResponse({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: JPEG_B64 } }] } }],
        });
      }
      return new Response("unexpected", { status: 500 });
    },
    logger: (m) => logs.push(m),
  });
  const result = await gen.generate("a landscape");
  assert.equal(result.provider, "nanobanana");
  assert.ok(result.bytes.equals(JPEG));
  assert.ok(calls.some((u) => u.includes("/ai/run/")));
  assert.ok(logs.some((m) => /cloudflare failed/i.test(m)));
  assert.ok(logs.some((m) => /generated via nanobanana/i.test(m)));
});

test("FallbackImageGenerator honors IMAGE_GENERATOR_ORDER", async () => {
  const calls = [];
  const gen = new FallbackImageGenerator({
    env: {
      order: "nanobanana,cloudflare",
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      googleApiKey: "g",
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("generativelanguage.googleapis.com")) {
        return jsonResponse({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: JPEG_B64 } }] } }],
        });
      }
      return new Response("should not be called", { status: 500 });
    },
  });
  const result = await gen.generate("a landscape");
  assert.equal(result.provider, "nanobanana");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("generativelanguage.googleapis.com"));
});

test("Leonardo polls until COMPLETE then downloads the image", async () => {
  let polls = 0;
  const adapter = new LeonardoAIImageGenerator({
    leonardoApiKey: "leo",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/generations") ) {
        return jsonResponse({ sdGenerationJob: { generationId: "gen-1" } });
      }
      if (String(url).includes("/generations/gen-1")) {
        polls += 1;
        if (polls < 2) return jsonResponse({ generations_by_pk: { status: "PENDING" } });
        return jsonResponse({
          generations_by_pk: {
            status: "COMPLETE",
            generated_images: [{ url: "https://cdn.leonardo.ai/out.jpg" }],
          },
        });
      }
      if (String(url).includes("cdn.leonardo.ai")) {
        return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      return new Response("unexpected", { status: 500 });
    },
    retries: 1,
    pollIntervalMs: 5,
    pollTimeoutMs: 2_000,
  });
  const result = await adapter.generate("a landscape");
  assert.equal(result.ext, "jpg");
  assert.ok(result.bytes.equals(JPEG));
  assert.ok(polls >= 2);
});

test("PromptGone treats an image/* poll response as success", async () => {
  const adapter = new PromptGoneImageGenerator({
    promptgoneApiKey: "pk",
    promptgoneAppKey: "ak",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/run")) return jsonResponse({ id: "pred-1" });
      if (String(url).includes("/predictions/pred-1")) {
        return new Response(JPEG, { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response("unexpected", { status: 500 });
    },
    retries: 1,
    pollIntervalMs: 5,
    pollTimeoutMs: 2_000,
  });
  const result = await adapter.generate("a landscape");
  assert.equal(result.mime, "image/png");
});

test("JourneyAPI polls /fetch until finished then downloads", async () => {
  let fetches = 0;
  const adapter = new JourneyAPIImageGenerator({
    journeyApiKey: "jk",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/imagine")) return jsonResponse({ task_id: "t-1" });
      if (String(url).endsWith("/fetch")) {
        fetches += 1;
        if (fetches < 2) return jsonResponse({ status: "processing" });
        return jsonResponse({ status: "finished", data: { image_url: "https://cdn.journey/out.jpg" } });
      }
      if (String(url).includes("cdn.journey")) {
        return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      return new Response("unexpected", { status: 500 });
    },
    retries: 1,
    pollIntervalMs: 5,
    pollTimeoutMs: 2_000,
  });
  const result = await adapter.generate("a landscape");
  assert.ok(result.bytes.equals(JPEG));
  assert.ok(fetches >= 2);
});

test("FallbackImageGenerator throws after every configured provider fails", async () => {
  const gen = new FallbackImageGenerator({
    env: { cloudflareAccountId: "acc", cloudflareApiToken: "tok" },
    fetchImpl: async () => new Response("nope", { status: 400 }),
    logger: () => {},
  });
  await assert.rejects(() => gen.generate("a landscape"), /All image generators failed/);
});
