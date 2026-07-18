import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { has, findPackageJsonDir, detectPackageManager, INSTALL_CMD, RUN_SCRIPT_CMD } from "./package-manager.mjs";

/* Deterministic, non-AI verification of whatever the coding agent wrote —
 * this IS the QA gate. The LLM never runs commands itself (ai/tools.mjs has
 * no shell-exec tool); this module is the only thing that does.
 *
 * The specific TARGET REPO this service points at is not fixed — different
 * campaigns may land in a Next.js repo today and a Laravel/PHP repo
 * tomorrow, so this gate is ECOSYSTEM-AWARE rather than Node-only:
 *   - Node repo   (package.json, at root or one level down for a monorepo/
 *     asset subdirectory) -> the repo's own install + build (+ lint).
 *   - PHP/Laravel repo (composer.json, no package.json anywhere reachable)
 *     -> `php -l` syntax-lint exactly the newly created .php files. We don't
 *     boot a full Laravel app (routes/service providers/DB) here — the
 *     agent's page is additive and isolated, so a syntax gate on exactly
 *     what it wrote is the meaningful, dependency-free check. */

const REPORT_LINE_LIMIT = 200;

function runCommand(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: stderr + `\n${err.message}`, timedOut: false, spawnError: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}

function truncateReport(text) {
  const lines = text.split("\n");
  if (lines.length <= REPORT_LINE_LIMIT) return text;
  return `... (truncated, showing last ${REPORT_LINE_LIMIT} lines)\n` + lines.slice(-REPORT_LINE_LIMIT).join("\n");
}

/**
 * @param {object} p
 * @param {string} p.workdir
 * @param {number} p.installTimeoutMs
 * @param {number} p.buildTimeoutMs
 * @param {string[]} [p.changedPaths] relative paths the agent created (used by the PHP gate)
 * @returns {Promise<{ok: boolean, report: string}>}
 */
export async function verifyBuild({ workdir, installTimeoutMs, buildTimeoutMs, changedPaths = [] }) {
  const pkgDir = await findPackageJsonDir(workdir);
  if (pkgDir) {
    return verifyNode({ workdir: pkgDir, installTimeoutMs, buildTimeoutMs });
  }
  if (await has(workdir, "composer.json")) {
    return verifyPhp({ workdir, buildTimeoutMs, changedPaths });
  }
  return {
    ok: false,
    report:
      `No package.json (root or one level down) and no composer.json found — this repo's ` +
      `stack isn't recognized. This is a configuration problem, not something a code retry can fix.`,
  };
}

/* ------------------------------- Node ------------------------------- */

export { detectPackageManager };

async function verifyNode({ workdir, installTimeoutMs, buildTimeoutMs }) {
  const pkgPath = path.join(workdir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    return { ok: false, report: `No readable package.json at repo root (${pkgPath}) — monorepos are out of scope for v1.` };
  }
  const scripts = pkg.scripts ?? {};
  if (!scripts.build) {
    return {
      ok: false,
      report: `Target repo's package.json has no "build" script — this is a configuration problem, not something a code retry can fix.`,
    };
  }

  const pm = await detectPackageManager(workdir);
  const [installCmd, installArgs] = INSTALL_CMD[pm];

  const install = await runCommand(installCmd, installArgs, { cwd: workdir, timeoutMs: installTimeoutMs });
  if (!install.ok) {
    return {
      ok: false,
      report: `${pm} install ${install.timedOut ? "timed out" : "failed"}:\n${truncateReport(install.stdout + install.stderr)}`,
    };
  }

  const [buildCmd, buildArgs] = RUN_SCRIPT_CMD[pm]("build");
  const build = await runCommand(buildCmd, buildArgs, { cwd: workdir, timeoutMs: buildTimeoutMs });
  if (!build.ok) {
    return {
      ok: false,
      report: `${pm} run build ${build.timedOut ? "timed out" : "failed"}:\n${truncateReport(build.stdout + build.stderr)}`,
    };
  }

  if (scripts.lint) {
    const [lintCmd, lintArgs] = RUN_SCRIPT_CMD[pm]("lint");
    const lint = await runCommand(lintCmd, lintArgs, { cwd: workdir, timeoutMs: buildTimeoutMs });
    if (!lint.ok) {
      return {
        ok: false,
        report: `${pm} run lint failed (gates the PR — target repo's own lint rules apply):\n${truncateReport(lint.stdout + lint.stderr)}`,
      };
    }
  }

  return { ok: true, report: `${pm} install + build${scripts.lint ? " + lint" : ""} passed.` };
}

/* ------------------------------ PHP / Laravel ------------------------------ */

async function detectPhp() {
  const r = await runCommand("php", ["-v"], { cwd: process.cwd(), timeoutMs: 10_000 });
  return r.ok;
}

async function verifyPhp({ workdir, buildTimeoutMs, changedPaths }) {
  // .blade.php files are Blade templates, not plain PHP (directives like @extends/{{ }}
  // aren't valid PHP syntax on their own — Laravel compiles them at runtime) — only
  // lint genuine .php files (controllers/classes), never .blade.php templates.
  const phpFiles = (changedPaths ?? []).filter((p) => p.endsWith(".php") && !p.endsWith(".blade.php"));
  if (phpFiles.length === 0) {
    return {
      ok: true,
      report:
        "No plain .php files were created — nothing for the PHP syntax gate to check " +
        "(the page may be entirely Blade templates/assets, which this gate doesn't lint).",
    };
  }

  if (!(await detectPhp())) {
    return { ok: false, report: "No `php` interpreter found on PATH — cannot verify a PHP/Laravel repo." };
  }

  for (const file of phpFiles) {
    const lint = await runCommand("php", ["-l", file], { cwd: workdir, timeoutMs: buildTimeoutMs });
    if (!lint.ok) {
      return {
        ok: false,
        report: `php -l failed on "${file}" (syntax error):\n${truncateReport(lint.stdout + lint.stderr)}`,
      };
    }
  }

  return { ok: true, report: `php -l passed on ${phpFiles.length} new file(s).` };
}
