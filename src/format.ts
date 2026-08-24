import type { JobStatus, TeamStatus } from "./types";

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
  const lines = [
    `${team.name} (${team.id})`,
    `state: ${team.state}`,
    `goal: ${team.goal}`,
    `parallel limit: ${team.maxParallel}`,
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
