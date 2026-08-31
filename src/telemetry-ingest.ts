import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TelemetryStore, type TurnRecord } from "./telemetry-store";

/**
 * Bytes read from one file per pass.
 *
 * This bounds memory, not total work. At four megabytes a large session needed
 * a dozen passes to catch up; almost every session file is smaller than this,
 * so one pass now finishes it.
 */
const CHUNK_BYTES = 64 * 1024 * 1024;

export interface HarnessSource {
  harness: string;
  roots: string[];
  parse: (lines: string[], path: string) => TurnRecord[];
  /** Cline writes one JSON object per session rather than a line-delimited log. */
  extension?: string;
}

function id(...parts: Array<string | number | undefined>): string {
  return createHash("sha1").update(parts.map(String).join(" ")).digest("hex").slice(0, 20);
}

/** Tally tool names out of a content array. */
function countTools(parts: unknown[], name: (part: unknown) => string | undefined): Record<string, number> | undefined {
  const tally: Record<string, number> = {};
  for (const part of parts) {
    const value = name(part);
    if (value) tally[value] = (tally[value] ?? 0) + 1;
  }
  return Object.keys(tally).length ? tally : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Claude Code writes one JSONL per session. The `assistant` lines carry the
 * usage and the model that produced them.
 */
export function parseClaude(lines: string[], path: string): TurnRecord[] {
  const turns: TurnRecord[] = [];
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const usage = entry.message?.usage;
    const startedAt = String(entry.timestamp ?? "");
    if (!usage || !startedAt) continue;
    turns.push({
      id: id("claude", entry.sessionId, entry.uuid ?? entry.message?.id ?? startedAt),
      harness: "claude",
      sessionId: String(entry.sessionId ?? path),
      startedAt,
      model: entry.message?.model ? String(entry.message.model) : undefined,
      provider: "anthropic",
      cwd: entry.cwd ? String(entry.cwd) : undefined,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      reasoningTokens: num(usage.output_tokens_details?.thinking_tokens),
      // The content array carries the tools the model actually reached for.
      tools: countTools((entry.message?.content ?? []) as unknown[], (part: any) =>
        part?.type === "tool_use" ? String(part.name ?? "") : undefined),
      ok: entry.isApiErrorMessage ? 0 : 1,
    });
  }
  return turns;
}

/**
 * Codex writes rollout files. Token counts arrive as running totals, so one
 * turn is the rise since the previous total.
 */
export function parseCodex(lines: string[], path: string): TurnRecord[] {
  const turns: TurnRecord[] = [];
  let session = path;
  let model: string | undefined;
  let cwd: string | undefined;
  let previous = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
  // Codex emits a tool call as its own line, so they are gathered until the
  // next token count closes the turn they belong to.
  let pendingTools: Record<string, number> = {};
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload ?? entry;
    if (entry?.type === "session_meta") {
      session = String(payload?.id ?? session);
      cwd = payload?.cwd ? String(payload.cwd) : cwd;
      model = payload?.model ? String(payload.model) : model;
      continue;
    }
    if (entry?.type === "turn_context") {
      model = payload?.model ? String(payload.model) : model;
      continue;
    }
    const callName = ["function_call", "local_shell_call", "custom_tool_call"].includes(String(payload?.type))
      ? String(payload?.name ?? payload?.type)
      : undefined;
    if (callName) {
      pendingTools[callName] = (pendingTools[callName] ?? 0) + 1;
      continue;
    }
    if (payload?.type !== "token_count") continue;
    const total = payload?.info?.total_token_usage;
    const startedAt = String(entry.timestamp ?? "");
    if (!total || !startedAt) continue;
    const now = {
      input: num(total.input_tokens),
      output: num(total.output_tokens),
      cacheRead: num(total.cached_input_tokens),
      reasoning: num(total.reasoning_output_tokens),
    };
    // A running total that fell means the session compacted and restarted its
    // count. Treat the new figure as the turn rather than a negative rise.
    const rise = (current: number, before: number) => (current >= before ? current - before : current);
    turns.push({
      id: id("codex", session, startedAt),
      harness: "codex",
      sessionId: session,
      startedAt,
      model,
      provider: "openai-codex",
      cwd,
      inputTokens: rise(now.input, previous.input),
      outputTokens: rise(now.output, previous.output),
      cacheReadTokens: rise(now.cacheRead, previous.cacheRead),
      cacheWriteTokens: 0,
      reasoningTokens: rise(now.reasoning, previous.reasoning),
      tools: Object.keys(pendingTools).length ? pendingTools : undefined,
      ok: 1,
    });
    pendingTools = {};
    previous = now;
  }
  return turns;
}

/**
 * Grok records its own usage shape, and is the only harness here that reports
 * how long the provider call took.
 */
export function parseGrok(lines: string[], path: string): TurnRecord[] {
  const turns: TurnRecord[] = [];
  const session = path.split("/").at(-2) ?? path;
  let model: string | undefined;
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const update = entry?.params?.update ?? {};
    model = update.model ?? entry?.params?.model ?? model;
    const usage = update.usage;
    // Grok stamps in unix seconds, not an ISO string.
    const seconds = Number(entry?.timestamp);
    if (!usage || !Number.isFinite(seconds)) continue;
    const startedAt = new Date(seconds * 1000).toISOString();
    turns.push({
      id: id("grok", session, entry?.params?.update?.prompt_id ?? startedAt),
      harness: "grok",
      sessionId: String(entry?.params?.sessionId ?? session),
      startedAt,
      model: model ? String(model) : undefined,
      provider: "xai",
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadTokens: num(usage.cachedReadTokens),
      cacheWriteTokens: num(usage.cacheCreationTokens),
      reasoningTokens: num(usage.reasoningTokens),
      durationMs: num(usage.apiDurationMs) || undefined,
      ok: update.stop_reason === "error" ? 0 : 1,
    });
  }
  return turns;
}

/** Kimi names its fields differently but reports the same four quantities. */
export function parseKimi(lines: string[], path: string): TurnRecord[] {
  const turns: TurnRecord[] = [];
  const session = path.split("/").at(-3) ?? path;
  let model: string | undefined;
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // The model is announced once, when the profile binds.
    if (entry?.type === "profile.bind" && entry.modelAlias) model = String(entry.modelAlias);
    if (entry?.type !== "usage.record" || !entry.usage) continue;
    const millis = Number(entry.time);
    if (!Number.isFinite(millis)) continue;
    const startedAt = new Date(millis).toISOString();
    turns.push({
      id: id("kimi", session, startedAt, entry.usage.output),
      harness: "kimi",
      sessionId: session,
      startedAt,
      model: entry.model ? String(entry.model) : model,
      provider: "kimi-code",
      inputTokens: num(entry.usage.inputOther),
      outputTokens: num(entry.usage.output),
      cacheReadTokens: num(entry.usage.inputCacheRead),
      cacheWriteTokens: num(entry.usage.inputCacheCreation),
      reasoningTokens: 0,
      ok: 1,
    });
  }
  return turns;
}

/**
 * Cline records no token usage, but it does record how a session ended.
 *
 * That is the one thing every other source here is missing: whether the work
 * finished cleanly. A turn with no tokens still carries an outcome.
 */
export function parseCline(lines: string[], path: string): TurnRecord[] {
  const text = lines.join("\n");
  let entry: any;
  try {
    entry = JSON.parse(text);
  } catch {
    return [];
  }
  const startedAt = String(entry?.started_at ?? "");
  if (!startedAt || !entry?.session_id) return [];
  const ended = entry?.ended_at ? new Date(entry.ended_at).getTime() : undefined;
  const began = new Date(startedAt).getTime();
  return [{
    id: id("cline", entry.session_id),
    harness: "cline",
    sessionId: String(entry.session_id),
    startedAt,
    model: entry?.model ? String(entry.model) : undefined,
    provider: entry?.provider ? String(entry.provider) : undefined,
    cwd: entry?.cwd ? String(entry.cwd) : undefined,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: ended && Number.isFinite(ended) && Number.isFinite(began) ? ended - began : undefined,
    ok: entry?.exit_code === 0 || entry?.status === "completed" ? 1 : 0,
  }];
}

export function harnessSources(home = homedir()): HarnessSource[] {
  return [
    { harness: "claude", roots: [join(home, ".claude", "projects")], parse: parseClaude },
    { harness: "codex", roots: [join(home, ".codex", "sessions")], parse: parseCodex },
    // Void writes the same record shape as Claude Code, so it reuses the parser
    // and only the harness label differs.
    { harness: "void", roots: [join(home, ".void", "projects")], parse: (lines, path) => parseClaude(lines, path).map((turn) => ({ ...turn, harness: "void" })) },
    { harness: "grok", roots: [join(home, ".grok", "sessions")], parse: parseGrok },
    { harness: "kimi", roots: [join(home, ".kimi-code", "sessions")], parse: parseKimi },
    { harness: "cline", roots: [join(home, ".cline", "data", "sessions")], parse: parseCline, extension: ".json" },
  ];
}

function walk(root: string, out: string[], depth = 0, extension = ".jsonl"): void {
  if (depth > 6 || !existsSync(root)) return;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, out, depth + 1, extension);
    // Cline keeps a separate messages file beside each session; only the
    // session record carries the outcome.
    else if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith(".messages.json")) out.push(path);
  }
}

/** Fingerprint the first bytes, to tell an append from a rewrite in place. */
function headPrint(path: string, bytes = 512): string {
  try {
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const read = readSync(handle, buffer, 0, bytes, 0);
      return createHash("sha1").update(buffer.subarray(0, Math.max(0, read))).digest("hex").slice(0, 16);
    } finally {
      closeSync(handle);
    }
  } catch {
    return "";
  }
}

/**
 * Read from a byte offset without loading the file.
 *
 * The offset advances only past complete lines, so a session still being
 * written is never split across two passes.
 */
function readFrom(path: string, from: number, limit: number): { lines: string[]; consumed: number } {
  if (limit <= 0) return { lines: [], consumed: 0 };
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(limit, CHUNK_BYTES));
    const read = readSync(handle, buffer, 0, buffer.length, from);
    if (read <= 0) return { lines: [], consumed: 0 };
    const text = buffer.subarray(0, read).toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return { lines: [], consumed: 0 };
    const complete = text.slice(0, end + 1);
    return { lines: complete.split("\n").filter(Boolean), consumed: Buffer.byteLength(complete, "utf8") };
  } finally {
    closeSync(handle);
  }
}

export interface IngestReport {
  harness: string;
  filesSeen: number;
  filesRead: number;
  bytesRead: number;
  turns: number;
  ms: number;
}

/**
 * Ingest new telemetry.
 *
 * Runs out of band. Nothing in dispatch, reconcile, or the agent loop calls it,
 * because the first pass reads gigabytes. Every pass after that reads only what
 * was appended: a file whose size matches its recorded cursor is never opened.
 */
export function ingestTelemetry(
  stateRoot: string,
  options: { sources?: HarnessSource[]; maxBytes?: number } = {},
): IngestReport[] {
  const store = new TelemetryStore(stateRoot);
  const sources = options.sources ?? harnessSources();
  // Budget per source, not shared. A shared pool let the first harness consume
  // all of it, so later ones ingested nothing and the summary showed their
  // absence as though they had no data.
  const budget = Math.max(1, Math.floor((options.maxBytes ?? 2048 * 1024 * 1024) / Math.max(1, sources.length)));
  const reports: IngestReport[] = [];
  for (const source of sources) {
    let spent = 0;
    const started = Date.now();
    const files: string[] = [];
    for (const root of source.roots) walk(root, files, 0, source.extension ?? ".jsonl");
    let filesRead = 0;
    let bytesRead = 0;
    let turns = 0;
    for (const path of files) {
      if (spent >= budget) break;
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      const cursor = store.cursor(path);
      // Cheap check first: an untouched file is skipped without being opened.
      if (cursor && cursor.size === stat.size && cursor.mtimeMs === stat.mtimeMs && cursor.bytesRead >= stat.size) continue;
      const head = headPrint(path);
      // A rewritten file can be larger than before, so size and time cannot
      // separate that from an append. A changed head can.
      const rewritten = !cursor || stat.size < cursor.size || (cursor.head !== "" && cursor.head !== head);
      const from = rewritten ? 0 : cursor.bytesRead;
      const { lines, consumed } = readFrom(path, from, Math.min(budget - spent, stat.size - from));
      if (!consumed) continue;
      filesRead++;
      bytesRead += consumed;
      spent += consumed;
      turns += store.ingest(path, source.harness, stat.size, stat.mtimeMs, from + consumed, source.parse(lines, path), head);
    }
    reports.push({ harness: source.harness, filesSeen: files.length, filesRead, bytesRead, turns, ms: Date.now() - started });
  }
  return reports;
}

export function formatIngest(reports: IngestReport[]): string {
  const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
  return reports.map((report) =>
    `  ${report.harness.padEnd(10)} ${String(report.filesRead).padStart(5)}/${String(report.filesSeen).padEnd(6)} files  ` +
    `${mb(report.bytesRead).padStart(10)}  ${String(report.turns).padStart(7)} turns  ${report.ms}ms`).join("\n");
}
