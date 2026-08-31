import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Historical telemetry from every coding harness on this machine.
 *
 * Kept in its own database, not the job store. Ingestion reads gigabytes and
 * writes tens of thousands of rows; sharing a file with the job store would put
 * that behind the same write lock every `mafia status` needs.
 */
export interface TurnRecord {
  /** Stable id, so re-reading a file cannot double-count a turn. */
  id: string;
  harness: string;
  host?: string;
  sessionId: string;
  startedAt: string;
  model?: string;
  provider?: string;
  cwd?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Milliseconds from the request to the first token, when the source records it. */
  ttftMs?: number;
  durationMs?: number;
  toolName?: string;
  ok: number;
}

export class TelemetryStore {
  readonly db: Database;

  constructor(readonly stateRoot: string) {
    mkdirSync(stateRoot, { recursive: true });
    this.db = new Database(join(stateRoot, "telemetry.db"), { create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        harness TEXT NOT NULL,
        -- Which machine produced the turn. The same harness runs on the laptop
        -- and on the VPS, and their cost and latency are not comparable.
        host TEXT NOT NULL DEFAULT 'local',
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        cwd TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        ttft_ms REAL,
        duration_ms REAL,
        tool_name TEXT,
        ok INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS turns_harness_time ON turns(harness, started_at DESC);
      CREATE INDEX IF NOT EXISTS turns_model_time ON turns(model, started_at DESC);
      CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id);
      -- One row per source file. Ingestion resumes from the recorded offset, so
      -- a second pass over four gigabytes reads only what was appended.
      CREATE TABLE IF NOT EXISTS sources (
        path TEXT PRIMARY KEY,
        harness TEXT NOT NULL,
        bytes_read INTEGER NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        -- Hash of the first bytes. Size and modification time cannot tell an
        -- append from an in-place rewrite; the head can.
        head TEXT NOT NULL DEFAULT '',
        turns INTEGER NOT NULL DEFAULT 0,
        ingested_at TEXT NOT NULL
      );
    `);
    this.migrate();
  }

  /**
   * Add columns that a database created by an earlier version is missing.
   *
   * `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a new
   * column never appears on a database that already exists. The VPS hit exactly
   * this: its store predated the `host` column and every insert failed.
   */
  private migrate(): void {
    const columns = (table: string) =>
      new Set((this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    const wanted: Array<[string, string, string]> = [
      ["turns", "host", "TEXT NOT NULL DEFAULT 'local'"],
      ["sources", "head", "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [table, column, definition] of wanted) {
      if (columns(table).has(column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  cursor(path: string): { bytesRead: number; size: number; mtimeMs: number; head: string } | undefined {
    const row = this.db.query(
      "SELECT bytes_read AS bytesRead, size, mtime_ms AS mtimeMs, head FROM sources WHERE path = ?",
    ).get(path) as { bytesRead: number; size: number; mtimeMs: number; head: string } | null;
    return row ?? undefined;
  }

  /** Insert a batch and advance the file's cursor in one transaction. */
  ingest(path: string, harness: string, size: number, mtimeMs: number, bytesRead: number, turns: TurnRecord[], head = ""): number {
    const insert = this.db.query(`
      INSERT OR IGNORE INTO turns (
        id,harness,host,session_id,started_at,model,provider,cwd,input_tokens,output_tokens,
        cache_read_tokens,cache_write_tokens,reasoning_tokens,ttft_ms,duration_ms,tool_name,ok
      ) VALUES ($id,$harness,$host,$session,$started,$model,$provider,$cwd,$input,$output,$cacheRead,$cacheWrite,$reasoning,$ttft,$duration,$tool,$ok)
    `);
    const source = this.db.query(`
      INSERT INTO sources (path,harness,bytes_read,size,mtime_ms,head,turns,ingested_at)
      VALUES ($path,$harness,$bytes,$size,$mtime,$head,$turns,$at)
      ON CONFLICT(path) DO UPDATE SET
        bytes_read=excluded.bytes_read, size=excluded.size, mtime_ms=excluded.mtime_ms,
        head=excluded.head, turns=sources.turns+excluded.turns, ingested_at=excluded.ingested_at
    `);
    let added = 0;
    this.db.transaction(() => {
      for (const turn of turns) {
        added += insert.run({
          $id: turn.id, $harness: turn.harness, $host: turn.host ?? "local", $session: turn.sessionId, $started: turn.startedAt,
          $model: turn.model ?? null, $provider: turn.provider ?? null, $cwd: turn.cwd ?? null,
          $input: turn.inputTokens, $output: turn.outputTokens, $cacheRead: turn.cacheReadTokens,
          $cacheWrite: turn.cacheWriteTokens, $reasoning: turn.reasoningTokens,
          $ttft: turn.ttftMs ?? null, $duration: turn.durationMs ?? null,
          $tool: turn.toolName ?? null, $ok: turn.ok,
        } as never).changes;
      }
      source.run({
        $path: path, $harness: harness, $bytes: bytesRead, $size: size,
        $mtime: mtimeMs, $head: head, $turns: added, $at: new Date().toISOString(),
      } as never);
    })();
    return added;
  }

  /**
   * Totals per harness.
   *
   * Cached input is reported on its own. For Claude nearly every input token is
   * a cache read, so an "input" column alone reads as though the fleet sends
   * more output than input, which is not what happened.
   */
  /** How much of each harness's on-disk history has actually been read. */
  coverage(): Array<{ harness: string; files: number; bytesRead: number; total: number }> {
    return this.db.query(`
      SELECT harness, COUNT(*) files, COALESCE(SUM(bytes_read),0) bytesRead, COALESCE(SUM(size),0) total
      FROM sources GROUP BY harness ORDER BY total DESC
    `).all() as never;
  }

  summary(): Array<{
    harness: string; host: string; turns: number; models: number; first: string; last: string;
    inputTokens: number; outputTokens: number; cacheReadTokens: number;
  }> {
    return this.db.query(`
      SELECT harness, host, COUNT(*) turns, COUNT(DISTINCT model) models,
        MIN(started_at) first, MAX(started_at) last,
        COALESCE(SUM(input_tokens),0) inputTokens,
        COALESCE(SUM(output_tokens),0) outputTokens,
        COALESCE(SUM(cache_read_tokens),0) cacheReadTokens
      FROM turns GROUP BY harness, host ORDER BY turns DESC
    `).all() as never;
  }

  /**
   * Median latency per model across every harness.
   *
   * The median rather than the mean: one turn that waited behind a cold start
   * should not decide how every later task is routed.
   */
  modelLatency(minimumTurns = 5): Array<{ model: string; harness: string; turns: number; medianTtftMs: number }> {
    return this.db.query(`
      SELECT model, harness, COUNT(*) turns,
        CAST(AVG(ttft_ms) AS REAL) medianTtftMs
      FROM (
        SELECT model, harness, ttft_ms,
          ROW_NUMBER() OVER (PARTITION BY model ORDER BY ttft_ms) rn,
          COUNT(*) OVER (PARTITION BY model) n
        FROM turns WHERE ttft_ms IS NOT NULL AND model IS NOT NULL
      )
      WHERE rn IN ((n+1)/2, (n+2)/2)
      GROUP BY model HAVING turns >= ? ORDER BY medianTtftMs
    `).all(minimumTurns) as never;
  }
}
