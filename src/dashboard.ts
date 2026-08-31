import { loadConfig } from "./config";
import { JobStore } from "./store";
import { TelemetryStore } from "./telemetry-store";
import { ProviderUsageService, readPenalties } from "./provider-usage";
import { readMirrorState, mirrorIsHealthy } from "./mirror";
import { buildInsights } from "./insights";
import { modelScorecard } from "./why";
import { readActivity } from "../hooks/subagent-activity";
import { barChart, gauge, histogram, sparkline } from "./chart";
import { formatSubagents } from "./format";

function ago(value: string | undefined, now: number): string {
  if (!value) return "-";
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function rule(title: string, width = 76): string {
  return `${title} ${"─".repeat(Math.max(0, width - title.length - 1))}`;
}

/**
 * One screen for the whole fleet.
 *
 * The information here was spread across eight commands. Each was the right
 * shape while the capability was being built and the wrong shape for using it:
 * nobody runs eight commands to answer "is anything wrong".
 *
 * Ordered by what a reader needs first — whether anything is broken, then what
 * is running, then what the fleet has learned.
 */
export function renderDashboard(stateRoot = loadConfig().stateRoot, now = Date.now()): string {
  const jobs = new JobStore(stateRoot);
  const telemetry = new TelemetryStore(stateRoot);
  const out: string[] = [];

  // Anything demanding attention goes first, or it will not be read.
  const usage = new ProviderUsageService(stateRoot).cached();
  const benched = readPenalties(stateRoot);
  const mirror = readMirrorState(stateRoot);
  const alerts: string[] = [];
  if (!mirrorIsHealthy(mirror)) {
    alerts.push(`mirror ${mirror?.verdict ?? "never run"}${mirror?.conflicts.length ? ` - ${mirror.conflicts.slice(0, 2).join(", ")}` : ""}`);
  }
  for (const provider of benched) alerts.push(`${provider.provider} benched until ${provider.until.slice(11, 16)}Z`);
  for (const quota of usage?.providers ?? []) {
    if (quota.usedFraction >= 0.95) alerts.push(`${quota.provider} at ${Math.round(quota.usedFraction * 100)}% of quota`);
  }
  if (alerts.length) {
    out.push(rule("attention"), ...alerts.map((line) => `  ! ${line}`), "");
  }

  // Work in flight.
  const recent = jobs.list(200);
  const live = recent.filter((job) => ["queued", "starting", "running"].includes(job.state));
  const finished = recent.filter((job) => ["succeeded", "failed", "lost", "cancelled"].includes(job.state));
  const failed = finished.filter((job) => job.state !== "succeeded").length;
  out.push(rule("fleet"));
  out.push(`  ${live.length} running   ${finished.length} finished   ${failed} not succeeded` +
    `   mirror ${mirror?.verdict ?? "-"} ${ago(mirror?.checkedAt, now)} ago`);
  if (live.length) {
    for (const job of live.slice(0, 6)) {
      out.push(`    ${job.id.slice(-12)}  ${(job.harness).padEnd(8)} ${(job.model ?? "-").slice(0, 30).padEnd(30)} ${ago(job.startedAt ?? job.createdAt, now)}`);
    }
  }
  // A day of job starts, so a quiet fleet is distinguishable from a stalled one.
  const starts = histogram(recent.map((job) => job.createdAt), 24, now);
  if (starts.some(Boolean)) out.push(`  last 24h  ${sparkline(starts, 24)}  ${starts.reduce((sum, value) => sum + value, 0)} started`);
  out.push("");

  // Provider headroom, which decides where new work can go.
  if (usage?.providers.length) {
    out.push(rule("provider quota"));
    for (const quota of usage.providers.slice(0, 6)) {
      out.push(`  ${quota.provider.padEnd(14)} ${gauge(quota.usedFraction)} ${`${Math.round(quota.usedFraction * 100)}%`.padStart(4)}` +
        `  ${quota.bindingWindow ?? ""}${quota.resetsAt ? ` resets ${quota.resetsAt.slice(11, 16)}Z` : ""}`);
    }
    out.push("");
  }

  // What the fleet actually runs on, and whether its speed is known.
  const scorecard = modelScorecard(stateRoot, 6);
  if (scorecard.length) {
    out.push(rule("models by total tokens"));
    out.push(barChart(scorecard.map((row) => ({
      label: row.model,
      value: row.totalTokens,
      note: `${row.totalTokens >= 1e9 ? `${(row.totalTokens / 1e9).toFixed(1)}B` : `${(row.totalTokens / 1e6).toFixed(0)}M`} total  ` +
        `${(row.outputTokens / 1e6).toFixed(1)}M out  ${row.ttftMs ? `${row.ttftMs}ms` : "unmeasured"}`,
    })), 20, 26));
    out.push("");
  }

  // Whether the work lands. Everything above measures effort.
  const prStates = telemetry.prStates(14);
  if (prStates.length) {
    out.push(rule("pull requests, last 14 days"));
    out.push(barChart(prStates.slice(0, 5).map((row) => ({
      label: row.state,
      value: row.observations,
      note: `${row.observations} seen, peak ${row.peak}`,
    })), 20, 20));
    out.push("");
  }

  const subagents = readActivity();
  if (subagents.some((row) => row.state !== "done")) {
    out.push(rule("subagents"), formatSubagents(subagents, now), "");
  }

  const insights = buildInsights(stateRoot).slice(0, 3);
  if (insights.length) {
    out.push(rule("what to change next"));
    for (const insight of insights) out.push(`  ${insight.title}`, `      ${insight.action}`);
    out.push("");
  }

  out.push(`  mafia why JOB  ·  mafia insights  ·  mafia doctor --fix  ·  mafia history --tools`);
  return out.join("\n");
}
