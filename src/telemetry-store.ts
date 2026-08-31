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
  /** Provider call time, where the source records it. Grok and Cline do. */
  durationMs?: number;
  /** Tool calls made during the turn, by name. */
  tools?: Record<string, number>;
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
        duration_ms REAL,
        ok INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS turns_harness_time ON turns(harness, started_at DESC);
      CREATE INDEX IF NOT EXISTS turns_model_time ON turns(model, started_at DESC);
      CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id);
      -- Tool calls are many per turn, so they get their own rows rather than a
      -- single name that would have to pick a winner.
      CREATE TABLE IF NOT EXISTS tool_calls (
        turn_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL,
        PRIMARY KEY (turn_id, tool)
      );
      CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls(harness, tool);
      -- Whether the work landed. Every other table here measures effort.
      CREATE TABLE IF NOT EXISTS pr_states (
        id TEXT PRIMARY KEY,
        observed_at TEXT NOT NULL,
        state TEXT NOT NULL,
        count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pr_states_time ON pr_states(observed_at DESC);
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
      ["turns", "duration_ms", "REAL"],
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
    const tool = this.db.query(
      "INSERT OR REPLACE INTO tool_calls (turn_id,harness,tool,calls) VALUES (?,?,?,?)",
    );
    const insert = this.db.query(`
      INSERT OR IGNORE INTO turns (
        id,harness,host,session_id,started_at,model,provider,cwd,input_tokens,output_tokens,
        cache_read_tokens,cache_write_tokens,reasoning_tokens,duration_ms,ok
      ) VALUES ($id,$harness,$host,$session,$started,$model,$provider,$cwd,$input,$output,$cacheRead,$cacheWrite,$reasoning,$duration,$ok)
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
          $duration: turn.durationMs ?? null, $ok: turn.ok,
        } as never).changes;
        for (const [name, calls] of Object.entries(turn.tools ?? {})) tool.run(turn.id, turn.harness, name, calls);
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
  /** Which tools the fleet actually uses, and how heavily. */
  toolUsage(limit = 15): Array<{ harness: string; tool: string; calls: number; turns: number }> {
    return this.db.query(`
      SELECT harness, tool, SUM(calls) calls, COUNT(*) turns
      FROM tool_calls GROUP BY harness, tool ORDER BY calls DESC LIMIT ?
    `).all(limit) as never;
  }

  recordPrStates(rows: Array<{ id: string; observedAt: string; state: string; count: number }>): number {
    const insert = this.db.query(
      "INSERT OR IGNORE INTO pr_states (id,observed_at,state,count) VALUES (?,?,?,?)",
    );
    let added = 0;
    this.db.transaction(() => {
      for (const row of rows) added += insert.run(row.id, row.observedAt, row.state, row.count).changes;
    })();
    return added;
  }

  /** How often each pull-request state was observed, most recent window first. */
  prStates(days = 14): Array<{ state: string; observations: number; peak: number; last: string }> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.query(`
      SELECT state, COUNT(*) observations, MAX(count) peak, MAX(observed_at) last
      FROM pr_states WHERE observed_at >= ? GROUP BY state ORDER BY observations DESC
    `).all(since) as never;
  }

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
  /**
   * Median provider call time per model.
   *
   * This reads `duration_ms`, which Grok and Cline record. The earlier version
   * read a column no source could fill, so it always returned nothing.
   */
  modelLatency(minimumTurns = 5): Array<{ model: string; harness: string; turns: number; medianMs: number }> {
    return this.db.query(`
      SELECT model, harness, COUNT(*) turns,
        CAST(AVG(duration_ms) AS REAL) medianMs
      FROM (
        SELECT model, harness, duration_ms,
          ROW_NUMBER() OVER (PARTITION BY model ORDER BY duration_ms) rn,
          COUNT(*) OVER (PARTITION BY model) n
        FROM turns WHERE duration_ms IS NOT NULL AND model IS NOT NULL
      )
      WHERE rn IN ((n+1)/2, (n+2)/2)
      GROUP BY model HAVING turns >= ? ORDER BY medianMs
    `).all(minimumTurns) as never;
  }
}
