import { JobStore } from "./store";
import { TelemetryStore } from "./telemetry-store";
import { usableMetrics } from "./bench";
import { ProviderUsageService, providerHeadroom, providerOfSelector } from "./provider-usage";
import type { JobStatus, MafiaEvent } from "./types";

export interface Explanation {
  job: JobStatus;
  /** Why this model and host, in the order the decisions were made. */
  reasons: string[];
  /** Route decisions recorded against this job or its team. */
  events: MafiaEvent[];
  outcome: string;
}

function age(from: string, to?: string): string {
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * Explain how a job ended up with the model and host it ran on.
 *
 * Every part of this was already recorded — the model source, the substitution
 * and repin events, the measured latency, the provider's remaining quota — but
 * it was spread across four stores and nothing put it together. The question
 * "why did this job use that model" had to be answered by hand.
 */
export function explainJob(stateRoot: string, id: string): Explanation {
  const store = new JobStore(stateRoot);
  const job = store.get(id);
  if (!job) throw new Error(`Unknown job: ${id}`);

  const reasons: string[] = [];
  const source: Record<string, string> = {
    requested: "the caller named this model",
    configured: "the harness has a configured default in the Mafia config",
    detected: "no model was named, so the harness's own default was read",
    observed: "the provider reported a different model than the one requested",
    "quota-substituted": "the requested provider could not take work, so another route to the same model was used",
  };
  reasons.push(`Model ${job.model ?? "(none)"} - ${source[job.modelSource ?? ""] ?? "chosen by routing"}.`);
  reasons.push(`Harness ${job.harness} on ${job.host}.`);

  const metric = usableMetrics(stateRoot)[job.model ?? ""];
  if (metric?.ttftMs) {
    reasons.push(`Measured latency ${metric.ttftMs}ms, from ${metric.samples ?? 1} sample(s) (${metric.source ?? "benched"}).`);
  } else {
    reasons.push(`No measured latency for this model, so routing scored it from its name.`);
  }

  const provider = providerOfSelector(job.model);
  if (provider) {
    const usage = new ProviderUsageService(stateRoot).cached();
    const left = providerHeadroom(usage, provider);
    reasons.push(`Provider ${provider} had ${Math.round(left * 100)}% of its quota left.`);
  }

  if (job.roleModels && Object.keys(job.roleModels).length) {
    reasons.push(`OMP roles were pinned for this job: ${Object.entries(job.roleModels).map(([role, model]) => `${role}=${model}`).join(", ")}.`);
  }

  // Route decisions are recorded as events against the job or its team.
  const events = [
    ...store.listEvents({ jobId: job.id, limit: 50 }),
    ...(job.pipelineId ? store.listEvents({ teamId: job.pipelineId, limit: 50 }) : []),
  ].filter((event) => event.type.startsWith("route.") || event.type.startsWith("worker."))
    .filter((event, index, all) => all.findIndex((other) => other.id === event.id) === index)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const usage = job.usage;
  const outcome = [
    `${job.state}${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ""}`,
    `ran ${age(job.startedAt ?? job.createdAt, job.completedAt)}`,
    usage ? `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out` : "no usage recorded",
    usage?.ttftMs ? `first output after ${Math.round(usage.ttftMs)}ms` : "",
    job.error ? `error: ${job.error.slice(0, 90)}` : "",
  ].filter(Boolean).join(" - ");

  return { job, reasons, events, outcome };
}

export function formatExplanation(value: Explanation): string {
  const lines = [
    `${value.job.id}  ${value.job.title.split("\n")[0]?.slice(0, 70)}`,
    "",
    "why this route",
    ...value.reasons.map((reason) => `  ${reason}`),
    "",
    "outcome",
    `  ${value.outcome}`,
  ];
  if (value.events.length) {
    lines.push("", "what happened");
    for (const event of value.events) {
      const detail = event.type.startsWith("route.")
        ? JSON.stringify(event.data).slice(0, 110)
        : Object.entries(event.data as Record<string, unknown>)
          .filter(([key]) => ["model", "harness", "exitCode"].includes(key))
          .map(([key, entry]) => `${key}=${entry}`).join(" ");
      lines.push(`  ${event.createdAt.slice(11, 19)}Z  ${event.type.padEnd(22)} ${detail}`);
    }
  }
  return lines.join("\n");
}

/** A short, per-model account of what the fleet has learned, for the dashboard. */
export function modelScorecard(stateRoot: string, limit = 8): Array<{
  model: string; turns: number; outputTokens: number; totalTokens: number; ttftMs?: number; source?: string;
}> {
  const telemetry = new TelemetryStore(stateRoot);
  const metrics = usableMetrics(stateRoot);
  const rows = telemetry.db.query(`
    SELECT model, COUNT(*) turns,
      COALESCE(SUM(output_tokens),0) outputTokens,
      COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens + output_tokens),0) totalTokens
    FROM turns WHERE model IS NOT NULL GROUP BY model ORDER BY totalTokens DESC LIMIT ?
  `).all(limit) as Array<{ model: string; turns: number; outputTokens: number; totalTokens: number }>;
  return rows.map((row) => {
    const metric = metrics[row.model]
      ?? Object.values(metrics).find((entry) => entry.selector.endsWith(row.model));
    return { ...row, ttftMs: metric?.ttftMs, source: metric?.source };
  });
}
