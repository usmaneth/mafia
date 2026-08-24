import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createId } from "./id";
import { spawnDetached } from "./process";
import { MafiaService } from "./service";
import type { PipelineSpec, TeamStatus, TeamTaskStatus } from "./types";
import { repoRoot } from "./config";

const terminalStates = new Set(["succeeded", "failed", "blocked", "cancelled"]);

export class TeamService {
  private readonly mafia = new MafiaService();
  private readonly teamsRoot = join(this.mafia.config.stateRoot, "teams");

  constructor() {
    mkdirSync(this.teamsRoot, { recursive: true });
  }

  create(goal: string, spec: PipelineSpec): TeamStatus {
    validatePipeline(spec);
    const id = createId("team");
    const now = new Date().toISOString();
    const status: TeamStatus = {
      id,
      name: spec.name,
      goal,
      state: "queued",
      maxParallel: Math.min(128, Math.max(1, spec.maxParallel ?? 16)),
      createdAt: now,
      updatedAt: now,
      tasks: spec.tasks.map((task) => ({ ...task, state: "waiting", attempts: 0 })),
    };
    this.write(status);
    spawnDetached("bun", [join(repoRoot, "src", "cli.ts"), "__team-run", id], repoRoot);
    return status;
  }

  get(id: string): TeamStatus {
    const path = this.statusPath(id);
    if (!existsSync(path)) throw new Error(`Unknown team: ${id}`);
    return JSON.parse(readFileSync(path, "utf8")) as TeamStatus;
  }

  list(limit = 30): TeamStatus[] {
    if (!existsSync(this.teamsRoot)) return [];
    return readdirSync(this.teamsRoot)
      .map((id) => {
        try {
          return this.get(id);
        } catch {
          return undefined;
        }
      })
      .filter((team): team is TeamStatus => Boolean(team))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async run(id: string): Promise<void> {
    let team = this.get(id);
    if (team.state !== "queued") return;
    team.state = "running";
    this.write(team);

    while (team.state === "running") {
      team = this.refreshJobs(team);
      this.blockFailedDependencies(team);
      const running = team.tasks.filter((task) => task.state === "running").length;
      const ready = team.tasks.filter((task) =>
        task.state === "waiting" &&
        (task.dependsOn ?? []).every((dependency) =>
          team.tasks.find((candidate) => candidate.id === dependency)?.state === "succeeded"
        )
      );

      const hostCounts = new Map<string, number>();
      for (const task of team.tasks.filter((candidate) => candidate.state === "running")) {
        const host = task.host ?? this.mafia.config.defaultHost;
        hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
      }
      const slots = Math.max(0, team.maxParallel - running);
      let dispatched = 0;
      for (const task of ready) {
        if (dispatched >= slots) break;
        const hostName = task.host ?? this.mafia.config.defaultHost;
        const hostLimit = this.mafia.config.hosts[hostName]?.maxParallel ?? 16;
        if ((hostCounts.get(hostName) ?? 0) >= hostLimit) continue;
        const prompt = this.workerPrompt(team, task);
        try {
          const job = this.mafia.dispatch({
            title: task.title ?? `${team.name}: ${task.id}`,
            prompt,
            harness: task.harness,
            host: task.host,
            repo: task.repo,
            cwd: task.cwd,
            model: task.model,
            baseRef: task.baseRef,
            isolate: task.isolate,
            pipelineId: team.id,
            labels: [...(task.labels ?? []), `team:${team.id}`, `task:${task.id}`],
            timeoutSeconds: task.timeoutSeconds,
          });
          task.jobId = job.id;
          task.state = "running";
          task.attempts++;
          hostCounts.set(hostName, (hostCounts.get(hostName) ?? 0) + 1);
          dispatched++;
        } catch (error) {
          task.state = "failed";
          task.error = error instanceof Error ? error.message : String(error);
        }
      }

      if (team.tasks.every((task) => terminalStates.has(task.state))) {
        team.state = team.tasks.every((task) => task.state === "succeeded") ? "succeeded" : "failed";
        team.completedAt = new Date().toISOString();
      }
      this.write(team);
      if (team.state === "running") await Bun.sleep(2000);
    }
  }

  cancel(id: string): TeamStatus {
    const team = this.get(id);
    for (const task of team.tasks) {
      if (task.state === "running" && task.jobId) {
        try {
          this.mafia.cancel(task.jobId);
        } catch {}
        task.state = "cancelled";
      } else if (task.state === "waiting") {
        task.state = "cancelled";
      }
    }
    team.state = "cancelled";
    team.completedAt = new Date().toISOString();
    this.write(team);
    return team;
  }

  collect(id: string): string {
    const team = this.get(id);
    const jobs = new Map(this.mafia.reconcile().map((job) => [job.id, job]));
    const sections = team.tasks.map((task) => {
      if (!task.jobId) return `## ${task.id}\nstate: ${task.state}\n${task.error ?? ""}`.trim();
      const job = jobs.get(task.jobId) ?? this.mafia.get(task.jobId);
      const result = job.result?.slice(-30000) || this.mafia.logs(job.id, 200);
      return [
        `## ${task.id} - ${task.title ?? task.prompt.slice(0, 60)}`,
        `state: ${task.state}`,
        `worker: ${job.harness} on ${job.host}`,
        job.branch ? `branch: ${job.branch}` : "",
        "",
        result,
      ].filter(Boolean).join("\n");
    });
    return [
      `# ${team.name}`,
      `team: ${team.id}`,
      `state: ${team.state}`,
      `goal: ${team.goal}`,
      "",
      ...sections,
    ].join("\n\n");
  }

  private refreshJobs(team: TeamStatus): TeamStatus {
    const jobs = new Map(this.mafia.reconcile().map((job) => [job.id, job]));
    for (const task of team.tasks) {
      if (task.state !== "running" || !task.jobId) continue;
      const job = jobs.get(task.jobId);
      if (!job) continue;
      if (job.state === "succeeded") task.state = "succeeded";
      else if (["failed", "cancelled", "lost"].includes(job.state)) {
        if (job.state !== "cancelled" && task.attempts <= (task.retries ?? 1)) {
          task.state = "waiting";
          task.jobId = undefined;
          task.error = `Attempt ${task.attempts} failed: ${job.error ?? job.state}`;
        } else {
          task.state = job.state === "cancelled" ? "cancelled" : "failed";
          task.error = job.error;
        }
      }
    }
    return team;
  }

  private blockFailedDependencies(team: TeamStatus): void {
    for (const task of team.tasks) {
      if (task.state !== "waiting") continue;
      const failed = (task.dependsOn ?? []).find((dependency) => {
        const state = team.tasks.find((candidate) => candidate.id === dependency)?.state;
        return state === "failed" || state === "blocked" || state === "cancelled";
      });
      if (failed) {
        task.state = "blocked";
        task.error = `Dependency ${failed} did not succeed.`;
      }
    }
  }

  private workerPrompt(team: TeamStatus, task: TeamTaskStatus): string {
    const dependencies = (task.dependsOn ?? []).map((id) => {
      const dependency = team.tasks.find((candidate) => candidate.id === id);
      if (!dependency?.jobId) return "";
      const job = this.mafia.get(dependency.jobId);
      return `### ${id}\n${job.result?.slice(-20000) || this.mafia.logs(job.id, 120)}`;
    }).filter(Boolean);
    return [
      `You are worker ${task.id} in Mafia team ${team.id}.`,
      `Team goal: ${team.goal}`,
      `Your assignment: ${task.prompt}`,
      `Team roster:\n${team.tasks.map((item) => `- ${item.id}: ${item.title ?? item.prompt.slice(0, 100)}`).join("\n")}`,
      "",
      "Work independently in your assigned workspace.",
      "Do not merge, push, or open a pull request unless the assignment requires it.",
      "Report concrete results, changed files, tests, blockers, and the next handoff.",
      dependencies.length ? "\nDependency results:\n" + dependencies.join("\n\n") : "",
    ].filter(Boolean).join("\n");
  }

  private statusPath(id: string): string {
    return join(this.teamsRoot, id, "status.json");
  }

  private write(team: TeamStatus): void {
    team.updatedAt = new Date().toISOString();
    const path = this.statusPath(team.id);
    mkdirSync(join(this.teamsRoot, team.id), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(team, null, 2)}\n`);
    renameSync(temp, path);
  }
}

export function validatePipeline(spec: PipelineSpec): void {
  if (!spec.name.trim()) throw new Error("The team name is required.");
  if (spec.tasks.length < 1 || spec.tasks.length > 128) {
    throw new Error("A team must contain 1 to 128 tasks.");
  }
  const ids = new Set<string>();
    for (const task of spec.tasks) {
    if (!task.id.match(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)) {
      throw new Error(`Invalid task ID: ${task.id}`);
    }
    if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
    ids.add(task.id);
    if ((task.retries ?? 1) < 0 || (task.retries ?? 1) > 5) {
      throw new Error(`Task ${task.id} retries must be between 0 and 5.`);
    }
    if ((task.timeoutSeconds ?? 3600) < 30 || (task.timeoutSeconds ?? 3600) > 86_400) {
      throw new Error(`Task ${task.id} timeoutSeconds must be between 30 and 86400.`);
    }
  }
  for (const task of spec.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} has unknown dependency ${dependency}.`);
      if (dependency === task.id) throw new Error(`Task ${task.id} depends on itself.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(spec.tasks.map((task) => [task.id, task]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`The team graph contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}
