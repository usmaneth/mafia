import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveHost, repoRoot } from "./config";
import { createId } from "./id";
import { isHarnessName } from "./harnesses";
import { spawnDetached } from "./process";
import { cancelRemote, dispatchRemote, discoverRemote, readRemoteLog, readRemoteStatus } from "./remote";
import { JobStore } from "./store";
import { extractHarnessResult } from "./result";
import type { HarnessName, JobSpec, JobState, JobStatus } from "./types";

export interface DispatchInput {
  title?: string;
  prompt: string;
  harness?: string;
  host?: string;
  repo?: string;
  cwd?: string;
  model?: string;
  baseRef?: string;
  isolate?: boolean;
  parentId?: string;
  pipelineId?: string;
  labels?: string[];
  timeoutSeconds?: number;
}

export class MafiaService {
  readonly config = loadConfig();
  readonly store = new JobStore(this.config.stateRoot);

  dispatch(input: DispatchInput): JobStatus {
    const harness = input.harness ?? this.config.defaultHarness;
    if (!isHarnessName(harness)) throw new Error(`Unknown harness: ${harness}`);
    const host = resolveHost(this.config, input.host);
    if (host.kind === "ssh" && harness === "omp") {
      throw new Error("OMP is not installed on this host. Use another harness or install OMP.");
    }
    const id = createId();
    const createdAt = new Date().toISOString();
    const spec: JobSpec = {
      id,
      title: input.title ?? input.prompt.slice(0, 80),
      prompt: input.prompt,
      harness,
      host: host.name,
      repo: input.repo,
      cwd: input.cwd,
      model: input.model ?? this.config.harnessModels?.[harness],
      baseRef: input.baseRef,
      isolate: input.isolate ?? Boolean(input.repo),
      parentId: input.parentId,
      pipelineId: input.pipelineId,
      labels: input.labels ?? [],
      createdAt,
      stateRoot: host.stateRoot,
      timeoutSeconds: Math.min(86_400, Math.max(30, input.timeoutSeconds ?? 3600)),
    };
    const localJobDir = join(this.config.stateRoot, "jobs", id);
    mkdirSync(localJobDir, { recursive: true });
    writeFileSync(join(localJobDir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
    const initial: JobStatus = {
      ...spec,
      state: "queued",
      updatedAt: createdAt,
      logPath: join(host.stateRoot, "jobs", id, "output.log"),
    };
    this.store.upsert(initial);

    let pid: number;
    if (host.kind === "local") {
      pid = spawnDetached("node", [join(repoRoot, "worker", "worker.mjs"), join(localJobDir, "spec.json")]);
    } else {
      pid = dispatchRemote(host, spec);
    }
    const started = { ...initial, state: "starting" as const, pid, updatedAt: new Date().toISOString() };
    this.store.upsert(started);
    return started;
  }

  reconcile(id?: string, discover = false): JobStatus[] {
    const jobs = id ? [this.store.get(id)].filter(Boolean) as JobStatus[] : this.store.list(500);
    const result: JobStatus[] = [];
    const remoteByHost = new Map<string, Map<string, JobStatus>>();
    if (!id) {
      for (const host of Object.values(this.config.hosts)) {
        if (host.kind !== "ssh") continue;
        const statuses = discoverRemote(host);
        remoteByHost.set(host.name, new Map(statuses.map((status) => [status.id, status])));
      }
    }
    for (const job of jobs) {
      const host = resolveHost(this.config, job.host);
      const current = host.kind === "local"
        ? this.store.importLocalStatus(job.id)
        : id
          ? readRemoteStatus(host, job.id)
          : remoteByHost.get(host.name)?.get(job.id);
      if (current) {
        const checked = this.markStale(current);
        this.store.upsert(checked);
        result.push(checked);
      } else {
        const checked = this.markStale(job);
        this.store.upsert(checked);
        result.push(checked);
      }
    }
    if (discover) {
      for (const statuses of remoteByHost.values()) {
        for (const remoteJob of statuses.values()) {
          this.store.upsert(remoteJob);
          if (!result.some((job) => job.id === remoteJob.id)) result.push(remoteJob);
        }
      }
    }
    return result;
  }

  get(id: string): JobStatus {
    this.reconcile(id);
    const job = this.store.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  list(limit = 50, state?: JobState): JobStatus[] {
    this.reconcile();
    return this.store.list(limit, state);
  }

  logs(id: string, lines = 100): string {
    const job = this.get(id);
    const host = resolveHost(this.config, job.host);
    if (host.kind === "ssh") return readRemoteLog(host, id, lines);
    const path = join(this.config.stateRoot, "jobs", id, "output.log");
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
  }

  cancel(id: string): void {
    const job = this.get(id);
    const host = resolveHost(this.config, job.host);
    if (host.kind === "ssh") cancelRemote(host, id);
    else if (job.pid) process.kill(job.pid, "SIGTERM");
    else throw new Error(`No live PID for ${id}.`);
  }

  handoff(id: string, harness: HarnessName, host?: string, extra?: string): JobStatus {
    const parent = this.get(id);
    const context = [
      `Continue job ${parent.id}: ${parent.title}`,
      `Parent state: ${parent.state}`,
      parent.repo ? `Repository: ${parent.repo}` : "",
      parent.worktree ? `Parent worktree: ${parent.worktree}` : "",
      parent.branch ? `Parent branch: ${parent.branch}` : "",
      "",
      "Parent result:",
      parent.result?.slice(-20000) || this.logs(id, 200),
      "",
      extra || "Inspect the current state, continue the work, and report the result.",
    ].filter(Boolean).join("\n");
    return this.dispatch({
      title: `handoff: ${parent.title}`,
      prompt: context,
      harness,
      host,
      repo: parent.repo,
      baseRef: parent.branch,
      isolate: Boolean(parent.repo),
      parentId: parent.id,
      labels: [...parent.labels, "handoff"],
    });
  }

  private markStale(job: JobStatus): JobStatus {
    if (job.result && ["succeeded", "failed"].includes(job.state)) {
      job = { ...job, result: extractHarnessResult(job.result) };
    }
    if (!["queued", "starting", "running"].includes(job.state)) return job;
    const heartbeat = job.heartbeatAt ?? job.updatedAt;
    if (Date.now() - new Date(heartbeat).getTime() < 90_000) return job;
    return {
      ...job,
      state: "lost",
      error: "The worker heartbeat is stale.",
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}
