import { readdir, readFile as fsReadFile, stat, mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";

/* The agentic coding loop's ENTIRE interface to the filesystem. This is the
 * safety-critical file in the whole service: the LLM can only do what these
 * functions allow, and write_file is guarded by FOUR independent checks
 * (see resolveWritePath) — no single misconfiguration can let it touch an
 * existing file. There is deliberately no shell-exec tool here at all;
 * build/lint verification is a separate, deterministic step the orchestrator
 * runs itself (verify/build-and-lint.mjs), never something the LLM can invoke. */

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".mp4", ".webp", ".otf",
]);
const MAX_READ_BYTES = 60_000;

/** Containment check shared by list/read/write — resolves relPath under
 *  workdir and rejects anything that would escape it (absolute paths, `..`). */
function resolveContainedPath(workdir, relPath) {
  const rootAbs = path.resolve(workdir);
  const targetAbs = path.resolve(rootAbs, relPath ?? ".");
  const relative = path.relative(rootAbs, targetAbs);
  const contained = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return {
    contained,
    absolutePath: targetAbs,
    relativePath: relative.split(path.sep).join("/"), // posix-style, for comparing against stored path sets
  };
}

/**
 * PURE guard for write_file — no I/O, fully unit-testable
 * (test/write-tool-allowlist.test.mjs) against fabricated sets.
 *
 * Order matters: traversal (security) -> pristine (never touch what existed
 * before this run) -> allowlist (human-set boundary) -> manifest (must match
 * the declared plan). Each layer is independent; a hole in one doesn't
 * defeat the others.
 *
 * @returns {{ok:true, absolutePath:string, relativePath:string} |
 *           {ok:false, reason:string, message:string}}
 */
export function resolveWritePath({ requestedPath, workdir, allowedPrefixes, pristineFiles, writtenByAgent, manifestPaths }) {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
    return { ok: false, reason: "path_traversal", message: "path must be a non-empty string" };
  }
  if (path.isAbsolute(requestedPath)) {
    return { ok: false, reason: "path_traversal", message: `absolute paths are not allowed: "${requestedPath}"` };
  }

  const { contained, absolutePath, relativePath } = resolveContainedPath(workdir, requestedPath);
  if (!contained || relativePath === "") {
    return { ok: false, reason: "path_traversal", message: `path escapes the repository: "${requestedPath}"` };
  }

  // Never overwrite anything that existed before this run started — unconditional,
  // regardless of allowlist/manifest, UNLESS the agent itself wrote it earlier
  // in this same run (so it can iterate on its own new files across turns/retries).
  if (pristineFiles?.has(relativePath) && !writtenByAgent?.has(relativePath)) {
    return {
      ok: false,
      reason: "already_exists",
      message: `"${relativePath}" existed before this run — the agent may only create NEW files, never modify existing ones.`,
    };
  }

  const inAllowlist = (allowedPrefixes ?? []).some((prefix) => relativePath.startsWith(prefix));
  if (!inAllowlist) {
    return {
      ok: false,
      reason: "outside_allowlist",
      message: `"${relativePath}" is outside the allowed paths (${(allowedPrefixes ?? []).join(", ")}).`,
    };
  }

  if (manifestPaths && manifestPaths.size > 0 && !manifestPaths.has(relativePath)) {
    return {
      ok: false,
      reason: "not_in_manifest",
      message: `"${relativePath}" was not declared in the file plan. Only write files listed there — call list_files/read_file to re-check the plan, or stick to: ${[...manifestPaths].join(", ")}`,
    };
  }

  return { ok: true, absolutePath, relativePath };
}

async function walk(workdir, relDir, depth, maxDepth, out) {
  const { absolutePath, contained } = resolveContainedPath(workdir, relDir);
  if (!contained) return;
  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const rel = relDir === "." ? entry.name : `${relDir}/${entry.name}`;
    out.push({ path: rel, type: entry.isDirectory() ? "dir" : "file" });
    if (entry.isDirectory() && depth < maxDepth) {
      await walk(workdir, rel, depth + 1, maxDepth, out);
    }
  }
}

async function listFilesImpl({ workdir, path: relPath = ".", recursive = false, maxDepth = 2 }) {
  const { contained, absolutePath } = resolveContainedPath(workdir, relPath);
  if (!contained) return { ok: false, message: `path escapes the repository: "${relPath}"` };
  const s = await stat(absolutePath).catch(() => null);
  if (!s || !s.isDirectory()) return { ok: false, message: `"${relPath}" is not a directory` };

  const out = [];
  await walk(workdir, relPath === "." ? "." : relPath, 1, recursive ? maxDepth : 1, out);
  return { ok: true, entries: out };
}

async function readFileImpl({ workdir, path: relPath }) {
  const { contained, absolutePath, relativePath } = resolveContainedPath(workdir, relPath);
  if (!contained) return { ok: false, message: `path escapes the repository: "${relPath}"` };
  if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return { ok: true, content: `[binary file omitted: ${relativePath}]` };
  }
  const s = await stat(absolutePath).catch(() => null);
  if (!s) return { ok: false, message: `"${relPath}" does not exist` };
  if (!s.isFile()) return { ok: false, message: `"${relPath}" is not a file` };

  const buf = await fsReadFile(absolutePath);
  const truncated = buf.length > MAX_READ_BYTES;
  const content = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
  return { ok: true, content: truncated ? `${content}\n\n[... truncated, file is ${buf.length} bytes]` : content };
}

/** Anthropic Messages API tool schemas (ai/claude-agent.mjs). */
export const TOOL_DEFINITIONS = [
  {
    name: "list_files",
    description:
      "List files and directories under a path in the target repository (relative to repo root). Use this to explore the repo's structure and find conventions to follow.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Relative path, e.g. "." or "src/components".' },
        recursive: { type: "boolean", description: "Recurse into subdirectories (default false)." },
        maxDepth: { type: "integer", description: "Max recursion depth when recursive=true (default 2)." },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a text file's contents from the target repository, by relative path.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a NEW file in the target repository at a relative path. Only paths matching the declared file plan, inside the allowed new-campaign directory, are accepted — existing files can never be overwritten with this tool.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "finish_coding",
    description: "Call this when all planned files have been created and you are done. Ends the session.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string", description: "Short summary of what was created, for the PR description." } },
      required: ["summary"],
    },
  },
];

/**
 * Creates a stateful executor bound to one run's workdir/guardrails.
 * `writtenByAgent` is tracked internally so the agent may revise files it
 * created earlier in the same run (e.g. after a verify-failure retry).
 */
export function createToolExecutor({ workdir, allowedPrefixes, pristineFiles, manifestPaths, logger }) {
  const writtenByAgent = new Set();

  async function execute(name, input) {
    if (name === "list_files") {
      const result = await listFilesImpl({ workdir, ...input });
      logger?.(`list_files(${input.path ?? "."}) -> ${result.ok ? `${result.entries.length} entries` : result.message}`);
      return result;
    }
    if (name === "read_file") {
      const result = await readFileImpl({ workdir, path: input.path });
      logger?.(`read_file(${input.path}) -> ${result.ok ? `${result.content.length} chars` : result.message}`);
      return result;
    }
    if (name === "write_file") {
      const check = resolveWritePath({
        requestedPath: input.path,
        workdir,
        allowedPrefixes,
        pristineFiles,
        writtenByAgent,
        manifestPaths,
      });
      if (!check.ok) {
        logger?.(`write_file(${input.path}) REJECTED [${check.reason}] ${check.message}`);
        return { ok: false, reason: check.reason, message: check.message };
      }
      await mkdir(path.dirname(check.absolutePath), { recursive: true });
      await fsWriteFile(check.absolutePath, input.content ?? "");
      writtenByAgent.add(check.relativePath);
      logger?.(`write_file(${check.relativePath}) OK (${(input.content ?? "").length} chars)`);
      return { ok: true, path: check.relativePath };
    }
    throw new Error(`Unknown tool "${name}"`);
  }

  return { execute, getWrittenFiles: () => new Set(writtenByAgent) };
}
