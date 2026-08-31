/**
 * Record what each OMP subagent is doing, so a viewer can show more than a name
 * and an elapsed time.
 *
 * OMP loads extensions and hooks into the subagents it spawns, so this file
 * runs once inside every one of them. Each writes its own small status file;
 * nothing coordinates, and a crashed subagent simply stops updating.
 *
 * `HookContext` carries the model the subagent resolved to, which is the piece
 * the built-in panel does not show: two subagents listed identically can be
 * running different models at different costs.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface SubagentActivity {
  id: string;
  name?: string;
  model?: string;
  cwd: string;
  state: "starting" | "working" | "idle" | "done";
  tool?: string;
  /** A short, human-readable summary of the current tool call. */
  detail?: string;
  toolCount: number;
  startedAt: string;
  updatedAt: string;
}

export function activityRoot(): string {
  return join(homedir(), ".omp", "run", "subagents");
}

/** One line describing a tool call, short enough for a table cell. */
export function summariseToolCall(tool: string, input: Record<string, unknown>): string {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  const raw = tool === "bash" ? text("command")
    : tool === "read" || tool === "write" ? text("path") ?? text("file_path")
    : tool === "edit" ? text("path") ?? text("file_path")
    : tool === "grep" ? text("pattern")
    : tool === "glob" ? text("pattern")
    : text("query") ?? text("prompt") ?? text("path") ?? text("command");
  if (!raw) return tool;
  const flat = raw.replace(/\s+/g, " ").trim();
  // Long paths read better from the end; commands read better from the front.
  if ((tool === "read" || tool === "write" || tool === "edit") && flat.length > 48) {
    return `.../${basename(flat)}`;
  }
  return flat.length > 64 ? `${flat.slice(0, 63)}~` : flat;
}

let rootReady = false;

/**
 * Persist one status snapshot.
 *
 * The directory is created once. Doing it per call was most of the cost, and
 * this runs inside the agent's own loop where every millisecond is stolen from
 * the work the agent was asked to do.
 *
 * The temporary file and rename stay: a reader that catches a half-written file
 * deletes it, so a torn write would lose the record entirely.
 */
function write(value: SubagentActivity): void {
  try {
    if (!rootReady) {
      mkdirSync(activityRoot(), { recursive: true });
      rootReady = true;
    }
    const path = join(activityRoot(), `${value.id}.json`);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    rootReady = false;
  }
}

/**
 * Read every recorded subagent, discarding records nothing will update again.
 *
 * A subagent that is killed leaves its file behind, so without a sweep the view
 * fills with agents that stopped hours ago.
 */
export function readActivity(maxAgeMs = 60 * 60_000, now = Date.now()): SubagentActivity[] {
  try {
    const { readdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const value: SubagentActivity[] = [];
    for (const name of readdirSync(activityRoot())) {
      if (!name.endsWith(".json")) continue;
      const path = join(activityRoot(), name);
      try {
        const row = JSON.parse(readFileSync(path, "utf8")) as SubagentActivity;
        if (now - new Date(row.updatedAt).getTime() > maxAgeMs) {
          rmSync(path, { force: true });
          continue;
        }
        value.push(row);
      } catch {
        rmSync(path, { force: true });
      }
    }
    return value;
  } catch {
    return [];
  }
}

export default function subagentActivity(pi: any) {
  const id = `${process.pid}`;
  const startedAt = new Date().toISOString();
  let state: SubagentActivity["state"] = "starting";
  let toolCount = 0;
  let tool: string | undefined;
  let detail: string | undefined;
  let name: string | undefined;

  /**
   * Coalesce updates.
   *
   * A busy subagent calls tools faster than anyone can read the result, so most
   * writes are overwritten before they are ever seen. Nothing is lost: a
   * pending update is flushed on a timer, and a state change publishes at once.
   */
  const MIN_WRITE_GAP_MS = 250;
  let lastWrite = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let latest: SubagentActivity | undefined;

  const flush = (): void => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
    if (!latest) return;
    lastWrite = Date.now();
    write(latest);
    latest = undefined;
  };

  const snapshot = (ctx: any): SubagentActivity => ({
    id,
    name,
    model: ctx?.model?.id ?? ctx?.model?.name,
    cwd: ctx?.cwd ?? process.cwd(),
    state,
    tool,
    detail,
    toolCount,
    startedAt,
    updatedAt: new Date().toISOString(),
  });

  const publish = (ctx: any, immediate = false): void => {
    latest = snapshot(ctx);
    if (immediate) return flush();
    const since = Date.now() - lastWrite;
    if (since >= MIN_WRITE_GAP_MS) return flush();
    // The timer is unref'd so a pending update never holds the process open.
    if (!pendingTimer) {
      pendingTimer = setTimeout(flush, MIN_WRITE_GAP_MS - since);
      (pendingTimer as { unref?: () => void }).unref?.();
    }
  };

  pi.on?.("agent_start", (_event: unknown, ctx: any) => {
    state = "working";
    publish(ctx, true);
  });
  pi.on?.("before_agent_start", (event: any, ctx: any) => {
    // The first prompt is the only place a subagent's assignment appears.
    if (!name && typeof event?.prompt === "string") {
      name = event.prompt.split("\n")[0]?.slice(0, 60);
    }
    publish(ctx);
  });
  pi.on?.("tool_call", (event: any, ctx: any) => {
    toolCount++;
    tool = event?.toolName;
    detail = summariseToolCall(String(event?.toolName ?? ""), event?.input ?? {});
    state = "working";
    publish(ctx);
  });
  pi.on?.("agent_end", (_event: unknown, ctx: any) => {
    state = "idle";
    publish(ctx, true);
  });
  pi.on?.("session_shutdown", (_event: unknown, ctx: any) => {
    state = "done";
    publish(ctx, true);
  });
}
