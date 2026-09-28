import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  buildImageQueries,
  isImageSearchConfigured,
  isImagePipelineConfigured,
  assignCampaignImages,
  searchPexels,
  searchSerpApi,
  imageForSlot,
  ipv4Fetch,
  uploadManualImage,
} from "../src/assets/campaign-images.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9, ...Buffer.alloc(120, 1)]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("buildImageQueries prefers campaign context then slot stock terms", () => {
  const queries = buildImageQueries({
    campaignName: "AI Workflow Automation Masterclass",
    offer: "Learn to automate client work with AI workflows in 6 weeks",
    keywords: ["agency operations"],
    slot: "details",
  });
  assert.ok(queries.includes("AI Workflow Automation Masterclass"));
  assert.ok(queries.includes("agency operations"));
  assert.ok(queries.includes("technology"));
  assert.ok(queries.length >= 3 && queries.length <= 8);
  assert.ok(queries.every((q) => !/no people|no faces/i.test(q)));
});

test("isImageSearchConfigured requires a search key and supabase upload creds", () => {
  assert.equal(isImageSearchConfigured({}), false);
  assert.equal(
    isImageSearchConfigured({ pexelsApiKey: "p", supabaseUrl: "https://x.supabase.co", supabaseServiceRoleKey: "k" }),
    true
  );
  assert.equal(isImageSearchConfigured({ pexelsApiKey: "p" }), false);
  assert.equal(
    isImageSearchConfigured({ serpApiKey: "s", supabaseUrl: "https://x.supabase.co", supabaseServiceRoleKey: "k" }),
    true
  );
});

test("isImagePipelineConfigured accepts a configured generator instead of stock search", () => {
  assert.equal(
    isImagePipelineConfigured({
      supabaseUrl: "https://x.supabase.co",
      supabaseServiceRoleKey: "k",
      imageGenerator: { configured: true },
    }),
    true
  );
  assert.equal(
    isImagePipelineConfigured({
      supabaseUrl: "https://x.supabase.co",
      supabaseServiceRoleKey: "k",
      imageGenerator: { configured: false },
    }),
    false
  );
});

test("assignCampaignImages skips when unconfigured", async () => {
  const logs = [];
  const images = await assignCampaignImages({
    slug: "spring-sale",
    campaignName: "Spring Sale",
    offer: "20% off",
    logger: (m) => logs.push(m),
  });
  assert.deepEqual(images, []);
  assert.ok(logs.some((m) => /not configured/i.test(m)));
});

test("Pexels hit downloads and uploads to Supabase", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET" });
    if (String(url).includes("api.pexels.com")) {
      return jsonResponse({
        photos: [{ width: 800, height: 600, alt: "desk", src: { large: "https://images.pexels.com/photo.jpg" } }],
      });
    }
    if (String(url).includes("images.pexels.com")) {
      return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (String(url).includes("supabase.co/storage")) {
      return jsonResponse({ Key: "ok" });
    }
    return new Response("unexpected", { status: 500 });
  };

  const images = await assignCampaignImages({
    slug: "spring-sale",
    campaignName: "Spring Sale",
    offer: "20% off bundles",
    videoUrl: "https://example.com/video.mp4",
    keywords: ["cybersecurity"],
    pexelsApiKey: "pexels-key",
    supabaseUrl: "https://abc.supabase.co",
    supabaseServiceRoleKey: "service-role",
    fetchImpl,
  });

  assert.ok(images.length >= 1);
  assert.equal(images.every((i) => i.source === "pexels"), true);
  assert.ok(images.every((i) => i.slot !== "hero"), "hero skipped when videoUrl is set");
  assert.match(images[0].publicUrl, /abc\.supabase\.co\/storage\/v1\/object\/public\/campaign-images\/spring-sale\//);
  assert.ok(calls.some((c) => c.url.includes("api.pexels.com")));
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("/storage/v1/object/")));
});

test("empty Pexels result falls back to SerpAPI", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("api.pexels.com")) return jsonResponse({ photos: [] });
    if (String(url).includes("serpapi.com")) {
      return jsonResponse({
        images_results: [{ original: "https://cdn.example.com/pic.png", title: "workspace", original_width: 1024, original_height: 768 }],
      });
    }
    if (String(url).includes("cdn.example.com")) {
      return new Response(JPEG, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (String(url).includes("supabase.co/storage")) return jsonResponse({});
    return new Response("unexpected", { status: 500 });
  };

  const images = await assignCampaignImages({
    slug: "photo-course",
    campaignName: "Photo Course",
    offer: "Weekend workshop",
    pexelsApiKey: "pexels-key",
    serpApiKey: "serp-key",
    supabaseUrl: "https://abc.supabase.co",
    supabaseServiceRoleKey: "service-role",
    fetchImpl,
  });

  assert.ok(images.length >= 1);
  assert.equal(images[0].source, "serpapi");
});

test("a Pexels timeout stops further Pexels calls and uses SerpAPI", async () => {
  let pexelsCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("api.pexels.com")) {
      pexelsCalls += 1;
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    if (String(url).includes("serpapi.com")) {
      return jsonResponse({
        images_results: [{ original: "https://cdn.example.com/pic.png", title: "workspace", original_width: 1024, original_height: 768 }],
      });
    }
    if (String(url).includes("cdn.example.com")) {
      return new Response(JPEG, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (String(url).includes("supabase.co/storage")) return jsonResponse({});
    return new Response("unexpected", { status: 500 });
  };

  const logs = [];
  const images = await assignCampaignImages({
    slug: "timeout-course",
    campaignName: "Timeout Course",
    offer: "Weekend workshop",
    pexelsApiKey: "pexels-key",
    serpApiKey: "serp-key",
    supabaseUrl: "https://abc.supabase.co",
    supabaseServiceRoleKey: "service-role",
    logger: (m) => logs.push(m),
    fetchImpl,
  });

  assert.ok(images.length >= 1);
  assert.equal(images[0].source, "serpapi");
  assert.ok(pexelsCalls <= 3, `expected a few Pexels attempts before SerpAPI, got ${pexelsCalls}`);
  assert.ok(logs.some((m) => /Pexels failed/i.test(m)));
});

test("searchPexels prefers a still-life photo over a portrait alt", async () => {
  const hit = await searchPexels("office", "key", {
    fetchImpl: async () =>
      jsonResponse({
        photos: [
          { width: 1, height: 1, alt: "Portrait of a woman at a desk", src: { large: "https://images.pexels.com/person.jpg" } },
          { width: 800, height: 600, alt: "Empty office interior", src: { large: "https://images.pexels.com/office.jpg" } },
        ],
      }),
  });
  assert.equal(hit.url, "https://images.pexels.com/office.jpg");
  assert.equal(hit.alt, "Empty office interior");
});

test("searchPexels returns null on empty photos", async () => {
  const hit = await searchPexels("office", "key", {
    fetchImpl: async () => jsonResponse({ photos: [] }),
  });
  assert.equal(hit, null);
});

test("searchSerpApi returns the first original URL", async () => {
  const hit = await searchSerpApi("office", "key", {
    fetchImpl: async () =>
      jsonResponse({ images_results: [{ original: "https://img.example/a.jpg", title: "A", original_width: 10, original_height: 10 }] }),
  });
  assert.equal(hit.url, "https://img.example/a.jpg");
  assert.equal(hit.alt, "A");
});

test("ipv4Fetch GETs JSON over an IPv4 socket", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const res = await ipv4Fetch(`http://127.0.0.1:${port}/pexels`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.path, "/pexels");
  } finally {
    server.close();
  }
});

test("imageForSlot picks the matching assignment", () => {
  const images = [
    { slot: "details", publicUrl: "https://x/d.jpg" },
    { slot: "timeline", publicUrl: "https://x/t.jpg" },
  ];
  assert.equal(imageForSlot(images, "timeline").publicUrl, "https://x/t.jpg");
  assert.equal(imageForSlot(images, "hero"), null);
});

test("successful generation uploads without calling Pexels", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET" });
    if (String(url).includes("supabase.co/storage")) return jsonResponse({ Key: "ok" });
    return new Response("unexpected", { status: 500 });
  };
  const imageGenerator = {
    configured: true,
    async generate() {
      return { bytes: JPEG, mime: "image/jpeg", ext: "jpg", provider: "cloudflare" };
    },
  };

  const images = await assignCampaignImages({
    slug: "gen-course",
    campaignName: "Generated Course",
    offer: "Weekend workshop",
    videoUrl: "https://example.com/video.mp4",
    supabaseUrl: "https://abc.supabase.co",
    supabaseServiceRoleKey: "service-role",
    imageGenerator,
    fetchImpl,
  });

  assert.ok(images.length >= 1);
  assert.equal(images.every((i) => i.source === "cloudflare"), true);
  assert.ok(images.every((i) => i.slot !== "hero"));
  assert.ok(calls.every((c) => !c.url.includes("api.pexels.com")));
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("/storage/v1/object/")));
});

test("failed generation falls back to Pexels", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(String(url));
    if (String(url).includes("api.pexels.com")) {
      return jsonResponse({
        photos: [{ width: 800, height: 600, alt: "desk", src: { large: "https://images.pexels.com/photo.jpg" } }],
      });
    }
    if (String(url).includes("images.pexels.com")) {
      return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (String(url).includes("supabase.co/storage")) return jsonResponse({ Key: "ok" });
    return new Response("unexpected", { status: 500 });
  };
  const logs = [];
  const images = await assignCampaignImages({
    slug: "fallback-course",
    campaignName: "Fallback Course",
    offer: "Weekend workshop",
    videoUrl: "https://example.com/video.mp4",
    pexelsApiKey: "pexels-key",
    supabaseUrl: "https://abc.supabase.co",
    supabaseServiceRoleKey: "service-role",
    imageGenerator: {
      configured: true,
      async generate() {
        throw new Error("All image generators failed. Last error: boom");
      },
    },
    logger: (m) => logs.push(m),
    fetchImpl,
  });

  assert.ok(images.length >= 1);
  assert.equal(images[0].source, "pexels");
  assert.ok(calls.some((u) => u.includes("api.pexels.com")));
  assert.ok(logs.some((m) => /generation failed/i.test(m)));
});


test("manual image upload explains an unresolvable storage project without exposing credentials", async () => {
  await assert.rejects(uploadManualImage({
    bytes: JPEG, mime: "image/jpeg", slug: "test", slot: "hero",
    supabaseUrl: "https://missing-project.supabase.co", supabaseServiceRoleKey: "private-service-key",
    fetchImpl: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); },
  }), (error) => {
    assert.match(error.message, /Cannot resolve the image storage host/);
    assert.match(error.message, /SUPABASE_URL/);
    assert.doesNotMatch(error.message, /private-service-key/);
    return true;
  });
});
