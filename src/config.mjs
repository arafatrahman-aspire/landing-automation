import { z } from "zod";
import { buildImageGenEnv } from "./assets/image-gen/fallback-generator.mjs";

/* Loads and validates every env var this service needs, once, at import
 * time — fail loudly on startup rather than lazily mid-run (mirrors the
 * parent project's dbClient() "throw early on missing DATABASE_URL" habit).
 * Every other module reads config from here, never from process.env directly. */

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

// Same shape, opposite default: unset means ON. For flags where the safe,
// boring behaviour is the enabled one and turning it OFF is the deliberate
// opt-in (see VERIFY_DISABLE_DOCKER).
const boolFromEnvDefaultTrue = z
  .string()
  .optional()
  .transform((v) => v === undefined || v === "" || !(v === "false" || v === "0"));

const intFromEnv = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : def));

const envSchema = z
  .object({
    PORT: intFromEnv(4300),

    // One-shot stages (research/guide/file-manifest)
    AI_PROVIDER: z.enum(["gemini", "claude", "omniroute"]).default("gemini"),
    // The agentic coding loop — independent of AI_PROVIDER so you can e.g.
    // run research on Gemini and coding on Claude, or both on Gemini while
    // no Anthropic key is available. Swap back to "claude" any time.
    CODING_AGENT_PROVIDER: z.enum(["gemini", "claude", "omniroute"]).default("claude"),

    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
    ANTHROPIC_API_KEY: z.string().optional(),
    CLAUDE_MODEL: z.string().default("claude-sonnet-5"),
    CODING_AGENT_MODEL: z.string().optional(),

    // Local OmniRoute gateway (OpenAI-compatible). Used when AI_PROVIDER or
    // CODING_AGENT_PROVIDER is "omniroute". Key is optional — a default local
    // install accepts unauthenticated /v1/chat/completions.
    OMNIROUTE_BASE_URL: z.string().default("http://localhost:20128/v1"),
    OMNIROUTE_API_KEY: z.string().optional(),
    // `auto` lets the gateway pick; its free pool (Felo / OpenCode) often 400/401.
    // Pin a model id that works in the OmniRoute dashboard for this pipeline.
    OMNIROUTE_MODEL: z.string().default("auto"),

    // Pause after the AI plans the page and BEFORE any section is generated,
    // so a human can edit the hero copy, SEO tags and section list first.
    // Steering here is free; every change after generation costs another LLM
    // run. Overridable per campaign via the brief's `reviewPlan` field —
    // unset there falls back to this.
    REVIEW_PLAN_BEFORE_GENERATING: boolFromEnvDefaultTrue,

    MAX_AGENT_ITERATIONS: intFromEnv(40),
    MAX_CODE_ATTEMPTS: intFromEnv(3),
    // Overrides package-manager auto-detection (packageManager field, then
    // pnpm-lock.yaml/yarn.lock, else npm) for the target repo. Set this when
    // a repo has ambiguous/stale lockfiles (e.g. a leftover yarn.lock next to
    // the package-lock.json it actually uses) and detection picks the wrong
    // tool. Leave unset to keep auto-detecting.
    PACKAGE_MANAGER_OVERRIDE: z.enum(["npm", "yarn", "pnpm"]).optional(),
    // Docker is OFF by default (v0.32). Verify and preview both run the
    // target repo's own `npm ci` / `npm run build` / `npm run start` directly
    // on this host.
    //
    // It used to be the other way around: when the target repo had a root
    // Dockerfile with a `node:` base image, verify built inside `docker run`
    // against that image, so the build matched the repo's declared Node
    // version instead of whatever this host happens to have. That reasoning
    // is still sound, but in practice the container path was the single
    // largest source of failed runs — image pulls, bind-mount permissions,
    // and containers outliving the process that spawned them (which then
    // held open file handles inside a worktree we were trying to delete).
    // Host npm is slower to get wrong and far easier to debug: the same
    // command you'd type yourself, in a directory you can `cd` into.
    //
    // Set VERIFY_DISABLE_DOCKER=false to put the container path back — it
    // still only engages when the repo really has a usable Dockerfile AND
    // docker is reachable.
    VERIFY_DISABLE_DOCKER: boolFromEnvDefaultTrue,
    VERIFY_INSTALL_TIMEOUT_MS: intFromEnv(300_000),
    VERIFY_BUILD_TIMEOUT_MS: intFromEnv(600_000),
    // Per-check opt-outs for the two browser-driven Layer-1 checks — set to
    // "false" to stop a specific check from ever failing a run (it's simply
    // not run, same as when no browser is available; not the same as it
    // silently passing). Independent of each other and of seo-lint, which has
    // no such flag since it hasn't needed one.
    ENABLE_HERO_FIT_CHECK: boolFromEnvDefaultTrue,
    ENABLE_A11Y_CHECK: boolFromEnvDefaultTrue,
    // How the layout/SEO/a11y checks reach the new page once it's served —
    // e.g. "/campaigns/{slug}" for Next.js app-router. Framework routing
    // conventions vary too much to derive this automatically (and for a
    // repo like Laravel, where the page isn't wired into routing at all
    // yet, there's nothing to derive) — same "human sets the boundary"
    // philosophy as WRITE_PATH_ALLOWLIST. Leave unset to skip these checks
    // entirely (build/lint still runs) until it's been configured.
    PAGE_URL_PATH_TEMPLATE: z.string().optional(),
    VERIFY_SERVER_TIMEOUT_MS: intFromEnv(30_000),

    // How long a preview sandbox (Phase 4) stays up after a successful
    // run before the idle sweep tears it down, in the absence of an
    // explicit stop. 30 minutes is enough for one human to actually look
    // at it without leaving servers running indefinitely by default.
    PREVIEW_TTL_MS: intFromEnv(30 * 60_000),
    // Soft cap on simultaneously-running previews — the oldest is stopped
    // to make room for a new one past this, not refused outright.
    MAX_CONCURRENT_PREVIEWS: intFromEnv(3),
    // How often the idle-preview sweep runs.
    PREVIEW_SWEEP_INTERVAL_MS: intFromEnv(60_000),
    // Remote hosting: one public port that routes <token>.<PREVIEW_PUBLIC_HOST>
    // to each preview (src/preview/preview-gateway.mjs). Unset = off, and
    // previews stay loopback-only, which is all local development needs.
    PREVIEW_GATEWAY_PORT: intFromEnv(null),
    PREVIEW_GATEWAY_HOST: z.string().default("0.0.0.0"),

    // --- Target repo ---
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_TARGET_OWNER: z.string().min(1, "GITHUB_TARGET_OWNER is required"),
    GITHUB_TARGET_REPO: z.string().min(1, "GITHUB_TARGET_REPO is required"),
    GITHUB_BASE_BRANCH: z.string().default("main"),
    GITHUB_API_URL: z.string().url().default("https://api.github.com"),
    // Overrides the constructed https://github.com/{owner}/{repo}.git URL —
    // for pointing at a local `git init --bare` fixture during safe testing.
    TARGET_REPO_CLONE_URL: z.string().optional(),
    // Skips the real GitHub PR API call (clone/code/verify/commit/push still
    // run for real) — lets the whole pipeline run against a local fixture
    // without touching any real repository's main branch.
    DRY_RUN_NO_PR: boolFromEnv,

    WRITE_PATH_ALLOWLIST: z.string().min(1, "WRITE_PATH_ALLOWLIST is required — set it after reviewing the target repo's structure"),

    GIT_AUTHOR_NAME: z.string().default("Landing Page Codegen Bot"),
    GIT_AUTHOR_EMAIL: z.string().default("codegen-bot@example.com"),

    DB_PATH: z.string().default("./data/campaigns.db"),
    WORKDIR_ROOT: z.string().default("./data/.scratch"),
    KEEP_WORKDIR_ON_FAILURE: boolFromEnv,

    SKIP_RESEARCH: boolFromEnv,

    // Escape hatch: when verify still fails after every retry, stage and
    // preview the draft anyway instead of ending the run as
    // failed_verification. The run is marked verifyBypassed and surfaces a
    // loud warning in the review UI — the page is NOT known to build, so
    // approving it can open a PR with code that doesn't compile. Off by
    // default; intended as a temporary unblock while generation quality is
    // still being tuned, not a normal operating mode.
    CONTINUE_ON_VERIFY_FAILURE: boolFromEnv,

    // Crash resume: on boot, re-drive runs that a previous process lifetime
    // left mid-generation, reusing their persisted research/content plan
    // (pipeline/resume-interrupted-runs.mjs). Runs already inside the
    // commit/push/PR sequence are never auto-resumed regardless of this
    // setting. Set to "false" to go back to marking interrupted runs failed.
    RESUME_INTERRUPTED_RUNS: z
      .string()
      .optional()
      .transform((v) => v !== "false" && v !== "0"),

    // Phase 8 (new_plan.md §4.8) — where a generated preview page's lead
    // form should POST in preview mode. A preview runs the TARGET repo's
    // own server on its own port (preview/preview-server.mjs), a completely
    // separate process from this one, so the generated form can't just
    // fetch a relative path — it needs this service's own externally-
    // reachable base URL. Defaults to localhost at this service's own port,
    // which only works for local dev; set explicitly for any real deployment.
    SERVICE_PUBLIC_BASE_URL: z.string().url().optional(),

    // Campaign images (optional). Missing any required piece skips image
    // generation/search/upload and the campaign still generates with dummy
    // frame assets. Generation providers are skipped individually when their
    // keys are absent; Pexels then SerpAPI remain the stock fallback.
    IMAGE_GENERATOR_ORDER: z.string().default("cloudflare,nanobanana,leonardo,promptgone,journey"),
    CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
    CLOUDFLARE_API_TOKEN: z.string().optional(),
    CLOUDFLARE_MODEL: z.string().default("@cf/black-forest-labs/flux-1-schnell"),
    CLOUDFLARE_BASE_URL: z.string().default("https://api.cloudflare.com/client/v4"),
    GOOGLE_API_KEY: z.string().optional(),
    NANO_BANANA_MODEL: z.string().default("gemini-2.5-flash-image"),
    LEONARDO_API_KEY: z.string().optional(),
    LEONARDO_BASE_URL: z.string().default("https://cloud.leonardo.ai/api/rest/v1"),
    PROMPTGONE_API_KEY: z.string().optional(),
    PROMPTGONE_APP_KEY: z.string().optional(),
    PROMPTGONE_MODEL: z.string().default("flux"),
    PROMPTGONE_BASE_URL: z.string().default("https://api.promptgone.ai"),
    JOURNEY_API_KEY: z.string().optional(),
    JOURNEY_MODEL: z.string().default("flux"),
    JOURNEY_BASE_URL: z.string().default("https://api.journeyapi.io"),
    PEXELS_API_KEY: z.string().optional(),
    SERPAPI_API_KEY: z.string().optional(),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SUPABASE_STORAGE_BUCKET: z.string().default("campaign-images"),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["GEMINI_API_KEY"], message: "required when AI_PROVIDER=gemini" });
    }
    if (env.AI_PROVIDER === "claude" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "required when AI_PROVIDER=claude" });
    }
    if (env.CODING_AGENT_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["GEMINI_API_KEY"], message: "required when CODING_AGENT_PROVIDER=gemini" });
    }
    if (env.CODING_AGENT_PROVIDER === "claude" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "required when CODING_AGENT_PROVIDER=claude" });
    }
    if ((env.AI_PROVIDER === "omniroute" || env.CODING_AGENT_PROVIDER === "omniroute") && !String(env.OMNIROUTE_BASE_URL || "").trim()) {
      ctx.addIssue({ code: "custom", path: ["OMNIROUTE_BASE_URL"], message: "required when a provider is omniroute" });
    }
    if (!env.DRY_RUN_NO_PR && !env.GITHUB_TOKEN) {
      ctx.addIssue({ code: "custom", path: ["GITHUB_TOKEN"], message: "required unless DRY_RUN_NO_PR=true" });
    }
  });

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid configuration — fix .env:\n${issues}`);
    process.exit(1);
  }
  const env = result.data;
  const codingAgentModel =
    env.CODING_AGENT_MODEL ||
    (env.CODING_AGENT_PROVIDER === "gemini"
      ? env.GEMINI_MODEL
      : env.CODING_AGENT_PROVIDER === "omniroute"
        ? env.OMNIROUTE_MODEL
        : env.CLAUDE_MODEL);

  return {
    port: env.PORT,

    aiProvider: env.AI_PROVIDER,
    codingAgentProvider: env.CODING_AGENT_PROVIDER,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeModel: env.CLAUDE_MODEL,
    codingAgentModel,
    omnirouteBaseUrl: env.OMNIROUTE_BASE_URL,
    omnirouteApiKey: env.OMNIROUTE_API_KEY || null,
    omnirouteModel: env.OMNIROUTE_MODEL,

    maxAgentIterations: env.MAX_AGENT_ITERATIONS,
    maxCodeAttempts: env.MAX_CODE_ATTEMPTS,
    reviewPlanBeforeGenerating: env.REVIEW_PLAN_BEFORE_GENERATING,
    packageManagerOverride: env.PACKAGE_MANAGER_OVERRIDE ?? null,
    verifyDisableDocker: env.VERIFY_DISABLE_DOCKER,
    verifyInstallTimeoutMs: env.VERIFY_INSTALL_TIMEOUT_MS,
    verifyBuildTimeoutMs: env.VERIFY_BUILD_TIMEOUT_MS,
    enableHeroFitCheck: env.ENABLE_HERO_FIT_CHECK,
    enableA11yCheck: env.ENABLE_A11Y_CHECK,
    pageUrlPathTemplate: env.PAGE_URL_PATH_TEMPLATE || null,
    verifyServerTimeoutMs: env.VERIFY_SERVER_TIMEOUT_MS,

    previewTtlMs: env.PREVIEW_TTL_MS,
    maxConcurrentPreviews: env.MAX_CONCURRENT_PREVIEWS,
    previewSweepIntervalMs: env.PREVIEW_SWEEP_INTERVAL_MS,
    previewGatewayPort: env.PREVIEW_GATEWAY_PORT,
    previewGatewayHost: env.PREVIEW_GATEWAY_HOST,

    github: {
      token: env.GITHUB_TOKEN,
      owner: env.GITHUB_TARGET_OWNER,
      repo: env.GITHUB_TARGET_REPO,
      baseBranch: env.GITHUB_BASE_BRANCH,
      apiUrl: env.GITHUB_API_URL,
      cloneUrl: env.TARGET_REPO_CLONE_URL || `https://github.com/${env.GITHUB_TARGET_OWNER}/${env.GITHUB_TARGET_REPO}.git`,
    },
    dryRunNoPr: env.DRY_RUN_NO_PR,

    // ["app/campaigns/{slug}/", "components/campaigns/{slug}/"]
    writePathAllowlistTemplates: env.WRITE_PATH_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean),

    gitAuthorName: env.GIT_AUTHOR_NAME,
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL,

    dbPath: env.DB_PATH,
    workdirRoot: env.WORKDIR_ROOT,
    keepWorkdirOnFailure: env.KEEP_WORKDIR_ON_FAILURE,

    skipResearch: env.SKIP_RESEARCH,
    continueOnVerifyFailure: env.CONTINUE_ON_VERIFY_FAILURE,
    resumeInterruptedRuns: env.RESUME_INTERRUPTED_RUNS,

    servicePublicBaseUrl: env.SERVICE_PUBLIC_BASE_URL || `http://localhost:${env.PORT}`,

    pexelsApiKey: env.PEXELS_API_KEY || null,
    serpApiKey: env.SERPAPI_API_KEY || null,
    supabaseUrl: env.SUPABASE_URL || null,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || null,
    supabaseStorageBucket: env.SUPABASE_STORAGE_BUCKET,
    imageGen: buildImageGenEnv(env),
  };
}

/** Resolve the allowlist templates for one run's slug, e.g. "{slug}" -> "spring-sale". */
export function resolveAllowlist(templates, slug) {
  return templates.map((t) => t.replaceAll("{slug}", slug));
}

export const config = loadConfig();
