/**
 * One-shot script: re-generates campaign images for a specific run using
 * LLM-suggested visual prompts (AI generation first, Pexels/SerpAPI fallback).
 *
 * Usage:
 *   node --env-file=.env dev/refresh-campaign-images.mjs [runId]
 *
 * If runId is omitted, lists the most recent 10 runs so you can pick one.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { assignCampaignImages } from "../src/assets/campaign-images.mjs";
import { buildImageGenEnv } from "../src/assets/image-gen/fallback-generator.mjs";

const DB_PATH = path.resolve(process.env.DB_PATH || "./data/campaigns.db");
const db = new DatabaseSync(DB_PATH);

// ── helpers ────────────────────────────────────────────────────────────────

function getRun(runId) {
  return db
    .prepare(
      `SELECT r.run_id, c.slug, c.campaign_name, c.brief_json, r.research_notes_json, r.status
       FROM runs r JOIN campaigns c USING(run_id)
       WHERE r.run_id = ?`
    )
    .get(runId);
}

function listRuns() {
  return db
    .prepare(
      `SELECT r.run_id, c.slug, c.campaign_name, r.status, r.research_notes_json
       FROM runs r JOIN campaigns c USING(run_id)
       ORDER BY r.created_at DESC LIMIT 10`
    )
    .all();
}

function saveResearchNotes(runId, notes) {
  db.prepare("UPDATE runs SET research_notes_json = ?, updated_at = ? WHERE run_id = ?").run(
    JSON.stringify(notes),
    new Date().toISOString(),
    runId
  );
}

async function geminiGenerateImageQueries(campaignName, offer, audience, brief, currentKeywords) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const prompt =
    `You are helping create images for a marketing landing page.\n` +
    `Campaign: ${campaignName}\n` +
    `Offer: ${offer}\n` +
    `Audience: ${audience}\n` +
    `Brief: ${brief || "(none)"}\n` +
    `Research keywords: ${(currentKeywords || []).slice(0, 8).join(", ")}\n\n` +
    `Return a JSON object with generation prompts AND Pexels-friendly search queries for three image slots.\n` +
    `Rules:\n` +
    `- imagePrompts: ONE 1-2 sentence photorealistic visual description per slot\n` +
    `- imageQueries: SHORT (2-4 word) stock-photo search phrases (3 per slot) used only if generation fails\n` +
    `- Do NOT use brand names, acronyms or jargon (not "Splunk", "SIEM", "SOC" — instead use\n` +
    `  what those LOOK like: "security analyst workstation", "cybersecurity dashboard", etc.)\n` +
    `- No people, faces, logos, watermarks, or readable text in the image\n` +
    `- hero: the aspiration / outcome this campaign delivers\n` +
    `- details: the skill, tool or specific benefit being offered\n` +
    `- timeline: the learning process or progression\n\n` +
    `Return ONLY valid JSON, no prose:\n` +
    `{\n` +
    `  "imagePrompts": {\n` +
    `    "hero": "one or two sentences",\n` +
    `    "details": "one or two sentences",\n` +
    `    "timeline": "one or two sentences"\n` +
    `  },\n` +
    `  "imageQueries": {\n` +
    `    "hero": ["query 1", "query 2", "query 3"],\n` +
    `    "details": ["query 1", "query 2", "query 3"],\n` +
    `    "timeline": ["query 1", "query 2", "query 3"]\n` +
    `  }\n` +
    `}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  // Strip markdown fences if present
  const fenced = text.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

// ── main ───────────────────────────────────────────────────────────────────

const targetRunId = process.argv[2];

if (!targetRunId) {
  console.log("\nRecent runs (pass a run_id to refresh its images):\n");
  for (const r of listRuns()) {
    const notes = r.research_notes_json ? JSON.parse(r.research_notes_json) : null;
    const imgs = notes?.images?.length ?? 0;
    const hasIQ = !!notes?.imageQueries;
    const hasIP = !!notes?.imagePrompts;
    console.log(`  ${r.run_id}  ${r.slug}  [${r.status}]  images=${imgs}  llm-queries=${hasIQ}  llm-prompts=${hasIP}`);
  }
  console.log("\nUsage: node --env-file=.env dev/refresh-campaign-images.mjs <runId>\n");
  process.exit(0);
}

const row = getRun(targetRunId);
if (!row) {
  console.error(`Run ${targetRunId} not found.`);
  process.exit(1);
}

const brief = row.brief_json ? JSON.parse(row.brief_json) : {};
const currentNotes = row.research_notes_json ? JSON.parse(row.research_notes_json) : {};

console.log(`\nRefreshing images for: "${row.campaign_name}" (${row.slug})`);
console.log(`Current images: ${currentNotes.images?.length ?? 0}`);

// Step 1 — Ask Gemini for visual prompts + stock queries
console.log("\n[1/3] Generating visual image prompts via Gemini...");
let imageQueries;
let imagePrompts;
try {
  const generated = await geminiGenerateImageQueries(
    row.campaign_name,
    brief.offer || "",
    brief.audience || "",
    brief.brief || "",
    currentNotes.keywords
  );
  imageQueries = generated.imageQueries ?? generated;
  imagePrompts = generated.imagePrompts ?? null;
  console.log("      imagePrompts:", JSON.stringify(imagePrompts, null, 6));
  console.log("      imageQueries:", JSON.stringify(imageQueries, null, 6));
} catch (err) {
  console.error("      Gemini failed:", err.message);
  process.exit(1);
}

// Step 2 — Generate (then stock-search fallback) + upload
console.log("\n[2/3] Generating images (stock search fallback) and uploading to Supabase...");
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("      SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot upload images.");
  process.exit(1);
}

const imageGenEnv = buildImageGenEnv(process.env);
const newImages = await assignCampaignImages({
  slug: row.slug,
  campaignName: row.campaign_name,
  offer: brief.offer || "",
  audience: brief.audience || "",
  videoUrl: brief.videoUrl || null,
  keywords: currentNotes.keywords || [],
  imageQueries,
  imagePrompts,
  pexelsApiKey: process.env.PEXELS_API_KEY || null,
  serpApiKey: process.env.SERPAPI_API_KEY || null,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET || "campaign-images",
  imageGenEnv,
  logger: (msg) => console.log(`      ${msg}`),
});

if (newImages.length === 0) {
  console.error("      No images returned — check API keys and network.");
  process.exit(1);
}

console.log(`\n      Got ${newImages.length} image(s):`);
for (const img of newImages) {
  console.log(`        ${img.slot}: [${img.source}] "${img.query}" → ${img.publicUrl}`);
}

// Step 3 — Persist to DB
console.log("\n[3/3] Saving to database...");
const updatedNotes = { ...currentNotes, images: newImages, imageQueries, ...(imagePrompts ? { imagePrompts } : {}) };
saveResearchNotes(targetRunId, updatedNotes);
console.log("      Done. Refresh the review UI to see the new images.\n");
