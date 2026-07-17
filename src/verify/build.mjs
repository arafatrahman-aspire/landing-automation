import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

/* Deterministic, non-AI verification of whatever the coding agent wrote —
 * this IS the QA gate (mirrors the parent project's "QA = validation, not
 * AI opinion" philosophy). The LLM never runs commands itself (ai/tools.mjs
 * has no shell-exec tool); this module is the only thing that does.
 *
 * The gate is ECOSYSTEM-AWARE:
 *   - Node repo  (package.json)  -> the repo's own install + build (+ lint).
 *   - Python repo (pyproject.toml/setup.py) -> byte-compile + ruff-lint the
 *     NEWLY created files. We deliberately do NOT run the target repo's full
 *     pytest/uvicorn here: the service only ever adds new, isolated files that
 *     nothing else imports, so a self-contained syntax+lint gate on exactly
 *     those files is the meaningful check — and it can't be defeated by the
 *     repo's own pre-existing test env/config requirements. */

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

const has = (workdir, f) => access(path.join(workdir, f)).then(() => true, () => false);

/**
 * Dispatches to the right ecosystem gate.
 * @param {object} p
 * @param {string} p.workdir
 * @param {number} p.installTimeoutMs
 * @param {number} p.buildTimeoutMs
 * @param {string[]} [p.changedPaths] relative paths the agent created (for the Python gate)
 * @returns {Promise<{ok: boolean, report: string}>}
 */
export async function verifyBuild({ workdir, installTimeoutMs, buildTimeoutMs, changedPaths = [] }) {
  if (await has(workdir, "package.json")) {
    return verifyNode({ workdir, installTimeoutMs, buildTimeoutMs });
  }
  if ((await has(workdir, "pyproject.toml")) || (await has(workdir, "setup.py")) || (await has(workdir, "setup.cfg"))) {
    return verifyPython({ workdir, buildTimeoutMs, changedPaths });
  }
  return {
    ok: false,
    report:
      `No recognizable project manifest at repo root (looked for package.json / pyproject.toml / setup.py). ` +
      `This is a configuration problem, not something a code retry can fix.`,
  };
}

/* ------------------------------- Node ------------------------------- */

export async function detectPackageManager(workdir) {
  if (await has(workdir, "pnpm-lock.yaml")) return "pnpm";
  if (await has(workdir, "yarn.lock")) return "yarn";
  return "npm";
}

const INSTALL_CMD = {
  npm: ["npm", ["ci"]],
  yarn: ["yarn", ["install", "--frozen-lockfile"]],
  pnpm: ["pnpm", ["install", "--frozen-lockfile"]],
};
const RUN_SCRIPT_CMD = {
  npm: (script) => ["npm", ["run", script]],
  yarn: (script) => ["yarn", [script]],
  pnpm: (script) => ["pnpm", [script]],
};

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

/* ------------------------------ Python ------------------------------ */

async function detectPython() {
  for (const cmd of ["python3", "python"]) {
    const r = await runCommand(cmd, ["--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
    if (r.ok) return cmd;
  }
  return null;
}

/** Is `python -m ruff` importable? (installed to user/site or a venv). */
async function ruffAvailable(python, workdir) {
  const r = await runCommand(python, ["-m", "ruff", "--version"], { cwd: workdir, timeoutMs: 15_000 });
  return r.ok;
}

async function verifyPython({ workdir, buildTimeoutMs, changedPaths }) {
  const python = await detectPython();
  if (!python) {
    return { ok: false, report: "No python3/python interpreter found on PATH — cannot verify a Python repo." };
  }

  const pyFiles = (changedPaths ?? []).filter((p) => p.endsWith(".py"));
  if (pyFiles.length === 0) {
    return {
      ok: false,
      report:
        "No .py files were created — a Python feature module must contain at least one Python file " +
        "(the agent should create the router/module under the allowed package path).",
    };
  }

  // 1. Byte-compile — catches syntax errors in exactly the new files (no deps needed).
  const compile = await runCommand(python, ["-m", "py_compile", ...pyFiles], { cwd: workdir, timeoutMs: buildTimeoutMs });
  if (!compile.ok) {
    return {
      ok: false,
      report: `python -m py_compile ${compile.timedOut ? "timed out" : "failed"} (syntax error in a new file):\n${truncateReport(
        compile.stdout + compile.stderr
      )}`,
    };
  }

  // 2. Lint the new files with the target repo's own ruff config (auto-discovered
  //    from its pyproject.toml). Catches undefined names, bad imports, style, etc.
  if (await ruffAvailable(python, workdir)) {
    const lint = await runCommand(python, ["-m", "ruff", "check", ...pyFiles], { cwd: workdir, timeoutMs: buildTimeoutMs });
    if (!lint.ok && !lint.timedOut) {
      return {
        ok: false,
        report: `ruff check failed on the new files (target repo's own lint rules apply):\n${truncateReport(
          lint.stdout + lint.stderr
        )}`,
      };
    }
    if (lint.timedOut) {
      return { ok: false, report: "ruff check timed out." };
    }
    return { ok: true, report: `py_compile + ruff check passed on ${pyFiles.length} new file(s).` };
  }

  return {
    ok: true,
    report: `py_compile passed on ${pyFiles.length} new file(s). (ruff not available — lint skipped.)`,
  };
}
