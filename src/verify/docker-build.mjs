import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

/* A target repo's own Dockerfile is a stronger "how do I actually build
 * this" signal than whatever Node/npm happens to be installed on this
 * service's host — a real run failed repeatedly because the host's npm was
 * a much newer major version than what the target repo's Dockerfile
 * declares (node:14.18.2), and installing under the "wrong" npm risks
 * behaving differently than the project's real, working build (different
 * peer-dependency resolution, lockfile format assumptions, etc. — npm's
 * install behavior changed a lot between major versions). When a repo ships
 * a Dockerfile, this reuses ITS declared base image and RUN steps verbatim
 * instead of re-deriving an install command from lockfile detection. */

const REPORT_LINE_LIMIT = 200;

function truncateReport(text) {
  const lines = text.split("\n");
  if (lines.length <= REPORT_LINE_LIMIT) return text;
  return `... (truncated, showing last ${REPORT_LINE_LIMIT} lines)\n` + lines.slice(-REPORT_LINE_LIMIT).join("\n");
}

function runCommand(cmd, args, { cwd, timeoutMs, onTimeout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout?.();
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: stderr + `\n${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}

/** Is the `docker` CLI usable (daemon actually reachable), not just present
 *  on PATH? Probed fresh each call — cheap relative to an install+build,
 *  and a daemon can go down between runs. */
export async function hasDocker() {
  const result = await runCommand("docker", ["info"], { timeoutMs: 10_000 });
  return result.ok;
}

/** Parses the target repo's root Dockerfile, if any: the base image of the
 *  FIRST build stage (ignoring later stages like `FROM nginx:latest` used
 *  only for serving) and the `RUN` commands within that first stage only
 *  (COPY/WORKDIR lines are irrelevant here — the whole worktree is already
 *  bind-mounted in, so there's nothing to copy). Returns null if there's no
 *  Dockerfile, or its first stage isn't a `node:` image (nothing safe to
 *  reuse — falls back to host-based install/build in that case). */
export async function parseDockerBuildStage(workdir) {
  let content;
  try {
    content = await readFile(path.join(workdir, "Dockerfile"), "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  const fromIndices = lines.reduce((acc, line, i) => (/^\s*FROM\s+/i.test(line) ? [...acc, i] : acc), []);
  if (fromIndices.length === 0) return null;

  const stageStart = fromIndices[0];
  const stageEnd = fromIndices.length > 1 ? fromIndices[1] : lines.length;
  const nodeImageMatch = lines[stageStart].match(/^\s*FROM\s+(node:\S+)/i);
  if (!nodeImageMatch) return null;

  const commands = [];
  for (let i = stageStart + 1; i < stageEnd; i++) {
    const runMatch = lines[i].match(/^\s*RUN\s+(.+)$/i);
    if (runMatch) commands.push(runMatch[1].trim());
  }
  if (commands.length === 0) return null;

  return { nodeImage: nodeImageMatch[1], commands };
}

/** Runs the parsed first-stage RUN commands (e.g. `npm install --force`,
 *  `npm run build`) inside a throwaway `docker run` against the repo's own
 *  declared Node image, bind-mounting the worktree directly as /app.
 *
 *  `--user` matches the current host uid:gid so files Docker writes into
 *  the bind-mounted workdir (node_modules, build/) come out owned by the
 *  same user this process runs as, not root — otherwise the later `git
 *  worktree remove` cleanup would fail to delete them. A unique
 *  `--name` lets a timeout `docker kill` the container directly instead of
 *  just killing the local `docker run` CLI process, which wouldn't
 *  necessarily stop it server-side and could leak a running container. */
export async function verifyBuildInDocker({ workdir, nodeImage, commands, installTimeoutMs, buildTimeoutMs }) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  const userArgs = uid != null && gid != null ? ["--user", `${uid}:${gid}`] : [];
  const containerName = `codegen-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const script = commands.join(" && ");

  const result = await runCommand(
    "docker",
    ["run", "--rm", "--name", containerName, ...userArgs, "-v", `${path.resolve(workdir)}:/app`, "-w", "/app", nodeImage, "sh", "-c", script],
    {
      timeoutMs: installTimeoutMs + buildTimeoutMs,
      onTimeout: () => runCommand("docker", ["kill", containerName], { timeoutMs: 10_000 }),
    }
  );

  if (!result.ok) {
    return {
      ok: false,
      report: `docker run (${nodeImage}) [${script}] ${result.timedOut ? "timed out" : "failed"}:\n${truncateReport(result.stdout + result.stderr)}`,
    };
  }
  return { ok: true, report: `docker run (${nodeImage}): ${script} — passed.` };
}
