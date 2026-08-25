import type {
  MafiaConfig,
  RouteDecision,
  RoutingCandidate,
  TaskCapability,
  UsageMetrics,
} from "./types";

export interface RouteInput {
  capability: TaskCapability;
  preferredModels?: string[];
  host?: string;
  downgrade?: boolean;
}

export function routeTask(
  config: MafiaConfig,
  input: RouteInput,
  history: Map<string, UsageMetrics> = new Map(),
  discovered?: RoutingCandidate[],
): RouteDecision {
  return rankTaskRoutes(config, input, history, discovered)[0] ?? {
    harness: config.defaultHarness,
    host: input.host ?? config.defaultHost,
    score: 0,
    reasons: ["default route"],
  };
}

export function rankTaskRoutes(
  config: MafiaConfig,
  input: RouteInput,
  history: Map<string, UsageMetrics> = new Map(),
  discovered?: RoutingCandidate[],
): RouteDecision[] {
  const candidates = (discovered?.length ? discovered : config.routing?.candidates ?? defaultCandidates()).filter((candidate) => {
    if (!candidate.enabled) return false;
    if (!config.hosts[candidate.host]) return false;
    if (input.host && candidate.host !== input.host) return false;
    if (input.preferredModels?.length && candidate.model && !input.preferredModels.includes(candidate.model)) return false;
    return candidate.capabilities.includes(input.capability) || candidate.capabilities.includes("general");
  });
  const scored = candidates.map((candidate) =>
    scoreCandidate(candidate, history, input.downgrade ?? false, !input.host));
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return scored.filter((route) => {
    const key = `${route.harness}:${route.model ?? ""}:${route.host}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreCandidate(
  candidate: RoutingCandidate,
  history: Map<string, UsageMetrics>,
  downgrade: boolean,
  preferRemote: boolean,
): RouteDecision {
  const key = `${candidate.harness}:${candidate.model ?? ""}:${candidate.host}`;
  const metrics = history.get(key);
  const failureRate = metrics?.requests ? metrics.failures / metrics.requests : 0;
  const costPenalty = candidate.costWeight * (downgrade ? 35 : 15);
  const latencyPenalty = candidate.latency * 8;
  const remoteBonus = preferRemote && candidate.host !== "local" ? 20 : 0;
  const score = candidate.quality * 100 - costPenalty - latencyPenalty - failureRate * 60 + remoteBonus;
  return {
    harness: candidate.harness,
    model: candidate.model,
    host: candidate.host,
    score,
    reasons: [
      `quality ${candidate.quality.toFixed(2)}`,
      `cost ${candidate.costWeight.toFixed(2)}`,
      `latency ${candidate.latency.toFixed(2)}`,
      metrics ? `observed failure rate ${(failureRate * 100).toFixed(1)}%` : "no observed failures",
      downgrade ? "budget downgrade active" : "normal budget mode",
      remoteBonus ? "VPS-first execution" : "requested host",
    ],
  };
}

export function defaultCandidates(): RoutingCandidate[] {
  return [
    {
      harness: "claude",
      model: "fable",
      host: "local",
      capabilities: ["architecture", "implementation", "synthesis"],
      enabled: true,
      costWeight: 0.9,
      quality: 0.97,
      latency: 0.7,
      provider: "anthropic",
    },
    {
      harness: "codex",
      model: "gpt-5.4",
      host: "local",
      capabilities: ["implementation", "testing", "review", "general"],
      enabled: true,
      costWeight: 0.8,
      quality: 0.96,
      latency: 0.6,
      provider: "openai-codex",
    },
    {
      harness: "codex",
      model: "gpt-5.4",
      host: "vps",
      capabilities: ["implementation", "testing", "review", "general"],
      enabled: true,
      costWeight: 0.8,
      quality: 0.95,
      latency: 0.75,
      provider: "openai-codex",
    },
    {
      harness: "omp",
      model: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      host: "local",
      capabilities: ["research", "general"],
      enabled: true,
      costWeight: 0,
      quality: 0.72,
      latency: 0.85,
      provider: "openrouter",
    },
    {
      harness: "omp",
      model: "xai-oauth/grok-build",
      host: "local",
      capabilities: ["review", "security", "synthesis"],
      enabled: true,
      costWeight: 0.55,
      quality: 0.9,
      latency: 0.65,
      provider: "xai-oauth",
    },
    {
      harness: "opencode",
      model: "opencode/nemotron-3-ultra-free",
      host: "local",
      capabilities: ["review", "research", "general"],
      enabled: true,
      costWeight: 0,
      quality: 0.73,
      latency: 0.8,
      provider: "opencode",
    },
    {
      harness: "kimi",
      model: "k3",
      host: "local",
      capabilities: ["implementation", "review"],
      enabled: false,
      costWeight: 0.5,
      quality: 0.85,
      latency: 0.65,
      provider: "kimi-code",
    },
    {
      harness: "cline",
      host: "local",
      capabilities: ["implementation", "review"],
      enabled: false,
      costWeight: 0.6,
      quality: 0.8,
      latency: 0.8,
      provider: "cline",
    },
  ];
}
