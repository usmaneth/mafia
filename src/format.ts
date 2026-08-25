import { budgetState } from "./budget";
import type { JobStatus, MafiaMessage, TeamStatus } from "./types";

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
    `parallel limit: ${team.maxParallel}`,
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
