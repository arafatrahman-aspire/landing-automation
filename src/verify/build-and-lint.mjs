import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { has, findPackageJsonDir, detectPackageManager, INSTALL_CMD, RUN_SCRIPT_CMD } from "./detect-package-manager.mjs";
import { hasDocker, parseDockerBuildStage, verifyBuildInDocker } from "./docker-build.mjs";
import { cleanEnvForChildProcess } from "../spawn-env.mjs";

/* Deterministic, non-AI verification of whatever the coding agent wrote —
 * this IS the QA gate. The LLM never runs commands itself (llm/filesystem-tools.mjs has
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
    const child = spawn(cmd, args, { cwd, env: cleanEnvForChildProcess() });
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

/* Next.js compiles in jest-worker child processes connected over IPC. If one
 * of them speaks a message shape jest-worker doesn't recognise, the parent
 * crashes and exits WITHOUT printing anything the workers had found:
 *
 *   uncaughtException TypeError: Unexpected response from worker: undefined
 *     at ChildProcessWorker._onMessage (…/next/dist/compiled/jest-worker/…)
 *
 * The known cause is `WATCH_REPORT_DEPENDENCIES`, inherited from running this
 * service under `node --watch` — spawn-env.mjs has the full story and strips it
 * from every child we start, so this should no longer be reachable that way.
 * The annotation stays because the symptom is generic: any worker that dies or
 * misbehaves produces the same content-free report, and a reader who hits it
 * should not have to rediscover from scratch that the stack trace into Next's
 * own bundle is not a defect in any source file. */
const WORKER_CRASH_RE = /Unexpected response from worker: undefined|jest-worker/;

function annotateWorkerCrash(report) {
  if (!WORKER_CRASH_RE.test(report)) return report;
  return (
    `${report}\n\n` +
    `NOTE — this is a build INFRASTRUCTURE failure, not a defect in any source file.\n` +
    `Next.js compiles in child worker processes and pipes their output back to the parent over IPC. The\n` +
    `parent crashed on a message it could not parse, so the real compile errors (if there were any) were\n` +
    `never printed. Causes seen in practice, in order of likelihood:\n` +
    `  1. A stray WATCH_REPORT_DEPENDENCIES in the environment (set by 'node --watch', i.e. 'npm run dev').\n` +
    `     It makes every Node child report its module loads over the same IPC channel jest-worker uses.\n` +
    `     This service strips it from spawned children (src/spawn-env.mjs) — check it isn't set elsewhere.\n` +
    `  2. A worker OOM-killed under memory pressure.\n` +
    `To see what the build actually says, run it by hand in the run's workdir:\n` +
    `  cd <workdir> && npm run build`
  );
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
 * @param {string|null} [p.packageManagerOverride] see package-manager.mjs's detectPackageManager
 * @param {boolean} [p.disableDocker] skip the Docker path even if the repo has a usable Dockerfile
 * @returns {Promise<{ok: boolean, report: string}>}
 */
export async function verifyBuild({
  workdir,
  installTimeoutMs,
  buildTimeoutMs,
  changedPaths = [],
  packageManagerOverride = null,
  disableDocker = false,
}) {
  const pkgDir = await findPackageJsonDir(workdir);
  if (pkgDir) {
    if (!disableDocker) {
      const dockerStage = await parseDockerBuildStage(pkgDir);
      if (dockerStage && (await hasDocker())) {
        return verifyNodeInDocker({ pkgDir, dockerStage, installTimeoutMs, buildTimeoutMs });
      }
    }
    return verifyNode({ workdir: pkgDir, installTimeoutMs, buildTimeoutMs, packageManagerOverride });
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

async function readPackageScripts(pkgDir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
    return pkg.scripts ?? {};
  } catch {
    return null;
  }
}

/** Reuses the target repo's OWN Dockerfile (its declared Node base image +
 *  first-stage RUN commands, e.g. `npm install --force && npm run build`)
 *  instead of guessing a package manager and install flags — see
 *  docker-build.mjs for why. Runs an additional `npm run lint` inside the
 *  same image afterward if package.json declares one and the Dockerfile
 *  itself didn't already run it, so Docker-verified repos get the same
 *  lint gate as host-verified ones. */
async function verifyNodeInDocker({ pkgDir, dockerStage, installTimeoutMs, buildTimeoutMs }) {
  const scripts = await readPackageScripts(pkgDir);
  if (!scripts?.build) {
    return {
      ok: false,
      report: `Target repo's package.json has no "build" script — this is a configuration problem, not something a code retry can fix.`,
    };
  }

  const build = await verifyBuildInDocker({ workdir: pkgDir, ...dockerStage, installTimeoutMs, buildTimeoutMs });
  if (!build.ok) return build;

  const dockerfileAlreadyLints = dockerStage.commands.some((cmd) => /\bnpm\s+run\s+lint\b/.test(cmd));
  if (scripts.lint && !dockerfileAlreadyLints) {
    const lint = await verifyBuildInDocker({
      workdir: pkgDir,
      nodeImage: dockerStage.nodeImage,
      commands: ["npm run lint"],
      installTimeoutMs: 0,
      buildTimeoutMs,
    });
    if (!lint.ok) {
      if (isNextEslintToolingMismatch(lint.report)) {
        return {
          ok: true,
          report:
            `${build.report}. Lint skipped: target repo's \`next lint\` is broken under ESLint 9 ` +
            `(Invalid Options: useEslintrc/extensions — Next 14 + ESLint 9 tooling mismatch, not generated code).`,
        };
      }
      return { ok: false, report: `${build.report}\n\nlint failed (gates the PR — target repo's own lint rules apply):\n${lint.report}` };
    }
  }

  return { ok: true, report: `${build.report}${scripts.lint ? " (+ lint passed)" : ""}` };
}

async function verifyNode({ workdir, installTimeoutMs, buildTimeoutMs, packageManagerOverride = null }) {
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

  const pm = await detectPackageManager(workdir, packageManagerOverride);
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
      report: annotateWorkerCrash(`${pm} run build ${build.timedOut ? "timed out" : "failed"}:\n${truncateReport(build.stdout + build.stderr)}`),
    };
  }

  if (scripts.lint) {
    const [lintCmd, lintArgs] = RUN_SCRIPT_CMD[pm]("lint");
    const lint = await runCommand(lintCmd, lintArgs, { cwd: workdir, timeoutMs: buildTimeoutMs });
    if (!lint.ok) {
      const lintOutput = truncateReport(lint.stdout + lint.stderr);
      // Target repo pairs Next 14's `next lint` with ESLint 9 — next lint still
      // passes removed ESLint-8 options (useEslintrc, extensions, …) and exits
      // non-zero before any rule runs. Regenerating campaign sections cannot
      // fix that; treating it as a codegen failure burned three retries every run.
      if (isNextEslintToolingMismatch(lintOutput)) {
        return {
          ok: true,
          report:
            `${pm} install + build passed. Lint skipped: target repo's \`next lint\` is broken under ESLint 9 ` +
            `(Invalid Options: useEslintrc/extensions — a Next 14 + ESLint 9 tooling mismatch, not a defect in ` +
            `generated campaign files). Fix the target repo (pin eslint@8 or upgrade Next) to re-enable lint.`,
        };
      }
      return {
        ok: false,
        report: `${pm} run lint failed (gates the PR — target repo's own lint rules apply):\n${lintOutput}`,
      };
    }
  }

  return { ok: true, report: `${pm} install + build${scripts.lint ? " + lint" : ""} passed.` };
}

/** True when `next lint` died on the known Next 14 + ESLint 9 options mismatch
 *  rather than on any project source rule violation. */
export function isNextEslintToolingMismatch(output) {
  if (typeof output !== "string") return false;
  return (
    /Invalid Options/i.test(output) &&
    /useEslintrc/i.test(output) &&
    /extensions/i.test(output)
  );
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
