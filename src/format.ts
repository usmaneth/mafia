import { budgetState } from "./budget";
import type { JobStatus, MafiaMessage, TeamStatus, VpsTelemetry } from "./types";

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

function shortUnitName(value: string): string {
  return value
    .replace(/\.(service|timer)$/, "")
    .replace("mafia-update", "update")
    .replace("provider-auth-monitor", "auth")
    .replace("pr-watch", "PR")
    .replace("vault-daemon", "vault");
}

function shortUnitState(value: string): string {
  if (value === "active") return "ok";
  if (value === "inactive") return "off";
  return value;
}

function shortTimer(value?: string): string {
  if (!value) return "-";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value.slice(0, 12);
  const seconds = Math.floor((timestamp - Date.now()) / 1000);
  if (seconds <= 0) return "due";
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.ceil(seconds / 3600)}h`;
}

export function formatVpsWidget(value: VpsTelemetry): string[] {
  if (!value.reachable) {
    return [`VPS offline | ${value.error ?? "SSH failed"}`];
  }

  const memory = value.memory ? percent(value.memory.usedBytes, value.memory.totalBytes) : "-";
  const disk = value.disk ? `${value.disk.percent}%` : "-";
  const load = value.load?.[0].toFixed(2) ?? "-";
  const stale = Date.now() - new Date(value.generatedAt).getTime() >= 60_000 ? " | stale" : "";
  const fallback = value.models.fallbackOrder.map((harness) => {
    const source = value.models.sources.find((item) => item.harness === harness);
    if (!source) return `${harness}:?`;
    if (source.status !== "ok") return `${harness}:FAIL`;
    return `${harness}:${source.count > 0 ? "ok" : "EMPTY"}`;
  });
  const timers = value.timers
    .map((timer) => `${shortUnitName(timer.name)}:${shortTimer(timer.next)}`)
    .join(" ");
  const processFilter = /(mafia|omp|claude|codex|kimi|cline|opencode|hermes|herdr|vault|watch|agent|proxy)/i;
  const relevantProcesses = value.processes.filter((process) => processFilter.test(process.command)).length;
  const latestProblem = value.jobs.recent.find((job) => job.state === "failed" || job.state === "lost");
  const lines = [
    `VPS ${value.host} online ${value.latencyMs}ms | load ${load} | mem ${memory} | disk ${disk}${stale}`,
    `workers ${value.jobs.running} run ${value.jobs.failed} fail ${value.jobs.lost} lost | models ${value.models.total}`,
    `route ${fallback.join(" ") || "-"}`,
    `watch ${value.units.map((unit) => `${shortUnitName(unit.name)}:${shortUnitState(unit.active)}`).join(" ") || "-"}`,
    `timers ${timers || "-"} | relevant processes ${relevantProcesses}`,
  ];
  if (latestProblem) {
    const detail = latestProblem.error ?? latestProblem.title;
    lines.push(`last ${latestProblem.state} ${latestProblem.harness} | ${detail.slice(0, 48)}`);
  }
  return lines;
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
    const oneshot = ["mafia-update.service", "provider-auth-monitor.service"].includes(unit.name);
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
