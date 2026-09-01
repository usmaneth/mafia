#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: node worker.mjs <job-spec.json>");
  process.exit(2);
}

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const jobDir = join(spec.stateRoot, "jobs", spec.id);
const statusPath = join(jobDir, "status.json");
const logPath = join(jobDir, "output.log");
const resultPath = join(jobDir, "result.txt");
const controlPath = join(jobDir, "control.jsonl");
const auditPath = join(spec.stateRoot, "events", "audit.jsonl");
mkdirSync(jobDir, { recursive: true });
mkdirSync(dirname(auditPath), { recursive: true });

let child;
let heartbeat;
let timeout;
let timedOut = false;
let paused = false;
let controlOffset = 0;
let firstOutputAt;
let usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  requests: 0,
  failures: 0,
  runtimeSeconds: 0,
};
let status = {
  ...spec,
  state: "starting",
  updatedAt: new Date().toISOString(),
  logPath,
};

function writeStatus(patch = {}) {
  status = { ...status, ...patch, updatedAt: new Date().toISOString() };
  const temp = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(temp, statusPath);
}

function log(message) {
  appendFileSync(logPath, `[mafia ${new Date().toISOString()}] ${message}\n`);
}

function event(type, data = {}) {
  const value = {
    id: `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    teamId: spec.pipelineId,
    jobId: spec.id,
    host: spec.host,
    actor: spec.id,
    type,
    data,
    createdAt: new Date().toISOString(),
  };
  appendFileSync(auditPath, `${JSON.stringify(value)}\n`);
}

function detectedHarnessModel() {
  const home = homedir();
  try {
    if (spec.harness === "codex") {
      const path = join(home, ".codex", "config.toml");
      if (!existsSync(path)) return undefined;
      return readFileSync(path, "utf8").match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1];
    }
    if (spec.harness === "claude") {
      const path = join(home, ".claude", "settings.json");
      if (!existsSync(path)) return undefined;
      const model = JSON.parse(readFileSync(path, "utf8"))?.model;
      return typeof model === "string" ? model.replace(/\[[^\]]+\]$/, "").trim() : undefined;
    }
    if (spec.harness === "cline") {
      const path = join(home, ".cline", "data", "settings", "providers.json");
      if (!existsSync(path)) return undefined;
      const providers = JSON.parse(readFileSync(path, "utf8"))?.providers;
      return providers?.cline?.settings?.model ?? providers?.["cline-pass"]?.settings?.model;
    }
    if (spec.harness === "omp") {
      // Ask OMP rather than reading its config file. A regex for `default:`
      // matches the first one anywhere in the YAML, not the one under
      // `modelRoles`, so any new section above it silently returned the wrong
      // model. This file runs under plain Node, so a subprocess is the way in.
      const result = spawnSync("omp", ["--profile", "mafia", "config", "get", "modelRoles", "--json"], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (result.status !== 0) return undefined;
      const value = JSON.parse(result.stdout)?.value?.default;
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    }
  } catch {}
  return undefined;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout.trim();
}

function prepareWorkspace() {
  const requested = spec.repo || spec.cwd || process.cwd();
  if (!spec.isolate || !existsSync(join(requested, ".git"))) return requested;

  const root = git(["rev-parse", "--show-toplevel"], requested);
  const repoName = basename(root);
  const worktree = join(spec.stateRoot, "worktrees", repoName, spec.id);
  const branch = `mafia/${spec.id}`;
  mkdirSync(dirname(worktree), { recursive: true });
  git(["worktree", "add", "-b", branch, worktree, spec.baseRef || "HEAD"], root);
  if (spec.workspacePatchPath && existsSync(spec.workspacePatchPath)) {
    const result = spawnSync("git", ["apply", "--binary", spec.workspacePatchPath], {
      cwd: worktree,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "Cannot apply the workspace patch.").trim());
    }
  }
  if (spec.workspaceArchivePath && existsSync(spec.workspaceArchivePath)) {
    const result = spawnSync("tar", ["-xf", spec.workspaceArchivePath, "-C", worktree], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "Cannot unpack the workspace files.").trim());
    }
  }
  writeStatus({ worktree, branch });
  return worktree;
}

function commandFor(cwd) {
  const model = spec.modelSource === "detected" ? undefined : spec.model;
  switch (spec.harness) {
    case "claude":
      return ["claude", [
        "-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "bypassPermissions",
        "--effort", "high", "--no-session-persistence", ...(model ? ["--model", model] : []), spec.prompt,
      ]];
    case "codex":
      return ["codex", [
        "exec", "--json", "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "-C", cwd,
        ...(model ? ["--model", model] : []), spec.prompt,
      ]];
    case "kimi":
      return ["kimi", [
        "--prompt", spec.prompt, "--output-format", "stream-json",
        ...(model ? ["--model", model] : []),
      ]];
    case "cline":
      return ["cline", [
        "--json", "--auto-approve", "true", "--thinking", "high", "--cwd", cwd,
        ...(model ? ["--model", model] : []), spec.prompt,
      ]];
    case "opencode":
      return ["opencode", [
        "run", "--format", "json", "--auto", "--dir", cwd, "--variant", "high",
        ...(model ? ["--model", model] : []), spec.prompt,
      ]];
    case "omp":
      if (model?.startsWith("ollama/")) {
        return ["node", [
          join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ollama-agent.mjs"),
          "--model", model, "--cwd", cwd, "--prompt", spec.prompt,
        ]];
      }
      return ["omp", [
        "--profile", "mafia", "-p", "--mode", "json", "--approval-mode", "yolo",
        "--cwd", cwd, ...(spec.session ? [] : ["--no-session"]), "--no-extensions",
        // Let OMP stop itself first. Its own limit ends the session cleanly and
        // the agent still writes a result; the worker's timer below is the
        // backstop that kills the process group when that does not happen.
        ...(spec.timeoutSeconds ? ["--max-time", String(Math.max(30, spec.timeoutSeconds - 15))] : []),
        // The lead works these out from live provider quota and puts them in
        // the spec, because this file runs under plain Node and cannot.
        ...roleArgs(spec.roleModels),
        ...(spec.prewalk ? ["--prewalk"] : []),
        ...(spec.prewalkInto ? ["--prewalk-into", spec.prewalkInto] : []),
        ...(model ? ["--model", model] : []), spec.prompt,
      ]];
    default:
      throw new Error(`Unsupported harness: ${spec.harness}`);
  }
}

/** OMP accepts smol, slow, and plan as model-role overrides. */
function roleArgs(roles) {
  if (!roles || typeof roles !== "object") return [];
  return ["smol", "slow", "plan"].flatMap((role) =>
    typeof roles[role] === "string" && roles[role] ? [`--${role}`, roles[role]] : []);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || part.type === "output_text"))
    .map((part) => part.text || part.content || "")
    .filter(Boolean)
    .join("\n");
}

function servedModel(event) {
  const value = event?.message?.model
    ?? event?.item?.model
    ?? event?.response?.model
    ?? event?.model;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractResult(raw) {
  let result = "";
  for (const line of raw.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "result" && typeof event.result === "string") result = event.result;
    if (event.item?.type === "agent_message" && typeof event.item.text === "string") result = event.item.text;
    if (event.message?.role === "assistant") {
      const text = contentText(event.message.content);
      if (text) result = text;
    }
    if (event.type === "assistant" && event.message) {
      const text = contentText(event.message.content);
      if (text) result = text;
    }
    if (event.part?.type === "text" && typeof event.part.text === "string") result = event.part.text;
    if (event.type === "run_result" && typeof event.text === "string") result = event.text;
  }
  if (result.trim()) return result.trim();
  const plain = raw.split("\n").filter((line) => line.trim() && !line.trim().startsWith("{")).join("\n");
  if (plain) return plain.slice(-20000).trim();
  // Only transport records remain, so the agent never produced a message. An
  // empty result is the truth; the raw stream tail would masquerade as one -
  // three jobs carried OMP's session header as their "result" this way.
  return "";
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function collectUsage(value) {
  if (!value || typeof value !== "object") return;
  const source = value.usage && typeof value.usage === "object" ? value.usage : value;
  const input = numeric(source.input_tokens ?? source.inputTokens ?? source.prompt_tokens ?? source.promptTokens ?? source.input);
  const output = numeric(source.output_tokens ?? source.outputTokens ?? source.completion_tokens ?? source.completionTokens ?? source.output);
  const cacheRead = numeric(source.cache_read_tokens ?? source.cacheReadTokens ?? source.cached_input_tokens ?? source.cacheRead);
  const cacheWrite = numeric(source.cache_write_tokens ?? source.cacheWriteTokens ?? source.cacheWrite);
  const cost = numeric(
    source.cost_usd ?? source.costUsd ?? source.total_cost_usd ?? source.totalCostUsd ??
    (source.cost && typeof source.cost === "object" ? source.cost.total : undefined),
  );
  usage.inputTokens = Math.max(usage.inputTokens, input);
  usage.outputTokens = Math.max(usage.outputTokens, output);
  usage.cacheReadTokens = Math.max(usage.cacheReadTokens, cacheRead);
  usage.cacheWriteTokens = Math.max(usage.cacheWriteTokens, cacheWrite);
  usage.costUsd = Math.max(usage.costUsd, cost);
  if (input || output || cost) usage.requests = Math.max(1, usage.requests);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectUsage(child);
  }
}

function consumeControl() {
  if (!existsSync(controlPath) || !child?.pid) return;
  const raw = readFileSync(controlPath, "utf8");
  const addition = raw.slice(controlOffset);
  controlOffset = raw.length;
  for (const line of addition.split("\n").filter(Boolean)) {
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    const action = String(command.type || "").replace("control.", "");
    if (action === "pause" && !paused) {
      try {
        process.kill(-child.pid, "SIGSTOP");
        paused = true;
        writeStatus({ pausedAt: new Date().toISOString() });
        event("worker.paused");
      } catch {}
    } else if (action === "resume" && paused) {
      try {
        process.kill(-child.pid, "SIGCONT");
        paused = false;
        writeStatus({ pausedAt: undefined });
        event("worker.resumed");
      } catch {}
    } else if (action === "stop" || action === "cancel") {
      stop(`control.${action}`);
    } else if (action === "redirect") {
      log("received a redirect message; the harness must read its Mafia inbox");
      event("worker.redirected", command.data || {});
    }
  }
}

function stop(signal) {
  log(`received ${signal}`);
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  clearInterval(heartbeat);
  clearTimeout(timeout);
  writeStatus({ state: "cancelled", completedAt: new Date().toISOString() });
  process.exit(143);
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

try {
  if (spec.modelSource === "detected") {
    const model = detectedHarnessModel();
    if (model) {
      spec.model = model;
      writeStatus({ model, modelSource: "detected" });
    }
  }
  writeStatus({ pid: process.pid, startedAt: new Date().toISOString() });
  const cwd = prepareWorkspace();
  if (spec.contextPackPath && existsSync(spec.contextPackPath)) {
    spec.prompt = `${spec.prompt}\n\nRead this Mafia context pack before work:\n${spec.contextPackPath}`;
  }
  const [command, args] = commandFor(cwd);
  writeStatus({ state: "running", command: [command, ...args], heartbeatAt: new Date().toISOString() });
  log(`started ${spec.harness} in ${cwd}`);
  event("worker.started", { harness: spec.harness, model: spec.model, cwd });

  const output = [];
  let outputBytes = 0;
  let observedModel = spec.model;
  let hasObservedModel = false;
  child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      MAFIA_JOB_ID: spec.id,
      MAFIA_PARENT_ID: spec.parentId || "",
      MAFIA_TEAM_ID: spec.pipelineId || "",
      MAFIA_TASK_ID: spec.taskId || "",
      MAFIA_HOST: spec.host,
      MAFIA_STATE_ROOT: spec.stateRoot,
      MAFIA_ROOM: spec.pipelineId ? `team:${spec.pipelineId}` : "mafia",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  timeout = setTimeout(() => {
    timedOut = true;
    log(`timed out after ${spec.timeoutSeconds} seconds`);
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }, spec.timeoutSeconds * 1000);

  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      if (!firstOutputAt) firstOutputAt = Date.now();
      const text = chunk.toString();
      appendFileSync(logPath, text);
      for (const line of text.split("\n")) {
        try {
          const payload = JSON.parse(line);
          collectUsage(payload);
          const model = servedModel(payload);
          if (model && (!hasObservedModel || model !== observedModel)) {
            observedModel = model;
            hasObservedModel = true;
            writeStatus({ model, modelSource: "observed" });
            event("worker.model", { model });
          }
        } catch {}
      }
      output.push(text);
      outputBytes += text.length;
      while (outputBytes > 500000 && output.length > 1) {
        outputBytes -= output.shift().length;
      }
    });
  }

  heartbeat = setInterval(() => {
    writeStatus({ heartbeatAt: new Date().toISOString() });
    consumeControl();
    event("presence.heartbeat", { pid: process.pid, paused });
  }, 5000);

  child.on("error", (error) => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    log(error.stack || error.message);
    writeStatus({
      state: "failed",
      error: error.message,
      completedAt: new Date().toISOString(),
    });
    process.exitCode = 1;
  });

  child.on("close", (code, signal) => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    const result = extractResult(output.join(""));
    writeFileSync(resultPath, result);
    const succeeded = code === 0 && !timedOut;
    const completedAt = new Date().toISOString();
    usage.runtimeSeconds = Math.max(0, (new Date(completedAt).getTime() - new Date(status.startedAt).getTime()) / 1000);
    usage.failures = succeeded ? 0 : 1;
    if (firstOutputAt) usage.ttftMs = firstOutputAt - new Date(status.startedAt).getTime();
    let gitSummary;
    try {
      gitSummary = git(["status", "--short"], cwd);
    } catch {}
    writeStatus({
      state: succeeded ? "succeeded" : "failed",
      exitCode: code ?? 1,
      error: succeeded
        ? undefined
        : timedOut
          ? `The worker timed out after ${spec.timeoutSeconds} seconds.`
          : `Harness exited with ${code ?? signal ?? "unknown"}.`,
      result,
      gitSummary,
      usage,
      completedAt,
      heartbeatAt: new Date().toISOString(),
    });
    event(succeeded ? "worker.succeeded" : "worker.failed", { exitCode: code, usage, gitSummary });
    log(`finished with exit code ${code ?? "unknown"}`);
    process.exitCode = code ?? 1;
  });
} catch (error) {
  clearInterval(heartbeat);
  clearTimeout(timeout);
  const message = error instanceof Error ? error.message : String(error);
  log(message);
  writeStatus({
    state: "failed",
    error: message,
    completedAt: new Date().toISOString(),
  });
  process.exitCode = 1;
}
