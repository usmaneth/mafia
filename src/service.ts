import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, resolveHost, repoRoot } from "./config";
import { createId } from "./id";
import { isHarnessName } from "./harnesses";
import { codexOAuthEnvironment, spawnDetached } from "./process";
import {
  appendRemoteControl,
  appendRemoteMessage,
  cancelRemote,
  dispatchRemote,
  dispatchRemoteAsync,
  discoverRemote,
  discoverRemoteEvents,
  compareRemoteBranches,
  readRemoteLog,
  readRemoteStatus,
} from "./remote";
import { JobStore } from "./store";
import { extractHarnessResult } from "./result";
import { buildHandoffPacket } from "./packet";
import { ControlPlane } from "./control";
import { ModelCatalogService, resolveCatalogModel } from "./models";
import { detectHarnessModel } from "./harness-model";
import { healthyRoleModels, readConfiguredRoles } from "./roles";
import {
  isQuotaFailure,
  penaliseProvider,
  providerOfSelector,
  ProviderUsageService,
  substituteExhaustedModel,
  unavailableProviders,
} from "./provider-usage";
import type {
  ArtifactRef,
  HarnessName,
  HostConfig,
  JobSpec,
  JobState,
  JobStatus,
  MafiaMessage,
  MessageType,
  TeamBudget,
} from "./types";

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
  taskId?: string;
  contextPackPath?: string;
  budget?: TeamBudget;
  prewalk?: boolean;
  prewalkInto?: string;
  session?: boolean;
}

export class MafiaService {
  readonly config = loadConfig();
  readonly store = new JobStore(this.config.stateRoot);
  readonly control = new ControlPlane(this.config.stateRoot);
  readonly models = new ModelCatalogService(this.config.stateRoot);

  dispatch(input: DispatchInput): JobStatus {
    const { initial, spec, localJobDir } = this.prepare(input);
    const host = resolveHost(this.config, input.host);
    return this.launch(host, spec, initial, localJobDir);
  }

  private prepare(input: DispatchInput): { initial: JobStatus; spec: JobSpec; localJobDir: string } {
    let harness = input.harness;
    let model = input.model;
    let modelSource: JobSpec["modelSource"] = model ? "requested" : undefined;
    if (model) {
      try {
        const selected = resolveCatalogModel(
          this.models.cached() ?? this.models.discover(),
          model,
          harness && isHarnessName(harness) ? harness : undefined,
        );
        harness ??= selected.harness;
        model = selected.selector;
      } catch (error) {
        if (!harness) throw error;
      }
    }
    harness ??= this.config.defaultHarness;
    // Re-check quota at dispatch, not only when a team was planned. Planning can
    // happen an hour before the work runs, and an explicit --model never went
    // through the router at all, so this is the only point that sees every job.
    const swap = isHarnessName(harness) ? this.avoidExhaustedProvider(model, harness) : undefined;
    if (swap) {
      model = swap.model;
      harness = swap.harness;
      modelSource = "quota-substituted";
    }
    // Assert last, so the narrowing covers every use below the substitution.
    if (!isHarnessName(harness)) throw new Error(`Unknown harness: ${harness}`);
    const host = resolveHost(this.config, input.host);
    const configuredModel = this.config.harnessModels?.[harness];
    if (!model && configuredModel) {
      model = configuredModel;
      modelSource = "configured";
    }
    if (!model) {
      model = detectHarnessModel(harness, {
        catalog: this.models.cached(),
      });
      if (model) modelSource = "detected";
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
      model,
      modelSource,
      baseRef: input.baseRef,
      isolate: input.isolate ?? Boolean(input.repo),
      parentId: input.parentId,
      pipelineId: input.pipelineId,
      labels: input.labels ?? [],
      createdAt,
      stateRoot: host.stateRoot,
      timeoutSeconds: Math.min(86_400, Math.max(30, input.timeoutSeconds ?? 3600)),
      taskId: input.taskId,
      contextPackPath: input.contextPackPath,
      budget: input.budget,
      roleModels: harness === "omp" ? this.healthyRoles() : undefined,
      prewalk: input.prewalk,
      prewalkInto: input.prewalkInto,
      session: input.session ?? this.config.ompSessions,
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
    this.control.event({
      teamId: spec.pipelineId,
      jobId: spec.id,
      host: spec.host,
      actor: "lead",
      type: "job.queued",
      data: { harness: spec.harness, model: spec.model, title: spec.title, taskId: spec.taskId },
    });

    return { initial, spec, localJobDir };
  }

  private launch(host: HostConfig, spec: JobSpec, initial: JobStatus, localJobDir: string): JobStatus {
    const pid = host.kind === "local"
      ? spawnDetached(
        "node",
        [join(repoRoot, "worker", "worker.mjs"), join(localJobDir, "spec.json")],
        undefined,
        codexOAuthEnvironment(),
      )
      : dispatchRemote(host, spec);
    return this.recordStarted(initial, pid);
  }

  /**
   * Dispatch several jobs, overlapping the remote launches.
   *
   * Planning each job is local and quick; the launch is a round trip. Starting
   * a wave of sixty-four tasks one at a time spent most of its time waiting, so
   * the launches run together with a bound that keeps the host comfortable.
   */
  async dispatchMany(inputs: DispatchInput[], concurrency = 8): Promise<JobStatus[]> {
    const results: JobStatus[] = new Array(inputs.length);
    let next = 0;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= inputs.length) return;
        const input = inputs[index]!;
        const host = resolveHost(this.config, input.host);
        if (host.kind === "local") {
          results[index] = this.dispatch(input);
          continue;
        }
        const { initial, spec } = this.prepare(input);
        results[index] = this.recordStarted(initial, await dispatchRemoteAsync(host, spec));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, inputs.length)) }, worker));
    return results;
  }

  private recordStarted(initial: JobStatus, pid: number): JobStatus {
    const started = { ...initial, state: "starting" as const, pid, updatedAt: new Date().toISOString() };
    this.store.upsert(started);
    return started;
  }

  reconcile(id?: string, discover = false): JobStatus[] {
    const undelivered = this.store.listUndeliveredMessages();
    if (undelivered.length) {
      const known = this.store.list(500);
      for (const message of undelivered) this.deliverMessage(message, known);
    }
    const jobs = id ? [this.store.get(id)].filter(Boolean) as JobStatus[] : this.store.list(500);
    const result: JobStatus[] = [];
    const remoteByHost = new Map<string, Map<string, JobStatus>>();
    const pendingMessages: MafiaMessage[] = [];
    const failures: JobStatus[] = [];
    if (!id) {
      for (const host of Object.values(this.config.hosts)) {
        if (host.kind !== "ssh") continue;
        // A discovery pass must see every job, not only the ones written since
        // the last read, or it cannot find jobs the local store never knew.
        const statuses = discoverRemote(host, { full: discover });
        remoteByHost.set(host.name, new Map(statuses.map((status) => [status.id, status])));
        const remote = discoverRemoteEvents(host);
        this.store.transaction(() => {
          for (const event of remote.events) this.store.insertEvent(event);
          for (const message of remote.messages) {
            if (this.store.insertMessage(message)) pendingMessages.push(message);
          }
        });
      }
    }
    this.store.transaction(() => {
      for (const job of jobs) {
        const host = resolveHost(this.config, job.host);
        const current = host.kind === "local"
          ? this.store.importLocalStatus(job.id)
          : id
            ? readRemoteStatus(host, job.id)
            : remoteByHost.get(host.name)?.get(job.id);
        if (current) {
          const checked = this.markStale(current);
          const wasFailed = job.state === "failed";
          this.store.upsert(checked);
          this.store.upsertUsage(checked);
          if (!wasFailed) failures.push(checked);
          result.push(checked);
        } else {
          const checked = this.markStale(job);
          this.store.upsert(checked);
          result.push(checked);
        }
      }
      if (discover) {
        const seen = new Set(result.map((job) => job.id));
        for (const statuses of remoteByHost.values()) {
          for (const remoteJob of statuses.values()) {
            this.store.upsert(remoteJob);
            if (!seen.has(remoteJob.id)) {
              seen.add(remoteJob.id);
              result.push(remoteJob);
            }
          }
        }
      }
    });
    // Both of these touch the control plane, so they run outside the transaction.
    for (const job of failures) this.noteProviderFailure(job);
    // Delivery opens SSH connections, so it must run outside the transaction.
    if (pendingMessages.length) {
      for (const message of pendingMessages) this.deliverMessage(message, result);
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

  listCached(limit = 50, state?: JobState): JobStatus[] {
    return this.store.list(limit, state);
  }

  reconcileLocal(): JobStatus[] {
    for (const job of this.store.list(500).filter((item) =>
      item.host === "local" && ["queued", "starting", "running"].includes(item.state)
    )) {
      const current = this.store.importLocalStatus(job.id);
      const checked = this.markStale(current ?? job);
      this.store.upsert(checked);
      this.store.upsertUsage(checked);
    }
    return this.store.list(500);
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

  sendMessage(input: {
    teamId?: string;
    room?: string;
    from?: string;
    to?: string;
    type?: MessageType;
    body: string;
    artifacts?: ArtifactRef[];
  }): MafiaMessage {
    const message = this.control.send({
      ...input,
      from: input.from ?? "lead",
      host: "local",
    });
    this.deliverMessage(message);
    return message;
  }

  controlJob(id: string, action: string, data: Record<string, unknown> = {}): void {
    const job = this.get(id);
    const event = this.control.control(id, action, data);
    const host = resolveHost(this.config, job.host);
    if (host.kind === "ssh") appendRemoteControl(host, id, event);
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

  compare(leftId: string, rightId: string): string {
    const left = this.get(leftId);
    const right = this.get(rightId);
    if (left.host !== right.host) {
      return [
        "The jobs use different hosts.",
        `${left.id}: ${left.host} ${left.branch ?? "-"}`,
        `${right.id}: ${right.host} ${right.branch ?? "-"}`,
        "Move or fetch one branch before a content diff.",
      ].join("\n");
    }
    if (!left.branch || !right.branch || !left.worktree) {
      throw new Error("Both jobs must have isolated Git branches.");
    }
    const host = resolveHost(this.config, left.host);
    if (host.kind === "ssh") return compareRemoteBranches(host, left.worktree, left.branch, right.branch);
    const stat = execFileSync("git", ["diff", "--stat", `${left.branch}...${right.branch}`], {
      cwd: left.worktree,
      encoding: "utf8",
    });
    const names = execFileSync("git", ["diff", "--name-status", `${left.branch}...${right.branch}`], {
      cwd: left.worktree,
      encoding: "utf8",
    });
    return `${stat}\n${names}`.trim();
  }

  /**
   * Move a job off a provider that has no quota left.
   *
   * Returns another route to the same model, never a smaller one. Dropping a
   * caller to a weaker model without asking changes the result they get; taking
   * the identical model through a different account does not.
   */
  private avoidExhaustedProvider(
    model: string | undefined,
    harness: HarnessName,
  ): { model: string; harness: HarnessName } | undefined {
    if (!model) return undefined;
    const catalog = this.models.cached();
    if (!catalog) return undefined;
    const usage = new ProviderUsageService(this.config.stateRoot).discover();
    const requested = catalog.models.find((entry) =>
      entry.selector === model || `${entry.selector}:` === model.slice(0, entry.selector.length + 1));
    if (!requested) return undefined;
    const blocked = unavailableProviders(usage, this.config.stateRoot);
    if (!blocked.has(requested.provider)) return undefined;
    const found = substituteExhaustedModel(catalog.models, requested, usage, 0, blocked);
    if (!found || !isHarnessName(found.model.harness)) return undefined;
    // Carry any effort suffix across to the replacement.
    const suffix = model.slice(requested.selector.length);
    this.control.event({
      host: "local",
      actor: "lead",
      type: "route.quota-substituted",
      data: { ...found.substitution },
    });
    return { model: `${found.model.selector}${suffix}`, harness: found.model.harness };
  }

  /**
   * Bench the provider behind a job that failed for a quota or auth reason.
   *
   * Polled quota cannot see a window emptying between reads, and it never sees
   * an account losing authorisation. The failure itself is the signal.
   */
  private noteProviderFailure(job: JobStatus): void {
    if (job.state !== "failed" || !isQuotaFailure(job.error)) return;
    const provider = providerOfSelector(job.model);
    if (!provider) return;
    penaliseProvider(this.config.stateRoot, provider, job.error ?? "provider refused the request");
    this.control.event({
      jobId: job.id,
      host: job.host,
      actor: "lead",
      type: "route.provider-benched",
      data: { provider, error: (job.error ?? "").slice(0, 200) },
    });
  }

  /**
   * OMP role overrides for this dispatch, or nothing when the profile is fine.
   *
   * Cached for the life of the service so a team of sixty-four tasks reads the
   * profile once rather than once per task.
   */
  private roleCache?: { overrides: ReturnType<typeof healthyRoleModels>["overrides"] };

  private healthyRoles() {
    if (!this.roleCache) {
      const usage = new ProviderUsageService(this.config.stateRoot).discover();
      const result = healthyRoleModels(
        readConfiguredRoles(),
        this.models.cached(),
        usage,
        this.config.stateRoot,
      );
      for (const change of result.changes) {
        this.control.event({
          host: "local",
          actor: "lead",
          type: "route.role-repinned",
          data: { ...change },
        });
      }
      this.roleCache = { overrides: result.overrides };
    }
    return Object.keys(this.roleCache.overrides).length ? this.roleCache.overrides : undefined;
  }

  private markStale(job: JobStatus): JobStatus {
    if (job.result && ["succeeded", "failed"].includes(job.state)) {
      job = { ...job, result: extractHarnessResult(job.result) };
      job.packet = job.packet ?? buildHandoffPacket(job);
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

  /**
   * Deliver a message to every job that should receive it.
   *
   * `jobs` is passed in when several messages are delivered together. Without
   * it each message re-reads and re-parses the whole job table.
   */
  private deliverMessage(message: MafiaMessage, known?: JobStatus[]): void {
    const jobs = known ?? this.store.list(500);
    const recipients = message.to?.startsWith("job-")
      ? jobs.filter((job) => job.id === message.to)
      : message.teamId
        ? jobs.filter((job) =>
            job.pipelineId === message.teamId &&
            job.id !== message.from &&
            ["queued", "starting", "running"].includes(job.state)
          )
        : [];
    for (const job of recipients) {
      const host = resolveHost(this.config, job.host);
      const direct = { ...message, to: job.id };
      if (host.kind === "ssh") appendRemoteMessage(host, direct);
      else this.control.deliverToLocalJob(direct, job.id);
    }
    if (recipients.length) this.store.markMessageDelivered(message.id, new Date().toISOString());
  }
}
