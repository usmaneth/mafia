import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TelemetryStore, type TurnRecord } from "./telemetry-store";

/** Bytes read per file per pass. Ingestion must not hold the corpus in memory. */
const CHUNK_BYTES = 4 * 1024 * 1024;

export interface HarnessSource {
  harness: string;
  roots: string[];
  parse: (lines: string[], path: string) => TurnRecord[];
}

function id(...parts: Array<string | number | undefined>): string {
  return createHash("sha1").update(parts.map(String).join(" ")).digest("hex").slice(0, 20);
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
      ok: 1,
    });
    previous = now;
  }
  return turns;
}

export function harnessSources(home = homedir()): HarnessSource[] {
  return [
    { harness: "claude", roots: [join(home, ".claude", "projects")], parse: parseClaude },
    { harness: "codex", roots: [join(home, ".codex", "sessions")], parse: parseCodex },
  ];
}

function walk(root: string, out: string[], depth = 0): void {
  if (depth > 6 || !existsSync(root)) return;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
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
  const budget = options.maxBytes ?? 512 * 1024 * 1024;
  let spent = 0;
  const reports: IngestReport[] = [];
  for (const source of options.sources ?? harnessSources()) {
    const started = Date.now();
    const files: string[] = [];
    for (const root of source.roots) walk(root, files);
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
