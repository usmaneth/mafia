import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DecisionRecord,
  JobStatus,
  JobState,
  MafiaEvent,
  MafiaMessage,
  TeamCheckpoint,
  UsageMetrics,
} from "./types";

export class JobStore {
  readonly db: Database;

  constructor(readonly stateRoot: string) {
    mkdirSync(join(stateRoot, "jobs"), { recursive: true });
    this.db = new Database(join(stateRoot, "mafia.db"), { create: true });
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        harness TEXT NOT NULL,
        host TEXT NOT NULL,
        repo TEXT,
        cwd TEXT,
        model TEXT,
        base_ref TEXT,
        isolate INTEGER NOT NULL,
        parent_id TEXT,
        pipeline_id TEXT,
        labels TEXT NOT NULL,
        state TEXT NOT NULL,
        pid INTEGER,
        worktree TEXT,
        branch TEXT,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        exit_code INTEGER,
        error TEXT,
        result TEXT,
        log_path TEXT NOT NULL,
        status_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
      -- Every listing sorts by updated_at. Without this SQLite scans the table
      -- and builds a temporary B-tree for the sort on each call.
      CREATE INDEX IF NOT EXISTS jobs_updated ON jobs(updated_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_state_updated ON jobs(state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_pipeline ON jobs(pipeline_id);
      CREATE INDEX IF NOT EXISTS jobs_parent ON jobs(parent_id);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        job_id TEXT,
        host TEXT NOT NULL,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_team ON events(team_id, created_at);
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id, created_at);
      -- The unfiltered event listing was scanning every row; there are already
      -- more than twelve thousand.
      CREATE INDEX IF NOT EXISTS events_created ON events(created_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        room TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        host TEXT,
        job_id TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_team ON messages(team_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_room ON messages(room, created_at);
      CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, created_at);
      -- Read on every reconcile, so a scan here is paid constantly.
      CREATE INDEX IF NOT EXISTS messages_undelivered ON messages(delivered_at, created_at);
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decisions_team ON decisions(team_id, created_at);
      CREATE TABLE IF NOT EXISTS usage_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT,
        job_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        requests INTEGER NOT NULL,
        failures INTEGER NOT NULL,
        runtime_seconds REAL NOT NULL,
        ttft_ms REAL,
        created_at TEXT NOT NULL,
        UNIQUE(job_id)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkpoints_team ON checkpoints(team_id, created_at);
    `);
  }

  /**
   * Run a batch of writes in one transaction.
   *
   * Each `upsert` outside a transaction is its own write-ahead-log commit. A
   * reconcile pass writes every known job, so a hundred jobs cost a hundred
   * commits. One transaction makes that a single commit.
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  upsert(job: JobStatus): void {
    this.db.query(`
      INSERT INTO jobs (
        id,title,prompt,harness,host,repo,cwd,model,base_ref,isolate,parent_id,pipeline_id,
        labels,state,pid,worktree,branch,started_at,updated_at,completed_at,exit_code,error,
        result,log_path,status_json
      ) VALUES (
        $id,$title,$prompt,$harness,$host,$repo,$cwd,$model,$baseRef,$isolate,$parentId,$pipelineId,
        $labels,$state,$pid,$worktree,$branch,$startedAt,$updatedAt,$completedAt,$exitCode,$error,
        $result,$logPath,$statusJson
      )
      ON CONFLICT(id) DO UPDATE SET
        state=excluded.state,pid=excluded.pid,worktree=excluded.worktree,branch=excluded.branch,
        started_at=excluded.started_at,updated_at=excluded.updated_at,
        completed_at=excluded.completed_at,exit_code=excluded.exit_code,error=excluded.error,
        result=excluded.result,log_path=excluded.log_path,status_json=excluded.status_json
    `).run({
      $id: job.id,
      $title: job.title,
      $prompt: job.prompt,
      $harness: job.harness,
      $host: job.host,
      $repo: job.repo ?? null,
      $cwd: job.cwd ?? null,
      $model: job.model ?? null,
      $baseRef: job.baseRef ?? null,
      $isolate: job.isolate ? 1 : 0,
      $parentId: job.parentId ?? null,
      $pipelineId: job.pipelineId ?? null,
      $labels: JSON.stringify(job.labels),
      $state: job.state,
      $pid: job.pid ?? null,
      $worktree: job.worktree ?? null,
      $branch: job.branch ?? null,
      $startedAt: job.startedAt ?? null,
      $updatedAt: job.updatedAt,
      $completedAt: job.completedAt ?? null,
      $exitCode: job.exitCode ?? null,
      $error: job.error ?? null,
      $result: job.result ?? null,
      $logPath: job.logPath,
      $statusJson: JSON.stringify(job),
    } as any);
  }

  get(id: string): JobStatus | undefined {
    const row = this.db.query("SELECT status_json FROM jobs WHERE id = ?").get(id) as
      | { status_json: string }
      | null;
    return row ? JSON.parse(row.status_json) : undefined;
  }

  list(limit = 50, state?: JobState): JobStatus[] {
    const rows = state
      ? this.db.query("SELECT status_json FROM jobs WHERE state = ? ORDER BY updated_at DESC LIMIT ?").all(state, limit)
      : this.db.query("SELECT status_json FROM jobs ORDER BY updated_at DESC LIMIT ?").all(limit);
    return (rows as Array<{ status_json: string }>).map((row) => JSON.parse(row.status_json));
  }

  importLocalStatus(id: string): JobStatus | undefined {
    const path = join(this.stateRoot, "jobs", id, "status.json");
    if (!existsSync(path)) return undefined;
    const job = JSON.parse(readFileSync(path, "utf8")) as JobStatus;
    this.upsert(job);
    return job;
  }

  /**
   * Record an event.
   *
   * A worker pulses every five seconds, which made heartbeats 95% of this
   * table: 12,366 rows of 12,982. Liveness already lives on the job's status
   * file and its `heartbeatAt` field, so keeping a row per pulse buried the
   * events that carry meaning and made every listing pay for them.
   */
  insertEvent(event: MafiaEvent): void {
    if (event.type === "presence.heartbeat") return;
    this.db.query(`
      INSERT OR IGNORE INTO events (id,team_id,job_id,host,actor,type,data_json,created_at)
      VALUES ($id,$teamId,$jobId,$host,$actor,$type,$data,$createdAt)
    `).run({
      $id: event.id,
      $teamId: event.teamId ?? null,
      $jobId: event.jobId ?? null,
      $host: event.host,
      $actor: event.actor,
      $type: event.type,
      $data: JSON.stringify(event.data),
      $createdAt: event.createdAt,
    } as any);
  }

  listEvents(options: { teamId?: string; jobId?: string; limit?: number } = {}): MafiaEvent[] {
    const limit = options.limit ?? 200;
    let rows: any[];
    if (options.jobId) {
      rows = this.db.query("SELECT * FROM events WHERE job_id = ? ORDER BY created_at DESC LIMIT ?").all(options.jobId, limit) as any[];
    } else if (options.teamId) {
      rows = this.db.query("SELECT * FROM events WHERE team_id = ? ORDER BY created_at DESC LIMIT ?").all(options.teamId, limit) as any[];
    } else {
      rows = this.db.query("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
    }
    return rows.map((row) => ({
      id: row.id,
      teamId: row.team_id ?? undefined,
      jobId: row.job_id ?? undefined,
      host: row.host,
      actor: row.actor,
      type: row.type,
      data: JSON.parse(row.data_json),
      createdAt: row.created_at,
    }));
  }

  insertMessage(message: MafiaMessage): boolean {
    const result = this.db.query(`
      INSERT OR IGNORE INTO messages (
        id,team_id,room,sender,recipient,type,body,artifacts_json,host,job_id,created_at,delivered_at,read_at
      ) VALUES (
        $id,$teamId,$room,$sender,$recipient,$type,$body,$artifacts,$host,$jobId,$createdAt,$deliveredAt,$readAt
      )
    `).run({
      $id: message.id,
      $teamId: message.teamId ?? null,
      $room: message.room,
      $sender: message.from,
      $recipient: message.to ?? null,
      $type: message.type,
      $body: message.body,
      $artifacts: JSON.stringify(message.artifacts),
      $host: message.host ?? null,
      $jobId: message.jobId ?? null,
      $createdAt: message.createdAt,
      $deliveredAt: message.deliveredAt ?? null,
      $readAt: message.readAt ?? null,
    } as any);
    return result.changes > 0;
  }

  listMessages(options: { teamId?: string; room?: string; jobId?: string; limit?: number } = {}): MafiaMessage[] {
    const limit = options.limit ?? 200;
    let rows: any[];
    if (options.jobId) {
      rows = this.db.query(
        "SELECT * FROM messages WHERE job_id = ? OR recipient = ? ORDER BY created_at DESC LIMIT ?",
      ).all(options.jobId, options.jobId, limit) as any[];
    } else if (options.room) {
      rows = this.db.query("SELECT * FROM messages WHERE room = ? ORDER BY created_at DESC LIMIT ?").all(options.room, limit) as any[];
    } else if (options.teamId) {
      rows = this.db.query("SELECT * FROM messages WHERE team_id = ? ORDER BY created_at DESC LIMIT ?").all(options.teamId, limit) as any[];
    } else {
      rows = this.db.query("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
    }
    return rows.map(messageFromRow);
  }

  listUndeliveredMessages(limit = 500): MafiaMessage[] {
    const rows = this.db.query(
      "SELECT * FROM messages WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?",
    ).all(limit) as any[];
    return rows.map(messageFromRow);
  }

  markMessageRead(id: string, readAt: string): void {
    this.db.query("UPDATE messages SET read_at = ? WHERE id = ?").run(readAt, id);
  }

  markMessageDelivered(id: string, deliveredAt: string): void {
    this.db.query("UPDATE messages SET delivered_at = ? WHERE id = ?").run(deliveredAt, id);
  }

  /**
   * Drop events older than the retention window.
   *
   * The audit table only ever grew. Events are a debugging aid, not a ledger,
   * and the same records remain in the append-only log on disk.
   */
  pruneEvents(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    // Heartbeats already recorded go regardless of age; nothing reads them.
    const pulses = this.db.query("DELETE FROM events WHERE type = 'presence.heartbeat'").run().changes;
    return pulses + this.db.query("DELETE FROM events WHERE created_at < ?").run(cutoff).changes;
  }

  insertDecision(decision: DecisionRecord): void {
    this.db.query(
      "INSERT OR REPLACE INTO decisions (id,team_id,value_json,created_at) VALUES (?,?,?,?)",
    ).run(decision.id, decision.teamId, JSON.stringify(decision), decision.createdAt);
  }

  listDecisions(teamId: string): DecisionRecord[] {
    const rows = this.db.query(
      "SELECT value_json FROM decisions WHERE team_id = ? ORDER BY created_at",
    ).all(teamId) as Array<{ value_json: string }>;
    return rows.map((row) => JSON.parse(row.value_json));
  }

  upsertUsage(job: JobStatus): void {
    if (!job.usage) return;
    const provider = job.model?.split("/")[0] ?? job.harness;
    this.db.query(`
      INSERT INTO usage_metrics (
        team_id,job_id,harness,model,provider,input_tokens,output_tokens,cache_read_tokens,
        cache_write_tokens,cost_usd,requests,failures,runtime_seconds,ttft_ms,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET
        input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
        cache_read_tokens=excluded.cache_read_tokens,cache_write_tokens=excluded.cache_write_tokens,
        cost_usd=excluded.cost_usd,requests=excluded.requests,failures=excluded.failures,
        runtime_seconds=excluded.runtime_seconds,ttft_ms=excluded.ttft_ms
    `).run(
      job.pipelineId ?? null,
      job.id,
      job.harness,
      job.model ?? null,
      provider,
      job.usage.inputTokens,
      job.usage.outputTokens,
      job.usage.cacheReadTokens,
      job.usage.cacheWriteTokens,
      job.usage.costUsd,
      job.usage.requests,
      job.usage.failures,
      job.usage.runtimeSeconds,
      job.usage.ttftMs ?? null,
      job.completedAt ?? job.updatedAt,
    );
  }

  /** Time-to-first-output for every job that recorded one. */
  latencySamples(limit = 5000): Array<{ model: string | null; ttftMs: number | null }> {
    return this.db.query(
      "SELECT model, ttft_ms AS ttftMs FROM usage_metrics WHERE ttft_ms IS NOT NULL ORDER BY id DESC LIMIT ?",
    ).all(limit) as Array<{ model: string | null; ttftMs: number | null }>;
  }

  aggregateUsage(teamId?: string): UsageMetrics {
    const row = (teamId
      ? this.db.query(`
          SELECT COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
          COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
          COALESCE(SUM(cost_usd),0) cost_usd, COALESCE(SUM(requests),0) requests,
          COALESCE(SUM(failures),0) failures, COALESCE(SUM(runtime_seconds),0) runtime_seconds
          FROM usage_metrics WHERE team_id = ?
        `).get(teamId)
      : this.db.query(`
          SELECT COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
          COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
          COALESCE(SUM(cost_usd),0) cost_usd, COALESCE(SUM(requests),0) requests,
          COALESCE(SUM(failures),0) failures, COALESCE(SUM(runtime_seconds),0) runtime_seconds
          FROM usage_metrics
        `).get()) as any;
    return {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      costUsd: Number(row.cost_usd),
      requests: Number(row.requests),
      failures: Number(row.failures),
      runtimeSeconds: Number(row.runtime_seconds),
    };
  }

  usageByProvider(teamId: string): Record<string, number> {
    const rows = this.db.query(
      "SELECT provider, COALESCE(SUM(cost_usd),0) cost FROM usage_metrics WHERE team_id = ? GROUP BY provider",
    ).all(teamId) as Array<{ provider: string; cost: number }>;
    return Object.fromEntries(rows.map((row) => [row.provider, Number(row.cost)]));
  }

  usageBreakdown(teamId: string): Array<Record<string, unknown>> {
    return this.db.query(`
      SELECT harness, model, provider, COUNT(*) jobs,
        COALESCE(SUM(input_tokens),0) inputTokens,
        COALESCE(SUM(output_tokens),0) outputTokens,
        COALESCE(SUM(cache_read_tokens),0) cacheReadTokens,
        COALESCE(SUM(cost_usd),0) costUsd,
        COALESCE(SUM(failures),0) failures,
        COALESCE(SUM(runtime_seconds),0) runtimeSeconds
      FROM usage_metrics
      WHERE team_id = ?
      GROUP BY harness, model, provider
      ORDER BY costUsd DESC, inputTokens + outputTokens DESC
    `).all(teamId) as Array<Record<string, unknown>>;
  }

  routingHistory(): Map<string, UsageMetrics> {
    const rows = this.db.query(`
      SELECT harness, model, host, COUNT(*) requests,
        SUM(CASE WHEN state IN ('failed','lost') THEN 1 ELSE 0 END) failures,
        COALESCE(SUM(json_extract(status_json, '$.usage.inputTokens')),0) input_tokens,
        COALESCE(SUM(json_extract(status_json, '$.usage.outputTokens')),0) output_tokens,
        COALESCE(SUM(json_extract(status_json, '$.usage.costUsd')),0) cost_usd,
        COALESCE(AVG(json_extract(status_json, '$.usage.runtimeSeconds')),0) runtime_seconds
      FROM jobs
      WHERE state IN ('succeeded','failed','lost')
      GROUP BY harness, model, host
    `).all() as any[];
    return new Map(rows.map((row) => [
      `${row.harness}:${row.model ?? ""}:${row.host}`,
      {
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: Number(row.cost_usd),
        requests: Number(row.requests),
        failures: Number(row.failures),
        runtimeSeconds: Number(row.runtime_seconds),
      },
    ]));
  }

  insertCheckpoint(checkpoint: TeamCheckpoint): void {
    this.db.query(
      "INSERT OR REPLACE INTO checkpoints (id,team_id,value_json,created_at) VALUES (?,?,?,?)",
    ).run(checkpoint.id, checkpoint.teamId, JSON.stringify(checkpoint), checkpoint.createdAt);
  }

  getCheckpoint(id: string): TeamCheckpoint | undefined {
    const row = this.db.query("SELECT value_json FROM checkpoints WHERE id = ?").get(id) as
      | { value_json: string }
      | null;
    return row ? JSON.parse(row.value_json) : undefined;
  }
}

function messageFromRow(row: any): MafiaMessage {
  return {
    id: row.id,
    teamId: row.team_id ?? undefined,
    room: row.room,
    from: row.sender,
    to: row.recipient ?? undefined,
    type: row.type,
    body: row.body,
    artifacts: JSON.parse(row.artifacts_json),
    host: row.host ?? undefined,
    jobId: row.job_id ?? undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    readAt: row.read_at ?? undefined,
  };
}
