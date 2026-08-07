/* config.mjs validates and freezes process.env into `config` the moment
 * it's first imported (by anything, transitively) — so any test touching a
 * module that reaches config.mjs (directly or via state/database-connection.mjs) must call
 * this BEFORE that first import, not after. Node's test runner gives each
 * test file its own process, so setting process.env here doesn't leak
 * between unrelated test files. */
export function setTestConfigEnv(overrides = {}) {
  process.env.API_SHARED_SECRET ??= "x".repeat(20);
  process.env.AI_PROVIDER ??= "gemini";
  process.env.GEMINI_API_KEY ??= "unused";
  process.env.CODING_AGENT_PROVIDER ??= "gemini";
  process.env.GITHUB_TARGET_OWNER ??= "owner";
  process.env.GITHUB_TARGET_REPO ??= "repo";
  process.env.WRITE_PATH_ALLOWLIST ??= "app/campaigns/{slug}/";
  process.env.DRY_RUN_NO_PR ??= "true";
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}
