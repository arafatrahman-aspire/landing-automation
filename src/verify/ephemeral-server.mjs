import { spawn } from "node:child_process";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { detectPackageManager, RUN_SCRIPT_CMD } from "./detect-package-manager.mjs";

/* Ephemeral (not DB-tracked, not long-lived) build-and-serve primitive used
 * ONLY internally by one verify() call, to give hero-fit/seo-lint/a11y-lint
 * something real to load in a headless browser. This is deliberately
 * simple, not the longer-lived preview sandbox from a later phase:
 * OS-assigned port, no manual port-range bookkeeping, always torn down by
 * the caller. Relies on the target repo's serve script honoring the PORT
 * env var (true for `next start`, `vite preview`, plain Express apps,
 * etc.) — if a repo's serve script hardcodes its own port instead, this
 * will time out with a clear error rather than silently checking the wrong
 * port; that's a real, documented limitation, not a bug to work around. */

export const SERVE_SCRIPT_PREFERENCE = ["start", "preview", "dev"];

/** Exported for reuse by preview/preview-server.mjs (Phase 4) — the longer-lived
 *  preview sandbox needs the exact same "find a free OS port"/"poll until
 *  something answers" primitives, just with a different process lifecycle
 *  (DB-tracked, outlives the request that started it) wrapped around them. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true; // anything non-5xx means a server IS answering
    } catch {
      /* not up yet, or still starting — keep polling */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Starts the target repo's own serve command on a free local port.
 * @param {object} p
 * @param {string} p.workdir - directory containing package.json (already built)
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{ok:true, baseUrl:string, stop:()=>Promise<void>} | {ok:false, report:string}>}
 */
export async function startEphemeral({ workdir, timeoutMs = 30_000, packageManagerOverride = null }) {
  let scripts;
  try {
    const pkg = JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8"));
    scripts = pkg.scripts ?? {};
  } catch {
    return { ok: false, report: `No readable package.json in ${workdir}.` };
  }

  const scriptName = SERVE_SCRIPT_PREFERENCE.find((s) => scripts[s]);
  if (!scriptName) {
    return {
      ok: false,
      report:
        `No "${SERVE_SCRIPT_PREFERENCE.join('"/"')}" script found in package.json — cannot serve the page ` +
        `to check its rendered layout/SEO/accessibility.`,
    };
  }

  const pm = await detectPackageManager(workdir, packageManagerOverride);
  const port = await getFreePort();
  const [cmd, args] = RUN_SCRIPT_CMD[pm](scriptName);
  // detached so the child is its own process-group leader — `npm run <script>`
  // forks the actual server as a SEPARATE process from the "npm" wrapper, so
  // killing just the wrapper's pid leaves the real server running forever
  // (a real leaked-process bug, not just a test-cleanup nicety). Killing the
  // whole group (negative pid) reaches it too.
  const child = spawn(cmd, args, { cwd: workdir, env: { ...process.env, PORT: String(port) }, detached: true });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  function killGroup(signal) {
    if (exited || !child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal); // group already gone, or this platform doesn't support it — fall back
    }
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const ready = await waitForReady(baseUrl, timeoutMs);

  if (!ready || exited) {
    killGroup("SIGKILL");
    return {
      ok: false,
      report:
        `Server did not respond at ${baseUrl} within ${timeoutMs}ms (tried "${pm} run ${scriptName}"). ` +
        `Either the script doesn't honor the PORT env var, or it failed to start:\n${stderr.slice(-2000)}`,
    };
  }

  return {
    ok: true,
    baseUrl,
    async stop() {
      if (exited) return;
      killGroup("SIGTERM");
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 3000);
      });
      killGroup("SIGKILL"); // in case SIGTERM didn't land on every process in the group
    },
  };
}
