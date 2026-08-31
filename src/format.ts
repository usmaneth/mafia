import { budgetState } from "./budget";
import { agentDisplayName, isActiveAgent } from "./agent-display";
import type { JobStatus, MafiaMessage, ModelCatalog, ModelRecord, PrOperationalState, PrTelemetry, TeamStatus, VpsTelemetry } from "./types";

function age(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function fit(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}~` : value.padEnd(width);
}

export function formatJobs(jobs: JobStatus[]): string {
  if (!jobs.length) return "no Mafia jobs";
  const lines = [
    `${fit("ID", 24)} ${fit("STATE", 10)} ${fit("WORKER", 10)} ${fit("HOST", 7)} ${fit("AGE", 5)} TITLE`,
  ];
  for (const job of jobs) {
    lines.push(
      `${fit(job.id, 24)} ${fit(job.state, 10)} ${fit(job.harness, 10)} ${fit(job.host, 7)} ${fit(age(job.updatedAt), 5)} ${job.title}`,
    );
  }
  return lines.join("\n");
}

export function formatTeams(teams: TeamStatus[]): string {
  if (!teams.length) return "no Mafia teams";
  const lines = [
    `${fit("ID", 25)} ${fit("STATE", 10)} ${fit("DONE", 9)} ${fit("ACTIVE", 7)} ${fit("AGE", 5)} NAME`,
  ];
  for (const team of teams) {
    const done = team.tasks.filter((task) => task.state === "succeeded").length;
    const active = team.tasks.filter((task) => task.state === "running").length;
    lines.push(
      `${fit(team.id, 25)} ${fit(team.state, 10)} ${fit(`${done}/${team.tasks.length}`, 9)} ${fit(String(active), 7)} ${fit(age(team.updatedAt), 5)} ${team.name}`,
    );
  }
  return lines.join("\n");
}

export function formatTeam(team: TeamStatus): string {
  const budget = budgetState(team, team.usage ?? {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costUsd: 0, requests: 0, failures: 0, runtimeSeconds: 0,
  });
  const lines = [
    `${team.name} (${team.id})`,
    `state: ${team.state}`,
    `goal: ${team.goal}`,
    `parallel: ${team.currentParallel ?? team.maxParallel}/${team.maxParallel}${team.autoScale !== false ? " - auto" : " - fixed"}`,
    `paused: ${team.paused ? "yes" : "no"}`,
    `budget: ${budget.percent.toFixed(1)}%${budget.downgrade ? " - downgrade" : ""}${budget.stop ? " - stopped" : ""}`,
    "",
    `${fit("TASK", 20)} ${fit("STATE", 10)} ${fit("WORKER", 10)} ${fit("HOST", 7)} JOB`,
  ];
  for (const task of team.tasks) {
    lines.push(
      `${fit(task.id, 20)} ${fit(task.state, 10)} ${fit(task.harness ?? "-", 10)} ${fit(task.host ?? "local", 7)} ${task.jobId ?? "-"}`,
    );
  }
  return lines.join("\n");
}

export type AgentDashboardFilter = "all" | "active" | "failed" | "vps" | "local";

export function agentDashboardJobs(jobs: JobStatus[], filter: AgentDashboardFilter): JobStatus[] {
  return jobs.filter((job) => {
    if (filter === "active") return isActiveAgent(job);
    if (filter === "failed") return job.state === "failed";
    if (filter === "vps") return job.host !== "local";
    if (filter === "local") return job.host === "local";
    return true;
  });
}

export function formatAgentWidget(jobs: JobStatus[]): string {
  const active = jobs.filter(isActiveAgent);
  const failed = jobs.filter((job) =>
    job.state === "failed" && Date.now() - new Date(job.updatedAt).getTime() < 60 * 60 * 1000);
  if (!active.length) return `Agents idle${failed.length ? ` | ${failed.length} failed` : ""}`;

  const visible = active.slice(0, 2).map((job) =>
    `${agentDisplayName(job)} @ ${job.host === "local" ? "local" : job.host.toUpperCase()}`);
  const remaining = active.length - visible.length;
  return `Agents ${active.length} | ${visible.join(" | ")}${remaining ? ` | +${remaining}` : ""}` +
    `${failed.length ? ` | ${failed.length} failed` : ""}`;
}

export function formatAgentDashboard(
  jobs: JobStatus[],
  filter: AgentDashboardFilter = "all",
  options: { selectedId?: string } = {},
): string {
  const selected = agentDashboardJobs(jobs, filter);
  const active = jobs.filter(isActiveAgent);
  const heartbeat = (job: JobStatus): string => job.heartbeatAt ? age(job.heartbeatAt) : age(job.updatedAt);
  const lines = [
    "MAFIA AGENT HUB",
    `${formatAgentWidget(jobs)} | view ${filter}`,
    "",
    "== ACTIVE WORK ==",
    ...(active.length
      ? active.slice(0, 12).map((job) =>
        `${fit(agentDisplayName(job), 34)} ${fit(job.host.toUpperCase(), 7)} ` +
        `${fit(job.state, 10)} ${fit(heartbeat(job), 6)} ${job.title}`)
      : ["No agents run now."]),
    "",
    `== AGENTS - ${filter.toUpperCase()} (${selected.length}) ==`,
    `${fit("SUBAGENT", 34)} ${fit("HOST", 7)} ${fit("STATE", 10)} ${fit("BEAT", 6)} TASK`,
  ];
  for (const job of selected) {
    const cursor = job.id === options.selectedId ? "> " : "  ";
    lines.push(
      `${cursor}${fit(agentDisplayName(job), 34)} ${fit(job.host.toUpperCase(), 7)} ${fit(job.state, 10)} ` +
      `${fit(heartbeat(job), 6)} ${job.title}${job.error ? ` | ${job.error}` : ""}`,
    );
  }
  if (!selected.length) lines.push("No agents match this view.");
  return lines.join("\n");
}

function metric(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" }).format(value);
}

function oneLine(value?: string, limit = 500): string {
  if (!value) return "-";
  const clean = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}~` : clean;
}

function logLine(value: string): string {
  try {
    const event = JSON.parse(value) as Record<string, any>;
    const model = event.message?.model ?? event.item?.model ?? event.response?.model ?? event.model;
    const text = event.item?.text
      ?? event.message?.content?.find?.((part: any) => part?.type === "text")?.text
      ?? event.result;
    const tool = event.item?.name ?? event.name;
    const type = event.subtype ?? event.item?.type ?? event.type ?? "event";
    if (typeof text === "string" && text.trim()) return `[${type}] ${oneLine(text, 900)}`;
    if (typeof tool === "string" && tool.trim()) return `[${type}] ${tool}`;
    if (typeof model === "string" && model.trim()) return `[${type}] model ${model}`;
    if (typeof event.estimated_tokens === "number") return `[${type}] ${event.estimated_tokens} tokens`;
    return `[${type}]`;
  } catch {
    return oneLine(value, 1000);
  }
}

export function formatAgentDetail(job: JobStatus, logs = ""): string {
  const usage = job.usage;
  const command = job.command?.length
    ? job.command
      .slice(0, Math.min(job.command.length, 12))
      .map((part) => part === job.prompt ? "[prompt omitted]" : oneLine(part, 80))
      .join(" ")
    : "-";
  const lines = [
    agentDisplayName(job),
    `${job.state.toUpperCase()} | ${job.host.toUpperCase()} | heartbeat ${job.heartbeatAt ? age(job.heartbeatAt) : age(job.updatedAt)} ago`,
    "",
    "== IDENTITY ==",
    `Job: ${job.id}`,
    `Harness: ${job.harness}`,
    `Model: ${job.model ?? "not resolved"}`,
    `Model source: ${job.modelSource ?? "unknown"}`,
    `Parent: ${job.parentId ?? "OMP lead"}`,
    `Team: ${job.pipelineId ?? "-"}`,
    `Task ID: ${job.taskId ?? "-"}`,
    "",
    "== WORK ==",
    `Title: ${oneLine(job.title)}`,
    `Repository: ${job.repo ?? "-"}`,
    `Requested cwd: ${job.cwd ?? "-"}`,
    `Worktree: ${job.worktree ?? "-"}`,
    `Branch: ${job.branch ?? "-"}`,
    `Base ref: ${job.baseRef ?? "-"}`,
    `PID: ${job.pid ?? "-"}`,
    `Command: ${command}`,
    "",
    "== TIMING ==",
    `Created: ${job.createdAt}`,
    `Started: ${job.startedAt ?? "-"}`,
    `Updated: ${job.updatedAt}`,
    `Heartbeat: ${job.heartbeatAt ?? "-"}`,
    `Completed: ${job.completedAt ?? "-"}`,
    "",
    "== USAGE ==",
    ...(usage
      ? [
        `Tokens: ${metric(usage.inputTokens + usage.outputTokens)} total | ${metric(usage.inputTokens)} in | ${metric(usage.outputTokens)} out`,
        `Cache: ${metric(usage.cacheReadTokens)} read | ${metric(usage.cacheWriteTokens)} write`,
        `Requests: ${usage.requests} | failures: ${usage.failures} | runtime: ${usage.runtimeSeconds.toFixed(1)}s`,
        `Cost: $${usage.costUsd.toFixed(4)} | TTFT: ${usage.ttftMs === undefined ? "-" : `${usage.ttftMs}ms`}`,
      ]
      : ["No usage report yet."]),
    "",
    "== OUTCOME ==",
    `Exit code: ${job.exitCode ?? "-"}`,
    `Error: ${oneLine(job.error)}`,
    `Git: ${oneLine(job.gitSummary)}`,
    `Result: ${oneLine(job.result, 1200)}`,
    "",
    "== ARTIFACTS ==",
    `Log: ${job.logPath}`,
    `Context pack: ${job.contextPackPath ?? "-"}`,
    `Workspace patch: ${job.workspacePatchPath ?? "-"}`,
    `Workspace archive: ${job.workspaceArchivePath ?? "-"}`,
    ...(job.packet?.evidence ?? []).map((artifact) =>
      `${artifact.kind ?? "artifact"}: ${artifact.path}${artifact.description ? ` | ${artifact.description}` : ""}`),
    "",
    "== LIVE LOG TAIL ==",
    ...(logs.trim()
      ? logs.split("\n").slice(-40).map(logLine)
      : ["No log output loaded."]),
  ];
  return lines.join("\n");
}

export function formatMessages(messages: MafiaMessage[]): string {
  if (!messages.length) return "no Mafia messages";
  return [...messages].reverse().map((message) => {
    const target = message.to ? ` -> ${message.to}` : ` -> ${message.room}`;
    const refs = message.artifacts.length ? ` [${message.artifacts.length} artifact(s)]` : "";
    return `${message.createdAt} [${message.type}] ${message.from}${target}: ${message.body}${refs}`;
  }).join("\n");
}

export function formatHub(team: TeamStatus, jobs: JobStatus[], messages: MafiaMessage[]): string {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const lines = [
    `Mafia Agent Hub - ${team.name}`,
    `team ${team.id} - ${team.state}${team.paused ? " - paused" : ""}`,
    "",
    `${fit("TASK", 18)} ${fit("STATE", 10)} ${fit("HARNESS", 10)} ${fit("HOST", 6)} ${fit("MODEL", 28)} LAST EVENT`,
  ];
  for (const task of team.tasks) {
    const job = task.jobId ? byId.get(task.jobId) : undefined;
    const model = job?.model ?? task.model ?? "-";
    lines.push(
      `${fit(task.id, 18)} ${fit(task.state, 10)} ${fit(job?.harness ?? task.harness ?? "-", 10)} ` +
      `${fit(job?.host ?? task.host ?? "local", 6)} ${fit(model, 28)} ${job?.error ?? job?.title ?? "-"}`,
    );
  }
  if (messages.length) {
    lines.push("", "Recent messages:", ...formatMessages(messages.slice(0, 8)).split("\n"));
  }
  return lines.join("\n");
}

function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(index > 2 ? 1 : 0)}${units[index]}`;
}

function telemetryAge(value: string): string {
  return age(value);
}

function percent(used: number, total: number): string {
  if (total <= 0) return "-";
  return `${Math.round((used / total) * 100)}%`;
}

export function formatVpsWidget(value: VpsTelemetry): string[] {
  if (!value.reachable) {
    return [`VPS offline | ${value.error ?? "SSH failed"}`];
  }

  const memory = value.memory ? percent(value.memory.usedBytes, value.memory.totalBytes) : "-";
  const disk = value.disk ? `${value.disk.percent}%` : "-";
  const load = value.load?.[0].toFixed(2) ?? "-";
  const agents = value.jobs?.running ?? 0;
  const stale = Date.now() - new Date(value.generatedAt).getTime() >= 60_000;
  const full = `VPS ${value.host} online ${value.latencyMs}ms | load ${load} | mem ${memory} | disk ${disk} | ${agents} agents`;
  const short = `VPS online ${value.latencyMs}ms | load ${load} | mem ${memory} | disk ${disk} | ${agents} agents`;
  const line = full.length <= 80 ? full : short;
  const withStale = stale ? `${line} | stale` : line;
  if (withStale.length <= 80) return [withStale];
  return [line];
}

export function formatPrWidget(value: PrTelemetry): string {
  if (!value.reachable) return `PR desk offline | ${value.error ?? "VPS check failed"}`;
  const parts = [
    `${value.totals.open} open`,
    value.totals["needs-you"] ? `${value.totals["needs-you"]} need you` : "",
    value.totals.fixing ? `${value.totals.fixing} fixing` : "",
    value.totals["ci-failing"] ? `${value.totals["ci-failing"]} CI failing` : "",
    value.totals.ready ? `${value.totals.ready} ready` : "",
    value.totals.queued ? `${value.totals.queued} queued` : "",
  ].filter(Boolean);
  return `PRs ${parts.join(" | ")}`;
}

export function formatPrDashboard(
  value: PrTelemetry,
  filter: PrOperationalState | "all" = "all",
): string {
  if (!value.reachable) {
    return [
      "MAFIA PR DESK",
      "",
      `VPS check failed: ${value.error ?? "unknown error"}`,
    ].join("\n");
  }
  const selected = filter === "all" ? value.prs : value.prs.filter((pr) => pr.state === filter);
  const unhealthy = value.units.filter((unit) =>
    unit.active === "failed"
    || unit.sub === "failed"
    || (unit.name.endsWith(".timer") && unit.active !== "active"));
  const lines = [
    "MAFIA PR DESK",
    `Snapshot ${telemetryAge(value.generatedAt)} ago | VPS ${value.latencyMs}ms | view ${filter}`,
    "",
    "== QUEUE ==",
    `Open ${value.totals.open} | Need you ${value.totals["needs-you"]} | Fixing ${value.totals.fixing} | ` +
      `Conflicts ${value.totals.conflict} | CI fail ${value.totals["ci-failing"]} | CI pending ${value.totals["ci-pending"]}`,
    `Ready ${value.totals.ready} | Queued ${value.totals.queued} | Awaiting review ${value.totals["awaiting-review"]}`,
    "",
    "== AUTOMATION ==",
    ...(unhealthy.length ? unhealthy.map((item) => `! ${item.name} is ${item.active}/${item.sub}`) : ["All PR automation units are healthy."]),
    `${fit("UNIT", 28)} ${fit("ACTIVE", 10)} ${fit("SUB", 12)} ${fit("RESULT", 10)} LAST RUN`,
    ...value.units.map((item) =>
      `${fit(item.name, 28)} ${fit(item.active, 10)} ${fit(item.sub, 12)} ${fit(item.result ?? "-", 10)} ${item.lastRun ?? "-"}`),
    "",
    `== PULL REQUESTS - ${filter.toUpperCase()} (${selected.length}) ==`,
    `${fit("STATE", 16)} ${fit("PR", 37)} ${fit("THREADS", 8)} ${fit("CI", 9)} ${fit("REVIEW", 13)} TITLE`,
  ];
  for (const pr of selected) {
    const name = `${pr.repo}#${pr.number}`;
    lines.push(
      `${fit(pr.state, 16)} ${fit(name, 37)} ${fit(String(pr.unresolvedThreads), 8)} ` +
      `${fit(pr.checks.toLowerCase(), 9)} ${fit(pr.reviewDecision.toLowerCase(), 13)} ${pr.title}`,
    );
  }
  if (!selected.length) lines.push("No pull requests match this view.");
  return lines.join("\n");
}

function duration(seconds?: number): string {
  if (seconds === undefined) return "-";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function formatVpsDashboard(value: VpsTelemetry, options: { allProcesses?: boolean } = {}): string {
  if (!value.reachable) {
    return [
      "MAFIA VPS OPERATIONS",
      "",
      "== ALERTS ==",
      `VPS offline: ${value.error ?? "SSH failed"}`,
      `Last check: ${telemetryAge(value.generatedAt)} ago`,
    ].join("\n");
  }

  const processFilter = /(mafia|omp|claude|codex|kimi|cline|opencode|hermes|herdr|vault|watch|agent|proxy)/i;
  const processes = options.allProcesses
    ? value.processes
    : value.processes.filter((process) => processFilter.test(process.command));
  const providerState = value.models.fallbackOrder.map((harness) => {
    const source = value.models.sources.find((item) => item.harness === harness);
    if (!source) return `${harness}: unknown`;
    if (source.status !== "ok") return `${harness}: failed`;
    return `${harness}: ${source.count > 0 ? `${source.count} models` : "EMPTY"}`;
  });
  const unitFailures = value.units.filter((unit) => {
    const oneshot = [
      "mafia-update.service",
      "provider-auth-monitor.service",
      "pr-shepherd.service",
      "pr-automerge.service",
    ].includes(unit.name);
    const shouldBeActive = unit.name.endsWith(".timer") || (unit.name.endsWith(".service") && !oneshot);
    return unit.active === "failed"
      || unit.sub === "failed"
      || (shouldBeActive && unit.active !== "active")
      || Boolean(unit.result && !["success", "done"].includes(unit.result));
  });
  const emptyFallbacks = value.models.fallbackOrder.filter((harness) => {
    const source = value.models.sources.find((item) => item.harness === harness);
    return !source || source.status !== "ok" || source.count === 0;
  });
  const alerts = [
    ...(value.jobs.failed ? [`${value.jobs.failed} failed Mafia job(s)`] : []),
    ...(value.jobs.lost ? [`${value.jobs.lost} lost Mafia job(s)`] : []),
    ...emptyFallbacks.map((harness) => `${harness} fallback is unavailable`),
    ...unitFailures.map((unit) => `${unit.name} is ${unit.active}/${unit.sub}${unit.result ? ` (${unit.result})` : ""}`),
    ...(value.deployment?.dirty ? [`Mafia repository has ${value.deployment.dirtyFiles} changed file(s)`] : []),
  ];
  const memory = value.memory ? `${bytes(value.memory.usedBytes)}/${bytes(value.memory.totalBytes)}` : "-";
  const swap = value.memory ? `${bytes(value.memory.swapUsedBytes)}/${bytes(value.memory.swapTotalBytes)}` : "-";
  const load = value.load?.map((item) => item.toFixed(2)).join(" / ") ?? "-";
  const lines = [
    `MAFIA VPS OPERATIONS - ${value.host}`,
    `Snapshot ${telemetryAge(value.generatedAt)} ago | SSH ${value.latencyMs}ms | process scope ${options.allProcesses ? "all" : "agent-related"}`,
    "",
    "== ALERTS ==",
    ...(alerts.length ? alerts.map((item) => `! ${item}`) : ["No active alerts."]),
    "",
    "== HOST ==",
    `Load: ${load}`,
    `Memory: ${memory} | Swap: ${swap} | Disk: ${value.disk?.percent ?? "-"}%`,
    `Uptime: ${duration(value.uptimeSeconds)} | Processes: ${value.processes.length} total / ${processes.length} shown`,
  ];

  if (value.deployment) {
    lines.push(
      "",
      "== DEPLOYMENT ==",
      `Repository: ${value.deployment.repoPath}`,
      `Branch: ${value.deployment.branch ?? "-"} | HEAD: ${value.deployment.sha ?? "-"} | origin/master: ${value.deployment.originSha ?? "-"}`,
      `Worktree: ${value.deployment.dirty ? `DIRTY (${value.deployment.dirtyFiles} files)` : "clean"}`,
    );
  }

  lines.push(
    "",
    "== WORKERS ==",
    `Running: ${value.jobs.running} | Failed: ${value.jobs.failed} | Lost: ${value.jobs.lost} | Total: ${value.jobs.total}`,
    `Active by harness: ${Object.entries(value.jobs.byHarness).map(([name, count]) => `${name}:${count}`).join(" ") || "none"}`,
    "",
    `${fit("STATE", 10)} ${fit("HARNESS", 10)} ${fit("MODEL", 34)} ${fit("AGE", 6)} TITLE`,
  );
  for (const job of value.jobs.recent) {
    lines.push(
      `${fit(job.state, 10)} ${fit(job.harness, 10)} ${fit(job.model ?? "default", 34)} ${fit(age(job.updatedAt), 6)} ${job.title}${job.error ? ` | ${job.error}` : ""}`,
    );
  }

  lines.push(
    "",
    "== MODEL ROUTING ==",
    `Fallback order: ${value.models.fallbackOrder.join(" > ") || "-"}`,
    `Fallback health: ${providerState.join(" | ") || "-"}`,
    `Catalog: ${value.models.total} models | Generated: ${value.models.generatedAt ? `${telemetryAge(value.models.generatedAt)} ago` : "-"}`,
    "",
    `${fit("HARNESS", 14)} ${fit("STATUS", 10)} ${fit("MODELS", 8)} ERROR`,
  );
  for (const source of value.models.sources) {
    lines.push(`${fit(source.harness, 14)} ${fit(source.status, 10)} ${fit(String(source.count), 8)} ${source.error ?? ""}`);
  }

  lines.push(
    "",
    "== WATCHERS AND SERVICES ==",
    `${fit("UNIT", 34)} ${fit("ACTIVE", 10)} ${fit("SUB", 12)} ${fit("RESULT", 10)} EXIT DESCRIPTION`,
  );
  for (const unit of value.units) {
    lines.push(
      `${fit(unit.name, 34)} ${fit(unit.active, 10)} ${fit(unit.sub, 12)} ${fit(unit.result ?? "-", 10)} ` +
      `${String(unit.execStatus ?? "-").padEnd(4)} ${unit.description}`,
    );
  }

  lines.push(
    "",
    "== TIMERS ==",
    `${fit("TIMER", 34)} ${fit("NEXT", 38)} LAST`,
  );
  for (const timer of value.timers) {
    lines.push(`${fit(timer.name, 34)} ${fit(timer.next ?? "-", 38)} ${timer.last ?? "-"}`);
  }

  lines.push(
    "",
    `== PROCESSES - ${options.allProcesses ? "ALL" : "AGENT-RELATED"} ==`,
    `${fit("PID", 8)} ${fit("USER", 10)} ${fit("STATE", 7)} ${fit("CPU", 7)} ${fit("MEM", 7)} ${fit("AGE", 8)} COMMAND`,
  );
  for (const process of processes) {
    lines.push(
      `${fit(String(process.pid), 8)} ${fit(process.user, 10)} ${fit(process.state, 7)} ` +
      `${fit(`${process.cpuPercent.toFixed(1)}%`, 7)} ${fit(`${process.memoryPercent.toFixed(1)}%`, 7)} ` +
      `${fit(duration(process.ageSeconds), 8)} ${process.command}`,
    );
  }
  if (!processes.length) lines.push("No matching processes.");

  return lines.join("\n");
}

export function formatVpsTelemetry(value: VpsTelemetry, options: { compact?: boolean; allProcesses?: boolean } = {}): string {
  if (!value.reachable) {
    return `VPS - offline - ${value.error ?? "SSH failed"} - checked ${telemetryAge(value.generatedAt)} ago`;
  }
  const memory = value.memory
    ? `${bytes(value.memory.usedBytes)}/${bytes(value.memory.totalBytes)}`
    : "-";
  const swap = value.memory
    ? `${bytes(value.memory.swapUsedBytes)}/${bytes(value.memory.swapTotalBytes)}`
    : "-";
  const disk = value.disk ? `${value.disk.percent}%` : "-";
  const load = value.load?.map((item) => item.toFixed(2)).join("/") ?? "-";
  const unhealthy = value.units.filter((unit) => unit.active === "failed" || unit.sub === "failed");
  const providerErrors = value.models.sources.filter((source) => source.status !== "ok");
  const fallbackHealth = value.models.fallbackOrder.map((harness) => {
    const source = value.models.sources.find((item) => item.harness === harness);
    if (!source) return `${harness}:unknown`;
    if (source.status !== "ok") return `${harness}:failed`;
    return `${harness}:${source.count > 0 ? "ready" : "empty"}`;
  });
  const processFilter = /(mafia|omp|claude|codex|kimi|cline|opencode|hermes|herdr|vault|watch|agent|proxy)/i;
  const processes = (options.allProcesses
    ? value.processes
    : value.processes.filter((process) => processFilter.test(process.command)).slice(0, options.compact ? 4 : 20));
  const lines = [
    `VPS ${value.host} - online ${value.latencyMs}ms - snapshot ${telemetryAge(value.generatedAt)} ago`,
    `load ${load} - memory ${memory} - swap ${swap} - disk ${disk}`,
    `workers ${value.jobs.running} active / ${value.jobs.failed} failed / ${value.jobs.lost} lost - ${value.jobs.total} total`,
    `models ${value.models.total} - fallback ${value.models.fallbackOrder.join(" > ")}`,
    `fallback health ${fallbackHealth.join(" ")}`,
    `providers ${value.models.sources.map((source) => `${source.harness}:${source.status}:${source.count}`).join(" ") || "-"}`,
    `watchers ${value.units.map((unit) => `${unit.name.replace(/\.(service|timer)$/, "")}:${unit.active}`).join(" ")}`,
    `timers ${value.timers.map((timer) => `${timer.name.replace(".timer", "")}:${timer.next ?? "unknown"}`).join(" ")}`,
  ];
  if (unhealthy.length) lines.push(`alerts ${unhealthy.map((unit) => `${unit.name}:${unit.sub}`).join(" ")}`);
  if (providerErrors.length) lines.push(`model alerts ${providerErrors.map((source) => `${source.harness}:${source.error ?? source.status}`).join(" ")}`);
  const recentJobs = value.jobs.recent?.slice(0, options.compact ? 3 : 12) ?? [];
  if (recentJobs.length) {
    lines.push("VPS jobs:");
    for (const job of recentJobs) {
      lines.push(`${job.state.padEnd(9)} ${job.harness}/${job.model ?? "default"} ${job.title.slice(0, options.compact ? 62 : 110)}${job.error ? ` - ${job.error}` : ""}`);
    }
  }
  if (processes.length) {
    lines.push("processes:");
    for (const process of processes) {
      lines.push(`${String(process.pid).padStart(7)} ${process.user.padEnd(8)} ${process.cpuPercent.toFixed(1).padStart(5)}% ${process.memoryPercent.toFixed(1).padStart(4)}% ${process.command.slice(0, options.compact ? 68 : 140)}`);
    }
  }
  return lines.join("\n");
}

function contextSize(tokens?: number): string {
  if (!tokens) return "-";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

function price(cost?: ModelRecord["cost"]): string {
  if (!cost) return "-";
  if (!cost.input && !cost.output) return "free";
  // Keep both halves at the same precision. Mixing "3.00" with "15" makes the
  // column read as two different units.
  const round = (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(2));
  return `${round(cost.input)}/${round(cost.output)}`;
}

/** Shorten the effort levels so a full ladder fits on one line. */
function efforts(model: ModelRecord): string {
  if (!model.efforts?.length) return model.reasoning ? "yes" : "-";
  const short: Record<string, string> = { minimal: "min", medium: "med" };
  return model.efforts.map((level) => short[level] ?? level).join(" ");
}

/**
 * Render the model catalog as a grouped, aligned table.
 *
 * The previous form printed four tab-separated fields per line. Tabs do not
 * align across rows of differing width, so the selector column, which is the
 * one a reader copies, landed in a different place on every line.
 */
export function formatModels(catalog: ModelCatalog, shown: ModelRecord[]): string {
  const summary = [
    `${catalog.models.length} models`,
    `refreshed ${age(catalog.generatedAt)} ago`,
  ].join("  ");
  const sources = catalog.sources
    .map((source) => `${source.harness} ${source.count}${source.status === "ok" ? "" : "!"}`)
    .join("  ");
  const failed = catalog.sources.filter((source) => source.status !== "ok");
  const lines = [summary, sources];
  for (const source of failed) {
    lines.push(`  ! ${source.harness}: ${source.error ?? "unavailable"} (showing the last good list)`);
  }
  if (!shown.length) {
    lines.push("", "no matching models");
    return lines.join("\n");
  }

  // Size to the longest selector shown. The selector is the field a reader
  // copies, so it must never be truncated; the name column absorbs the width
  // instead because a clipped label still reads.
  const width = Math.max(24, ...shown.map((model) => model.selector.length)) + 1;
  lines.push("", `  ${fit("MODEL", 26)} ${fit("SELECTOR", width)} ${fit("CONTEXT", 8)} ${fit("$/Mtok", 12)} EFFORT`);
  let group = "";
  for (const model of shown) {
    const heading = `${model.provider} via ${model.harness}`;
    if (heading !== group) {
      group = heading;
      lines.push(heading);
    }
    lines.push(
      `  ${fit(model.name, 26)} ${fit(model.selector, width)} ` +
      `${fit(contextSize(model.contextWindow), 8)} ${fit(price(model.cost), 12)} ${efforts(model)}`,
    );
  }
  lines.push("", "append an effort to a selector to set reasoning depth, e.g. anthropic/claude-opus-5:high");
  return lines.join("\n");
}
