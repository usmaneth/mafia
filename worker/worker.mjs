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
mkdirSync(jobDir, { recursive: true });

let child;
let heartbeat;
let timeout;
let timedOut = false;
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
  writeStatus({ worktree, branch });
  return worktree;
}

function commandFor(cwd) {
  const model = spec.model;
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
      return ["omp", [
        "--profile", "mafia", "-p", "--mode", "json", "--approval-mode", "yolo",
        "--cwd", cwd, "--no-session", "--no-extensions",
        ...(model ? ["--model", model] : []), spec.prompt,
      ]];
    default:
      throw new Error(`Unsupported harness: ${spec.harness}`);
  }
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
  return (plain || raw).slice(-20000).trim();
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
  writeStatus({ pid: process.pid, startedAt: new Date().toISOString() });
  const cwd = prepareWorkspace();
  const [command, args] = commandFor(cwd);
  writeStatus({ state: "running", command: [command, ...args], heartbeatAt: new Date().toISOString() });
  log(`started ${spec.harness} in ${cwd}`);

  const output = [];
  let outputBytes = 0;
  child = spawn(command, args, {
    cwd,
    env: { ...process.env, MAFIA_JOB_ID: spec.id, MAFIA_PARENT_ID: spec.parentId || "" },
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
      const text = chunk.toString();
      appendFileSync(logPath, text);
      output.push(text);
      outputBytes += text.length;
      while (outputBytes > 500000 && output.length > 1) {
        outputBytes -= output.shift().length;
      }
    });
  }

  heartbeat = setInterval(() => {
    writeStatus({ heartbeatAt: new Date().toISOString() });
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
      completedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
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
