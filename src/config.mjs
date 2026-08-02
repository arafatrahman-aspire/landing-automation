import { z } from "zod";

/* Loads and validates every env var this service needs, once, at import
 * time — fail loudly on startup rather than lazily mid-run (mirrors the
 * parent project's dbClient() "throw early on missing DATABASE_URL" habit).
 * Every other module reads config from here, never from process.env directly. */

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const intFromEnv = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : def));

const envSchema = z
  .object({
    PORT: intFromEnv(4300),
    API_SHARED_SECRET: z.string().min(16, "API_SHARED_SECRET must be set to a real secret (>=16 chars)"),

    // One-shot stages (research/guide/file-manifest)
    AI_PROVIDER: z.enum(["gemini", "claude"]).default("gemini"),
    // The agentic coding loop — independent of AI_PROVIDER so you can e.g.
    // run research on Gemini and coding on Claude, or both on Gemini while
    // no Anthropic key is available. Swap back to "claude" any time.
    CODING_AGENT_PROVIDER: z.enum(["gemini", "claude"]).default("claude"),

    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
    ANTHROPIC_API_KEY: z.string().optional(),
    CLAUDE_MODEL: z.string().default("claude-sonnet-5"),
    CODING_AGENT_MODEL: z.string().optional(),

    MAX_AGENT_ITERATIONS: intFromEnv(40),
    MAX_CODE_ATTEMPTS: intFromEnv(2),
    // Overrides package-manager auto-detection (packageManager field, then
    // pnpm-lock.yaml/yarn.lock, else npm) for the target repo. Set this when
    // a repo has ambiguous/stale lockfiles (e.g. a leftover yarn.lock next to
    // the package-lock.json it actually uses) and detection picks the wrong
    // tool. Leave unset to keep auto-detecting.
    PACKAGE_MANAGER_OVERRIDE: z.enum(["npm", "yarn", "pnpm"]).optional(),
    // When the target repo has its own root Dockerfile with a `node:` base
    // image, verify install/build runs inside `docker run` against THAT
    // image instead of this service's host Node/npm — sidesteps host/repo
    // version mismatches entirely (auto-detected: on by default, only takes
    // effect when the repo actually has a usable Dockerfile AND docker is
    // reachable; set true to force host-based install/build even then).
    VERIFY_DISABLE_DOCKER: boolFromEnv,
    VERIFY_INSTALL_TIMEOUT_MS: intFromEnv(300_000),
    VERIFY_BUILD_TIMEOUT_MS: intFromEnv(600_000),
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

    // Phase 8 (new_plan.md §4.8) — where a generated preview page's lead
    // form should POST in preview mode. A preview runs the TARGET repo's
    // own server on its own port (preview/sandbox.mjs), a completely
    // separate process from this one, so the generated form can't just
    // fetch a relative path — it needs this service's own externally-
    // reachable base URL. Defaults to localhost at this service's own port,
    // which only works for local dev; set explicitly for any real deployment.
    SERVICE_PUBLIC_BASE_URL: z.string().url().optional(),
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
    env.CODING_AGENT_MODEL || (env.CODING_AGENT_PROVIDER === "gemini" ? env.GEMINI_MODEL : env.CLAUDE_MODEL);

  return {
    port: env.PORT,
    apiSharedSecret: env.API_SHARED_SECRET,

    aiProvider: env.AI_PROVIDER,
    codingAgentProvider: env.CODING_AGENT_PROVIDER,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeModel: env.CLAUDE_MODEL,
    codingAgentModel,

    maxAgentIterations: env.MAX_AGENT_ITERATIONS,
    maxCodeAttempts: env.MAX_CODE_ATTEMPTS,
    packageManagerOverride: env.PACKAGE_MANAGER_OVERRIDE ?? null,
    verifyDisableDocker: env.VERIFY_DISABLE_DOCKER,
    verifyInstallTimeoutMs: env.VERIFY_INSTALL_TIMEOUT_MS,
    verifyBuildTimeoutMs: env.VERIFY_BUILD_TIMEOUT_MS,
    pageUrlPathTemplate: env.PAGE_URL_PATH_TEMPLATE || null,
    verifyServerTimeoutMs: env.VERIFY_SERVER_TIMEOUT_MS,

    previewTtlMs: env.PREVIEW_TTL_MS,
    maxConcurrentPreviews: env.MAX_CONCURRENT_PREVIEWS,
    previewSweepIntervalMs: env.PREVIEW_SWEEP_INTERVAL_MS,

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

    servicePublicBaseUrl: env.SERVICE_PUBLIC_BASE_URL || `http://localhost:${env.PORT}`,
  };
}

/** Resolve the allowlist templates for one run's slug, e.g. "{slug}" -> "spring-sale". */
export function resolveAllowlist(templates, slug) {
  return templates.map((t) => t.replaceAll("{slug}", slug));
}

export const config = loadConfig();
