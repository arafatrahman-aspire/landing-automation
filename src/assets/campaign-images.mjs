import { createHash } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { FallbackImageGenerator } from "./image-gen/fallback-generator.mjs";
import { buildGenerationPrompt } from "./image-gen/prompt.mjs";
import { GENERATED_IMAGE_HEIGHT, GENERATED_IMAGE_WIDTH } from "./image-gen/ports.mjs";

/* Campaign images: AI generation first (Cloudflare / Nano Banana / Leonardo /
 * PromptGone / Journey, ordered by IMAGE_GENERATOR_ORDER), then Pexels, then
 * SerpAPI Google Images. Bytes upload to Supabase Storage; only the public
 * URL is returned.
 *
 * Missing API keys skip that provider / skip images entirely and log; the
 * campaign still generates. Binaries are NEVER written into the target repo
 * (WRITE_PATH_ALLOWLIST is campaign source only). */

// Pexels sits behind Cloudflare. Popular one-word searches are cached and
// return in <1s (cf-cache-status: HIT). Unique phrases — campaign titles,
// "no people", "still life" — miss cache, the origin never responds, and
// AbortSignal.timeout is what showed up as "Pexels failed". Pin sockets to
// IPv4 as well so undici does not stall on a bad AAAA route.
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* Node < 16 */
}

export const IMAGE_SLOTS = ["details", "timeline", "hero"];

/**
 * Slot-specific single-word fallbacks that are popular on Pexels and very
 * likely to be served from Cloudflare cache (<1 s).  These are only used
 * when the campaign-specific queries all time-out or return no results.
 */
// Slot-specific fallback pools are deliberately DIFFERENT per slot so that
// even when campaign-specific queries all time out, each slot draws from a
// distinct pool and the deduplication key set still has room to pick
// different photos. Pools must not overlap (e.g. "technology" appears in
// only one slot).
export const STOCK_QUERIES_BY_SLOT = {
  hero:     ["innovation", "future", "digital"],
  details:  ["technology", "learning", "professional"],
  timeline: ["teamwork", "progress", "strategy"],
};

/** Common English words that add no meaning to an image search. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "our",
  "are", "was", "were", "been", "have", "has", "had", "will", "can",
  "all", "any", "each", "more", "most", "new", "into", "its", "not",
  "how", "get", "use", "via",
]);

const DOWNLOAD_TIMEOUT_MS = 20_000;
// 4 s was too short for non-cached Pexels queries (campaign-specific terms
// like "cybersecurity" or "Splunk" miss the Cloudflare cache and need more
// time from the origin). 10 s is generous enough to succeed while still
// bailing quickly when a keyword genuinely has no Pexels results.
const SEARCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_HEADERS = { "User-Agent": "campaign-codegen/1.0" };
const PEOPLE_ALT = /\b(man|woman|men|women|person|people|portrait|girl|boy|child|face)\b/i;

function isAbortError(err) {
  const name = err?.name ?? "";
  return name === "TimeoutError" || name === "AbortError";
}


/**
 * Build up to 8 image-search queries for a campaign slot, ordered from most
 * to least specific:
 *
 *  1. LLM-suggested visual queries for this slot (imageQueries[slot]) —
 *     these are the most relevant because the LLM knows the campaign context
 *     and picks Pexels-friendly descriptions instead of brand names/acronyms.
 *  2. Full campaign name — works well for SerpAPI / Google Images.
 *  3. Top LLM-researched keywords (may include niche terms like "SIEM" that
 *     Pexels has nothing for, but SerpAPI handles them fine).
 *  4. Meaningful single words from the campaign name.
 *  5. Slot-specific generic fallbacks — distinct pools per slot so each slot
 *     gets a different fallback photo.
 *
 * @param {object}   p
 * @param {string}   p.campaignName
 * @param {string}   [p.offer]
 * @param {string[]} [p.keywords]       - raw research keywords
 * @param {object}   [p.imageQueries]   - LLM-suggested { hero, details, timeline }
 * @param {string}   p.slot
 * @returns {string[]} up to 8 queries, most specific first
 */
export function buildImageQueries({ campaignName, offer, keywords = [], imageQueries = null, slot }) {
  const seen = new Set();
  const candidates = [];

  function add(q) {
    const key = String(q ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(String(q).trim());
  }

  // 1. LLM-suggested visual queries for this slot — highest priority because
  //    the LLM understands what visuals are relevant and avoids brand names /
  //    acronyms that Pexels has no photos for (e.g. "SIEM", "Splunk").
  const llmSlotQueries = Array.isArray(imageQueries?.[slot]) ? imageQueries[slot] : [];
  for (const q of llmSlotQueries) add(q);

  // 2. Full campaign name — descriptive for SerpAPI / Google Images.
  add(campaignName);

  // 3. Top research keywords (SerpAPI handles niche terms; Pexels will skip them).
  for (const kw of (keywords ?? []).slice(0, 5)) add(kw);

  // 4. Offer phrase.
  add(offer);

  // 5. Individual meaningful words from the campaign name.
  const nameWords = String(campaignName ?? "")
    .toLowerCase()
    .split(/[\s\-_,./(\)[\]]+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  for (const w of nameWords) add(w);

  // 6. Slot-specific generic fallbacks — distinct pools, always cached on Pexels.
  const fallback = STOCK_QUERIES_BY_SLOT[slot] ?? STOCK_QUERIES_BY_SLOT.details;
  for (const q of fallback) add(q);

  return candidates.slice(0, 8);
}

export function isImagePipelineConfigured({
  pexelsApiKey,
  serpApiKey,
  supabaseUrl,
  supabaseServiceRoleKey,
  imageGenerator,
}) {
  const hasStore = Boolean(supabaseUrl && supabaseServiceRoleKey);
  const hasSearch = Boolean(pexelsApiKey || serpApiKey);
  const hasGen = Boolean(imageGenerator?.configured);
  return hasStore && (hasSearch || hasGen);
}

/** @deprecated use isImagePipelineConfigured */
export function isImageSearchConfigured(creds) {
  return isImagePipelineConfigured(creds);
}

function abortSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

function timeoutError(message = "The operation was aborted due to timeout") {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

/**
 * fetch() replacement that only dials IPv4. Tests still inject fetchImpl.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: Buffer|string|Uint8Array, signal?: AbortSignal }} [opts]
 * @returns {Promise<Response>}
 */
export function ipv4Fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const signal = opts.signal;
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason : timeoutError();
      reject(reason);
      return;
    }

    const lib = parsed.protocol === "http:" ? http : https;
    const method = String(opts.method ?? "GET").toUpperCase();
    const headers = { ...(opts.headers ?? {}) };
    const body = opts.body;
    if (
      body != null &&
      headers["Content-Length"] == null &&
      headers["content-length"] == null
    ) {
      const len = Buffer.isBuffer(body) || body instanceof Uint8Array ? body.length : Buffer.byteLength(String(body));
      headers["Content-Length"] = String(len);
    }

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        family: 4,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const hdrs = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value == null) continue;
            if (Array.isArray(value)) {
              for (const item of value) hdrs.append(key, item);
            } else {
              hdrs.set(key, value);
            }
          }
          finish(resolve, new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: hdrs }));
        });
      }
    );

    const onAbort = () => {
      req.destroy();
      const reason = signal?.reason instanceof Error ? signal.reason : timeoutError();
      finish(reject, reason);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    req.on("error", (err) => finish(reject, err));
    req.on("timeout", () => {
      req.destroy();
      finish(reject, timeoutError());
    });

    if (body != null) req.write(body);
    req.end();
  });
}

export function extFromContentType(contentType) {
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return { ext: "jpg", mime: "image/jpeg" };
  if (type === "image/png") return { ext: "png", mime: "image/png" };
  if (type === "image/webp") return { ext: "webp", mime: "image/webp" };
  return null;
}

function extFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".png")) return { ext: "png", mime: "image/png" };
    if (path.endsWith(".webp")) return { ext: "webp", mime: "image/webp" };
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return { ext: "jpg", mime: "image/jpeg" };
  } catch {
    // ignore
  }
  return { ext: "jpg", mime: "image/jpeg" };
}

/**
 * Extract the stable numeric photo ID from a Pexels CDN URL so we can
 * deduplicate across slots even if the URL params differ.
 * e.g. https://images.pexels.com/photos/12345/pexels-photo-12345.jpeg?...
 *      → "pexels:12345"
 */
function pexelsPhotoKey(url) {
  try {
    const m = new URL(url).pathname.match(/\/photos\/([\d]+)\//i);
    return m ? `pexels:${m[1]}` : url;
  } catch {
    return url;
  }
}

function pickPhoto(photos, query, usedKeys = new Set()) {
  const mapped = [];
  for (const photo of photos) {
    const src = photo?.src?.large2x || photo?.src?.large || photo?.src?.original;
    if (typeof src !== "string" || !src) continue;
    const key = pexelsPhotoKey(src);
    if (usedKeys.has(key)) continue; // skip already-used photos
    const alt = typeof photo.alt === "string" && photo.alt.trim() ? photo.alt.trim() : query;
    mapped.push({
      url: src,
      key,
      width: Number(photo.width) || 1200,
      height: Number(photo.height) || 800,
      alt,
    });
  }
  return mapped.find((p) => !PEOPLE_ALT.test(p.alt)) ?? mapped[0] ?? null;
}

/**
 * @returns {Promise<{ url: string, width: number, height: number, alt: string }|null>}
 */
export async function searchPexels(query, apiKey, { fetchImpl = ipv4Fetch, usedKeys = new Set() } = {}) {
  if (!apiKey || !query) return null;
  // 15 results gives more candidates to pick a non-duplicate, non-people photo.
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`;
  const res = await fetchImpl(url, {
    headers: { ...FETCH_HEADERS, Authorization: apiKey },
    signal: abortSignal(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  const photos = Array.isArray(body?.photos) ? body.photos : [];
  return pickPhoto(photos, query, usedKeys);
}

/**
 * @returns {Promise<{ url: string, width: number, height: number, alt: string }|null>}
 */
export async function searchSerpApi(query, apiKey, { fetchImpl = ipv4Fetch } = {}) {
  if (!apiKey || !query) return null;
  const url =
    `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(query)}` +
    `&imgsz=l&api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, { headers: FETCH_HEADERS, signal: abortSignal(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  const results = Array.isArray(body?.images_results) ? body.images_results : [];
  for (const item of results) {
    const src = item?.original || item?.thumbnail;
    if (typeof src !== "string" || !src.startsWith("http")) continue;
    return {
      url: src,
      width: Number(item.original_width) || 1200,
      height: Number(item.original_height) || 800,
      alt: typeof item.title === "string" && item.title.trim() ? item.title.trim() : query,
    };
  }
  return null;
}

async function downloadImage(url, { fetchImpl = ipv4Fetch } = {}) {
  const res = await fetchImpl(url, { headers: FETCH_HEADERS, signal: abortSignal(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) return null;
  const mimeHint = extFromContentType(res.headers.get("content-type")) ?? extFromUrl(url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.length > MAX_BYTES) return null;
  return { bytes: buf, ...mimeHint };
}

function publicObjectUrl(supabaseUrl, bucket, objectPath) {
  const base = String(supabaseUrl).replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${bucket}/${objectPath}`;
}

async function uploadToSupabase({
  bytes,
  mime,
  ext,
  slug,
  slot,
  supabaseUrl,
  supabaseServiceRoleKey,
  supabaseStorageBucket,
  fetchImpl = ipv4Fetch,
}) {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const objectPath = `${slug}/${slot}-${hash}.${ext}`;
  const endpoint = `${String(supabaseUrl).replace(/\/+$/, "")}/storage/v1/object/${supabaseStorageBucket}/${objectPath}`;
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        apikey: supabaseServiceRoleKey,
        "Content-Type": mime,
        "x-upsert": "true",
      },
      body: bytes,
      signal: abortSignal(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    if ([err?.code, err?.cause?.code].some((code) => code === "ENOTFOUND" || code === "EAI_AGAIN")) {
      throw new Error(`Cannot resolve the image storage host (${new URL(supabaseUrl).hostname}). Check SUPABASE_URL and its matching SUPABASE_SERVICE_ROLE_KEY in the landing .env, then restart the backend.`, { cause: err });
    }
    throw err;
  }
  if (!res.ok && res.status !== 409) {
    const detail = await res.text().catch(() => "");
    throw new Error(`supabase upload ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
  return publicObjectUrl(supabaseUrl, supabaseStorageBucket, objectPath);
}

async function searchOnePhoto(query, { pexelsApiKey, serpApiKey, fetchImpl, logger, pexelsDisabled, usedKeys = new Set() }) {
  if (pexelsApiKey && !pexelsDisabled.value) {
    try {
      // Pass usedKeys so pickPhoto can skip already-chosen photos inside the
      // result set — deduplication happens at the photo level, not just URL.
      const hit = await searchPexels(query, pexelsApiKey, { fetchImpl, usedKeys });
      if (hit) return { ...hit, source: "pexels", query };
    } catch (err) {
      logger(`campaign images: Pexels failed for "${query}" (${err.message})`);
      if (isAbortError(err)) {
        pexelsDisabled.timeouts += 1;
        if (pexelsDisabled.timeouts >= 3) pexelsDisabled.value = true;
      }
    }
  }
  if (serpApiKey) {
    try {
      const hit = await searchSerpApi(query, serpApiKey, { fetchImpl });
      // For SerpAPI use the full URL as the dedup key.
      if (hit && !usedKeys.has(hit.url)) return { ...hit, source: "serpapi", query };
    } catch (err) {
      logger(`campaign images: SerpAPI failed for "${query}" (${err.message})`);
    }
  }
  return null;
}

function resolveImageGenerator({ imageGenerator, imageGenEnv, fetchImpl, logger }) {
  if (imageGenerator) return imageGenerator;
  if (!imageGenEnv) return null;
  return new FallbackImageGenerator({ env: imageGenEnv, fetchImpl, logger });
}

async function uploadAssigned({
  bytes,
  mime,
  ext,
  slug,
  slot,
  supabaseUrl,
  supabaseServiceRoleKey,
  supabaseStorageBucket,
  fetchImpl,
  query,
  source,
  width,
  height,
  alt,
}) {
  const publicUrl = await uploadToSupabase({
    bytes,
    mime,
    ext,
    slug,
    slot,
    supabaseUrl,
    supabaseServiceRoleKey,
    supabaseStorageBucket,
    fetchImpl,
  });
  return { slot, query, source, publicUrl, width, height, alt };
}

/**
 * Assign at most one photo per slot. Tries AI generation first, then stock
 * search (Pexels → SerpAPI). Hero is skipped when a videoUrl is set.
 * Failures skip that slot; they never abort the campaign.
 *
 * @returns {Promise<Array<{ slot: string, query: string, source: string, publicUrl: string, width: number, height: number, alt: string }>>}
 */
export async function assignCampaignImages({
  slug,
  campaignName,
  offer,
  audience = "",
  videoUrl,
  keywords = [],
  imageQueries = null,   // { hero: string[], details: string[], timeline: string[] } from research LLM
  imagePrompts = null,   // { hero, details, timeline } generation prompts from research LLM
  pexelsApiKey,
  serpApiKey,
  supabaseUrl,
  supabaseServiceRoleKey,
  supabaseStorageBucket = "campaign-images",
  imageGenEnv = null,
  imageGenerator = null,
  logger = () => {},
  fetchImpl = ipv4Fetch,
}) {
  const generator = resolveImageGenerator({ imageGenerator, imageGenEnv, fetchImpl, logger });
  const creds = { pexelsApiKey, serpApiKey, supabaseUrl, supabaseServiceRoleKey, imageGenerator: generator };
  if (!isImagePipelineConfigured(creds)) {
    logger("campaign images: skipped (no image generator / PEXELS_API_KEY / SERPAPI_API_KEY, or SUPABASE_* not configured)");
    return [];
  }

  const slots = IMAGE_SLOTS.filter((slot) => slot !== "hero" || !videoUrl);
  const assigned = [];
  const pexelsDisabled = { value: false, timeouts: 0 };
  // Deduplicate by stable photo key (Pexels ID or full URL for other sources).
  // This prevents the same stock photo appearing in multiple slots even when
  // different search queries happen to return the same top result.
  const usedKeys = new Set();

  for (const slot of slots) {
    const genPrompt = buildGenerationPrompt({
      slot,
      campaignName,
      offer,
      audience,
      imagePrompts,
      imageQueries,
    });

    if (generator?.configured) {
      try {
        const generated = await generator.generate(genPrompt);
        assigned.push(
          await uploadAssigned({
            bytes: generated.bytes,
            mime: generated.mime,
            ext: generated.ext,
            slug,
            slot,
            supabaseUrl,
            supabaseServiceRoleKey,
            supabaseStorageBucket,
            fetchImpl,
            query: genPrompt,
            source: generated.provider,
            width: GENERATED_IMAGE_WIDTH,
            height: GENERATED_IMAGE_HEIGHT,
            alt: String(imageQueries?.[slot]?.[0] || campaignName || slot).slice(0, 160),
          })
        );
        continue;
      } catch (err) {
        logger(`campaign images: generation failed for slot "${slot}" (${err.message}) — trying stock search`);
      }
    }

    const queries = buildImageQueries({ campaignName, offer, keywords, imageQueries, slot });
    let found = null;
    for (const query of queries) {
      found = await searchOnePhoto(query, { pexelsApiKey, serpApiKey, fetchImpl, logger, pexelsDisabled, usedKeys });
      if (found) break;
    }
    if (!found) {
      logger(`campaign images: no usable photo for slot "${slot}"`);
      continue;
    }
    try {
      const downloaded = await downloadImage(found.url, { fetchImpl });
      if (!downloaded) {
        logger(`campaign images: download failed for slot "${slot}"`);
        continue;
      }
      usedKeys.add(found.key ?? found.url);
      assigned.push(
        await uploadAssigned({
          bytes: downloaded.bytes,
          mime: downloaded.mime,
          ext: downloaded.ext,
          slug,
          slot,
          supabaseUrl,
          supabaseServiceRoleKey,
          supabaseStorageBucket,
          fetchImpl,
          query: found.query,
          source: found.source,
          width: found.width,
          height: found.height,
          alt: found.alt,
        })
      );
    } catch (err) {
      logger(`campaign images: upload failed for slot "${slot}" (${err.message})`);
    }
  }

  return assigned;
}

/**
 * Upload raw image bytes to Supabase Storage for a specific campaign slot.
 * Used by the manual image-upload endpoint in server.mjs.
 *
 * @param {object} p
 * @param {Buffer} p.bytes - raw image bytes
 * @param {string} p.mime - MIME type (image/jpeg, image/png, image/webp)
 * @param {string} p.slug - campaign slug
 * @param {string} p.slot - image slot (hero, details, timeline)
 * @param {string} p.supabaseUrl
 * @param {string} p.supabaseServiceRoleKey
 * @param {string} [p.supabaseStorageBucket]
 * @param {Function} [p.fetchImpl]
 * @returns {Promise<string>} public URL of the uploaded image
 */
export async function uploadManualImage({
  bytes,
  mime,
  slug,
  slot,
  supabaseUrl,
  supabaseServiceRoleKey,
  supabaseStorageBucket = "campaign-images",
  fetchImpl = ipv4Fetch,
}) {
  const mimeInfo = extFromContentType(mime) ?? { ext: "jpg", mime: "image/jpeg" };
  return uploadToSupabase({
    bytes,
    mime: mimeInfo.mime,
    ext: mimeInfo.ext,
    slug,
    slot,
    supabaseUrl,
    supabaseServiceRoleKey,
    supabaseStorageBucket,
    fetchImpl,
  });
}

export function imageForSlot(images, slot) {
  if (!Array.isArray(images)) return null;
  return images.find((img) => img?.slot === slot && typeof img.publicUrl === "string") ?? null;
}
