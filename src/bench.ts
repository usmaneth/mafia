import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { toolEnvironment } from "./process";
import type { ModelMetric, ModelMetrics } from "./types";

/** Measurements older than this are treated as unknown rather than trusted. */
const METRIC_MAX_AGE_MS = 30 * 86_400_000;

export function metricsPath(stateRoot: string): string {
  return join(stateRoot, "model-metrics.json");
}

export function readMetrics(stateRoot: string): ModelMetrics {
  try {
    return JSON.parse(readFileSync(metricsPath(stateRoot), "utf8")) as ModelMetrics;
  } catch {
    return { generatedAt: new Date(0).toISOString(), models: {} };
  }
}

function writeMetrics(stateRoot: string, value: ModelMetrics): void {
  const path = metricsPath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

interface BenchStat { mean?: number; p50?: number; p95?: number }
interface BenchChallenge { ttftMs?: BenchStat; tokensPerSecond?: BenchStat; cost?: number }
interface BenchModel {
  selector?: string;
  model?: string;
  stats?: BenchChallenge | null;
  byChallenge?: Record<string, BenchChallenge>;
  results?: Array<{ ok?: boolean; error?: string }>;
}

/**
 * Turn one `omp bench --json` report into per-model measurements.
 *
 * Only the median is kept. A mean is dragged around by one slow response, and
 * routing wants the response a caller usually gets.
 */
export function parseBench(raw: string, at = new Date().toISOString()): Record<string, ModelMetric> {
  const input = JSON.parse(raw) as { models?: BenchModel[] };
  const value: Record<string, ModelMetric> = {};
  for (const model of input.models ?? []) {
    const selector = model.selector ?? model.model;
    if (!selector) continue;
    const source = model.stats ?? Object.values(model.byChallenge ?? {})[0];
    const ttft = source?.ttftMs?.p50 ?? source?.ttftMs?.mean;
    const throughput = source?.tokensPerSecond?.p50 ?? source?.tokensPerSecond?.mean;
    if (typeof ttft !== "number" && typeof throughput !== "number") {
      const error = model.results?.find((entry) => entry.error)?.error;
      if (error) value[selector] = { selector, measuredAt: at, error: error.slice(0, 200) };
      continue;
    }
    value[selector] = {
      selector,
      measuredAt: at,
      ttftMs: typeof ttft === "number" ? Math.round(ttft) : undefined,
      tokensPerSecond: typeof throughput === "number" ? Math.round(throughput * 10) / 10 : undefined,
    };
  }
  return value;
}

/**
 * Convert a measured time-to-first-token into the router's latency weight.
 *
 * The router treats latency as 0 to 1, where more is worse. Two seconds to the
 * first token is taken as the middle of the range: below that feels immediate,
 * and past about eight seconds the differences stop mattering to a queue.
 */
export function latencyWeight(metric: ModelMetric | undefined): number | undefined {
  if (typeof metric?.ttftMs !== "number") return undefined;
  return Math.max(0.05, Math.min(1, metric.ttftMs / 4000));
}

export interface BenchOptions {
  models: string[];
  runs?: number;
  maxTokens?: number;
  profile?: string;
  stateRoot: string;
}

/**
 * Measure models and record the result.
 *
 * This spends real quota, so nothing calls it on a schedule. The measurements
 * it writes replace guesses the router previously made from the model's name.
 */
export function runBench(options: BenchOptions): { measured: Record<string, ModelMetric>; output: string } {
  if (!options.models.length) throw new Error("Name at least one model to measure.");
  const args = [
    "--profile", "mafia", "bench", ...options.models,
    "--runs", String(options.runs ?? 3),
    "--max-tokens", String(options.maxTokens ?? 128),
    "--profile", options.profile ?? "chat",
    "--json",
  ];
  const result = spawnSync("omp", args, {
    encoding: "utf8",
    env: toolEnvironment(),
    timeout: 20 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`omp bench failed: ${result.error.message}`);
  const raw = result.stdout ?? "";
  const start = raw.indexOf("{");
  if (start < 0) throw new Error((result.stderr || "omp bench produced no report").trim().slice(0, 300));
  const measured = parseBench(raw.slice(start));
  const previous = readMetrics(options.stateRoot);
  writeMetrics(options.stateRoot, {
    generatedAt: new Date().toISOString(),
    models: { ...previous.models, ...measured },
  });
  return { measured, output: raw };
}

export function usableMetrics(stateRoot: string, now = Date.now()): Record<string, ModelMetric> {
  const stored = readMetrics(stateRoot).models;
  const value: Record<string, ModelMetric> = {};
  for (const [selector, metric] of Object.entries(stored)) {
    if (metric.error) continue;
    if (now - new Date(metric.measuredAt).getTime() > METRIC_MAX_AGE_MS) continue;
    value[selector] = metric;
  }
  return value;
}

export function formatMetrics(metrics: Record<string, ModelMetric>): string {
  const rows = Object.values(metrics);
  if (!rows.length) return "no measured models yet - run mafia bench --models <selector,...>";
  const lines = rows
    .sort((left, right) => (left.ttftMs ?? Infinity) - (right.ttftMs ?? Infinity))
    .map((metric) => {
      const ttft = metric.ttftMs ? `${metric.ttftMs}ms` : "-";
      const tps = metric.tokensPerSecond ? `${metric.tokensPerSecond}/s` : "-";
      const note = metric.error ? `  ${metric.error}` : "";
      return `  ${metric.selector.padEnd(44)} ttft ${ttft.padStart(7)}  ${tps.padStart(8)}  ${metric.measuredAt.slice(0, 10)}${note}`;
    });
  return ["measured models", ...lines].join("\n");
}
