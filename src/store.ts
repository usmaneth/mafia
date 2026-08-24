import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobStatus, JobState } from "./types";

export class JobStore {
  readonly db: Database;

  constructor(readonly stateRoot: string) {
    mkdirSync(join(stateRoot, "jobs"), { recursive: true });
    this.db = new Database(join(stateRoot, "mafia.db"), { create: true });
    this.db.exec(`
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
      CREATE INDEX IF NOT EXISTS jobs_pipeline ON jobs(pipeline_id);
      CREATE INDEX IF NOT EXISTS jobs_parent ON jobs(parent_id);
    `);
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
}
