import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { budgetState, zeroUsage } from "./budget";
import { createId } from "./id";
import { spawnDetached } from "./process";
import { MafiaService, type DispatchInput } from "./service";
import { buildContextPack } from "./context";
import { formatPacket } from "./packet";
import { rankTaskRoutes, routeTask } from "./router";
import { providerHeadroom, ProviderUsageService, unavailableProviders } from "./provider-usage";
import { usableMetrics } from "./bench";
import { catalogCandidates, ModelCatalogService, resolveCatalogModel } from "./models";
import { recommendParallelism } from "./scale";
import type {
  DecisionRecord,
  PipelineSpec,
  PipelineTask,
  TeamCheckpoint,
  TeamStatus,
  TeamTaskStatus,
} from "./types";
import { repoRoot } from "./config";
import { resetRemoteWorktree } from "./remote";
import { resolveHost } from "./config";

const terminalStates = new Set(["succeeded", "failed", "blocked", "cancelled"]);

export class TeamService {
  private readonly mafia = new MafiaService();
  private readonly teamsRoot = join(this.mafia.config.stateRoot, "teams");
  private readonly models = new ModelCatalogService(this.mafia.config.stateRoot);

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
      maxParallel: Math.min(128, Math.max(1, spec.maxParallel ?? 128)),
      currentParallel: 1,
      minParallel: Math.min(128, Math.max(1, spec.minParallel ?? 1)),
      autoScale: spec.autoScale ?? true,
      createdAt: now,
      updatedAt: now,
      tasks: spec.tasks.map((task) => ({ ...task, state: "waiting", attempts: 0 })),
      budget: { ...this.mafia.config.defaultBudget, ...spec.budget },
      usage: zeroUsage(),
      protocol: spec.protocol,
    };
    this.write(status);
    this.mafia.control.event({
      teamId: id,
      host: "local",
      actor: "lead",
      type: "team.created",
      data: { name: spec.name, taskCount: spec.tasks.length, protocol: spec.protocol },
    });
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
    if (team.state !== "queued" && team.state !== "running") return;
    if (team.state === "queued") {
      team.state = "running";
      this.write(team);
    }

    while (team.state === "running") {
      team = this.get(id);
      team = this.refreshJobs(team);
      team.usage = this.mafia.control.usage(team.id);
      const budget = budgetState(team, team.usage, Date.now(), this.mafia.store.usageByProvider(team.id));
      const budgetMode = budget.stop ? "stop" : budget.downgrade ? "downgrade" : budget.warning ? "warning" : "normal";
      if (budgetMode !== team.budgetMode) {
        team.budgetMode = budgetMode;
        this.mafia.control.event({
          teamId: team.id,
          host: "local",
          actor: "governor",
          type: `budget.${budgetMode}`,
          data: { percent: budget.percent, reasons: budget.reasons },
        });
      }
      if (budget.stop) {
        team = this.cancel(team.id);
        team.state = "failed";
        this.write(team);
        break;
      }
      if (team.paused) {
        this.write(team);
        await Bun.sleep(1000);
        continue;
      }
      this.blockFailedDependencies(team);
      const running = team.tasks.filter((task) => task.state === "running").length;
      const ready = team.tasks.filter((task) =>
        task.state === "waiting" &&
        (task.dependsOn ?? []).every((dependency) =>
          team.tasks.find((candidate) => candidate.id === dependency)?.state === "succeeded"
        )
      );
      if (budget.warning && team.budget?.minExpectedValue !== undefined) {
        for (const task of ready) {
          if (task.expectedValue === undefined || task.expectedValue >= team.budget.minExpectedValue) continue;
          task.state = "blocked";
          task.error = `The budget governor skipped expected value ${task.expectedValue}.`;
          this.mafia.control.event({
            teamId: team.id,
            host: task.host ?? "local",
            actor: "governor",
            type: "budget.low-value-stop",
            data: { taskId: task.id, expectedValue: task.expectedValue },
          });
        }
      }

      const hostCounts = new Map<string, number>();
      for (const task of team.tasks.filter((candidate) => candidate.state === "running")) {
        const host = task.host ?? this.mafia.config.defaultHost;
        hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
      }
      const completed = team.tasks.filter((task) => terminalStates.has(task.state)).length;
      const failures = team.tasks.filter((task) => ["failed", "blocked", "cancelled"].includes(task.state)).length;
      const hostCapacity = Object.values(this.mafia.config.hosts)
        .reduce((sum, host) => sum + (host.maxParallel ?? 16), 0);
      const scale = recommendParallelism({
        taskCount: team.tasks.length,
        readyCount: ready.length,
        running,
        completed,
        failures,
        hostCapacity,
        budgetWorkers: team.budget?.maxWorkers,
        minParallel: team.minParallel,
        maxParallel: team.maxParallel,
      });
      team.currentParallel = team.autoScale !== false ? scale.recommendedParallel : team.maxParallel;
      const slots = Math.max(0, team.currentParallel - running);
      let dispatched = 0;
      const pending: Array<{ task: TeamTaskStatus; hostName: string; input: DispatchInput }> = [];
      if (ready.length && running === 0) {
        team.checkpointId = this.checkpoint(team.id, `wave-${new Date().toISOString()}`).id;
      }
      const needsRouting = ready.some((task) => task.model || !task.harness);
      const catalog = needsRouting ? this.models.cached() ?? this.models.discover() : undefined;
      const candidates = catalog
        ? catalogCandidates(catalog, Object.keys(this.mafia.config.hosts), usableMetrics(this.mafia.config.stateRoot))
        : [];
      const routingHistory = needsRouting ? this.mafia.store.routingHistory() : new Map();
      // Read quota once per planning pass. A team plans many tasks, and asking
      // the provider for every one of them would be both slow and pointless.
      const quota = needsRouting
        ? new ProviderUsageService(this.mafia.config.stateRoot).discover()
        : undefined;
      const spentProviders = needsRouting
        ? unavailableProviders(quota, this.mafia.config.stateRoot)
        : new Set<string>();
      const headroom = (provider: string | undefined) => providerHeadroom(quota, provider);
      for (const task of ready) {
        if (dispatched >= slots) break;
        let route;
        if (task.model) {
          if (!catalog) throw new Error("The Mafia model catalog is unavailable.");
          const selected = resolveCatalogModel(catalog, task.model, task.harness);
          task.harness = selected.harness;
          task.model = selected.selector;
          task.host ??= this.mafia.config.defaultHost;
          const alternatives = rankTaskRoutes(this.mafia.config, {
            capability: task.capability ?? "general",
            host: task.host,
            downgrade: budget.downgrade,
            exhaustedProviders: spentProviders,
            headroom,
          }, routingHistory, candidates).filter((candidate) =>
            candidate.harness !== task.harness || candidate.model !== task.model || candidate.host !== task.host
          );
          if (task.allowFallback !== false && task.fallbackRoutes === undefined) {
            task.fallbackRoutes = alternatives
              .slice(0, task.retries ?? 1)
              .map(({ harness, model, host }) => ({ harness, model, host }));
          }
        } else if (!task.harness) {
          route = routeTask(this.mafia.config, {
              capability: task.capability ?? "general",
              preferredModels: task.preferredModels,
              host: task.host,
              downgrade: budget.downgrade,
              exhaustedProviders: spentProviders,
              headroom,
            }, routingHistory, candidates);
          if (task.allowFallback !== false && task.fallbackRoutes === undefined) {
            task.fallbackRoutes = rankTaskRoutes(this.mafia.config, {
              capability: task.capability ?? "general",
              host: task.host,
              downgrade: budget.downgrade,
              exhaustedProviders: spentProviders,
              headroom,
            }, routingHistory, candidates)
              .slice(1)
              .slice(0, task.retries ?? 1)
              .map(({ harness, model, host }) => ({ harness, model, host }));
          }
        }
        if (route) {
          task.harness = route.harness;
          task.host = route.host;
          task.model = route.model;
          this.mafia.control.event({
            teamId: team.id,
            host: route.host,
            actor: "router",
            type: "route.selected",
            data: { taskId: task.id, ...route },
          });
        }
        const hostName = task.host ?? this.mafia.config.defaultHost;
        const hostLimit = this.mafia.config.hosts[hostName]?.maxParallel ?? 16;
        if ((hostCounts.get(hostName) ?? 0) >= hostLimit) continue;
        const decisions = this.mafia.control.decisions(team.id);
        const contextPackPath = buildContextPack({
          stateRoot: this.mafia.config.stateRoot,
          teamId: team.id,
          task,
          decisions,
          vaultRoot: this.mafia.config.vaultRoot,
          repoRules: this.repoRules(task.repo),
        });
        const prompt = this.workerPrompt(team, task, contextPackPath);
        // Planning stays in order because it consumes the wave's slots and the
        // per-host limits. Only the launches are collected to run together.
        pending.push({
          task,
          hostName,
          input: {
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
            taskId: task.id,
            contextPackPath,
            budget: team.budget,
          },
        });
        hostCounts.set(hostName, (hostCounts.get(hostName) ?? 0) + 1);
        dispatched++;
      }

      if (pending.length) {
        // Each launch is a round trip. Starting a wave one at a time spent most
        // of the wave waiting on the network.
        const started = await this.mafia.dispatchMany(
          pending.map((entry) => entry.input),
          Math.max(1, Math.min(8, pending.length)),
        );
        for (const [index, entry] of pending.entries()) {
          const job = started[index];
          if (!job) {
            entry.task.state = "failed";
            entry.task.error = "The worker did not start.";
            hostCounts.set(entry.hostName, Math.max(0, (hostCounts.get(entry.hostName) ?? 1) - 1));
            continue;
          }
          entry.task.jobId = job.id;
          entry.task.state = "running";
          entry.task.attempts++;
          this.mafia.control.send({
            teamId: team.id,
            room: `team:${team.id}`,
            from: "scheduler",
            type: "handoff",
            body: `Started ${entry.task.id} with ${job.harness}@${job.host}.`,
            jobId: job.id,
            host: job.host,
          });
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

  pause(id: string): TeamStatus {
    const team = this.get(id);
    team.paused = true;
    for (const task of team.tasks) {
      if (task.state === "running" && task.jobId) this.mafia.controlJob(task.jobId, "pause");
    }
    this.mafia.control.event({
      teamId: id,
      host: "local",
      actor: "lead",
      type: "team.paused",
      data: {},
    });
    this.write(team);
    return team;
  }

  resume(id: string): TeamStatus {
    const team = this.get(id);
    team.paused = false;
    for (const task of team.tasks) {
      if (task.state === "running" && task.jobId) this.mafia.controlJob(task.jobId, "resume");
    }
    this.mafia.control.event({
      teamId: id,
      host: "local",
      actor: "lead",
      type: "team.resumed",
      data: {},
    });
    this.write(team);
    return team;
  }

  addTask(id: string, task: PipelineTask): TeamStatus {
    const team = this.get(id);
    if (team.tasks.some((item) => item.id === task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
    validatePipeline({ name: team.name, tasks: [...team.tasks, task] });
    team.tasks.push({ ...task, state: "waiting", attempts: 0 });
    if (team.state === "succeeded" || team.state === "failed") {
      team.state = "running";
      team.completedAt = undefined;
      spawnDetached("bun", [join(repoRoot, "src", "cli.ts"), "__team-run", id], repoRoot);
    }
    this.mafia.control.event({
      teamId: id,
      host: "local",
      actor: "lead",
      type: "team.task-added",
      data: { taskId: task.id },
    });
    this.write(team);
    return team;
  }

  updateTask(id: string, taskId: string, patch: Partial<PipelineTask>): TeamStatus {
    const team = this.get(id);
    const task = team.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.state === "running" && task.jobId && (patch.prompt || patch.harness || patch.model || patch.host)) {
      this.mafia.controlJob(task.jobId, "redirect", {
        prompt: patch.prompt,
        harness: patch.harness,
        model: patch.model,
        host: patch.host,
      });
    }
    Object.assign(task, patch);
    validatePipeline({ name: team.name, tasks: team.tasks });
    this.mafia.control.event({
      teamId: id,
      jobId: task.jobId,
      host: task.host ?? "local",
      actor: "lead",
      type: "team.task-updated",
      data: { taskId, patch },
    });
    this.write(team);
    return team;
  }

  retryTask(id: string, taskId: string, replacement?: Partial<PipelineTask>): TeamStatus {
    const team = this.get(id);
    const task = team.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.state === "running" && task.jobId) {
      try {
        this.mafia.cancel(task.jobId);
      } catch {}
    }
    Object.assign(task, replacement ?? {});
    task.state = "waiting";
    task.jobId = undefined;
    task.error = undefined;
    if (team.state !== "running") {
      team.state = "running";
      team.completedAt = undefined;
      spawnDetached("bun", [join(repoRoot, "src", "cli.ts"), "__team-run", id], repoRoot);
    }
    this.write(team);
    return team;
  }

  recordDecision(id: string, input: Omit<DecisionRecord, "id" | "teamId" | "createdAt">): DecisionRecord {
    const decision = this.mafia.control.decision({ ...input, teamId: id });
    this.mafia.sendMessage({
      teamId: id,
      from: "decision-ledger",
      type: "finding",
      body: `Decision: ${decision.question}\nSelected: ${decision.selected}`,
    });
    return decision;
  }

  checkpoint(id: string, name = "manual"): TeamCheckpoint {
    const team = this.get(id);
    const branches = team.tasks.map((task) => {
      const job = task.jobId ? this.mafia.store.get(task.jobId) : undefined;
      let sha: string | undefined;
      if (job?.worktree && existsSync(join(job.worktree, ".git"))) {
        try {
          sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: job.worktree, encoding: "utf8" }).trim();
        } catch {}
      }
      return { taskId: task.id, jobId: task.jobId, branch: job?.branch, worktree: job?.worktree, sha };
    });
    const checkpoint: TeamCheckpoint = {
      id: createId("checkpoint"),
      teamId: id,
      name,
      createdAt: new Date().toISOString(),
      team: structuredClone(team),
      branches,
      decisionIds: this.mafia.control.decisions(id).map((decision) => decision.id),
    };
    this.mafia.control.checkpoint(checkpoint);
    return checkpoint;
  }

  restore(checkpointId: string): TeamStatus {
    const checkpoint = this.mafia.control.getCheckpoint(checkpointId);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${checkpointId}`);
    const current = this.get(checkpoint.teamId);
    for (const task of current.tasks) {
      if (task.state === "running" && task.jobId) {
        try {
          this.mafia.cancel(task.jobId);
        } catch {}
      }
    }
    for (const branch of checkpoint.branches) {
      if (!branch.sha || !branch.worktree) continue;
      const job = branch.jobId ? this.mafia.store.get(branch.jobId) : undefined;
      if (job?.host && job.host !== "local") {
        try {
          resetRemoteWorktree(resolveHost(this.mafia.config, job.host), branch.worktree, branch.sha);
        } catch {}
        continue;
      }
      if (!existsSync(branch.worktree)) continue;
      try {
        execFileSync("git", ["reset", "--hard", branch.sha], { cwd: branch.worktree, stdio: "ignore" });
        execFileSync("git", ["clean", "-fd"], { cwd: branch.worktree, stdio: "ignore" });
      } catch {}
    }
    const restored = structuredClone(checkpoint.team);
    for (const task of restored.tasks) {
      if (task.state !== "succeeded") {
        task.state = "waiting";
        task.jobId = undefined;
        task.error = undefined;
      }
    }
    restored.paused = true;
    restored.state = "running";
    restored.completedAt = undefined;
    restored.checkpointId = checkpoint.id;
    this.write(restored);
    return restored;
  }

  collect(id: string): string {
    const team = this.get(id);
    const jobs = new Map(this.mafia.reconcile().map((job) => [job.id, job]));
    const sections = team.tasks.map((task) => {
      if (!task.jobId) return `## ${task.id}\nstate: ${task.state}\n${task.error ?? ""}`.trim();
      const job = jobs.get(task.jobId) ?? this.mafia.get(task.jobId);
      const result = formatPacket(job);
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
          const fallback = task.allowFallback === false ? undefined : task.fallbackRoutes?.shift();
          if (fallback) {
            task.harness = fallback.harness;
            task.model = fallback.model;
            task.host = fallback.host;
            this.mafia.control.event({
              teamId: team.id,
              jobId: job.id,
              host: fallback.host,
              actor: "router",
              type: "route.fallback",
              data: { taskId: task.id, attempt: task.attempts + 1, ...fallback },
            });
          }
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

  private workerPrompt(team: TeamStatus, task: TeamTaskStatus, contextPackPath?: string): string {
    const dependencies = (task.dependsOn ?? []).map((id) => {
      const dependency = team.tasks.find((candidate) => candidate.id === id);
      if (!dependency?.jobId) return "";
      const job = this.mafia.get(dependency.jobId);
      return `### ${id}\n${formatPacket(job)}`;
    }).filter(Boolean);
    return [
      `You are worker ${task.id} in Mafia team ${team.id}.`,
      `Team goal: ${team.goal}`,
      `Your assignment: ${task.prompt}`,
      `Team roster:\n${team.tasks.map((item) => `- ${item.id}: ${item.title ?? item.prompt.slice(0, 100)}`).join("\n")}`,
      "",
      `Use the Mafia communication command: mafia-agent.`,
      `Read messages with: mafia-agent inbox --read`,
      `Send a finding with: mafia-agent send --type finding --body "..."`,
      `Send a blocker with: mafia-agent send --type blocker --body "..."`,
      `Send a direct message with: mafia-agent send --to JOB_ID --body "..."`,
      `Reference large outputs with: mafia-agent artifact PATH --description "..."`,
      `Check the inbox after each major work step.`,
      contextPackPath ? `Context pack: ${contextPackPath}` : "",
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

  private repoRules(repo?: string): string | undefined {
    if (!repo) return undefined;
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(repo, name);
      if (existsSync(path)) return readFileSync(path, "utf8").slice(0, 40_000);
    }
    return undefined;
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
