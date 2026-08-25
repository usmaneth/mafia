import type { HarnessName, JobStatus, UsageMetrics } from "./types";

const HARNESS_LABELS: Record<HarnessName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi Code",
  cline: "Cline",
  opencode: "OpenCode",
  omp: "OMP",
};

const ACTIVE_STATES = new Set(["queued", "starting", "running"]);

export function harnessDisplayName(harness: HarnessName): string {
  return HARNESS_LABELS[harness];
}

function titleWords(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "k3") return "K3";
      if (lower === "ai") return "AI";
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

export function modelDisplayName(model?: string): string {
  if (!model) return "Default model";

  const selector = model.replace(/:[a-z-]+$/i, "");
  const id = selector.includes("/") ? selector.slice(selector.lastIndexOf("/") + 1) : selector;
  const lower = id.toLowerCase();

  if (lower === "opus") return "Opus";
  if (lower === "sonnet") return "Sonnet";
  if (lower === "haiku") return "Haiku";
  if (lower === "k3" || lower === "kimi-k3") return "K3";
  if (lower === "grok-build") return "Grok Build";
  if (lower === "nemotron-3-ultra-free") return "Nemotron 3 Ultra";

  const claude = lower.match(/claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/);
  if (claude) return `${titleWords(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;

  const gpt = lower.match(/gpt-(\d+)(?:[.-](\d+))?(?:-(.+))?/);
  if (gpt) {
    const version = `${gpt[1]}${gpt[2] ? `.${gpt[2]}` : ""}`;
    return `GPT-${version}${gpt[3] ? ` ${titleWords(gpt[3])}` : ""}`;
  }

  return titleWords(id);
}

export function agentDisplayName(job: Pick<JobStatus, "harness" | "model">): string {
  return `${harnessDisplayName(job.harness)} - ${modelDisplayName(job.model)}`;
}

export function agentRegistryId(job: Pick<JobStatus, "id" | "harness" | "model">): string {
  const suffix = job.id.split("-").at(-1) ?? job.id;
  return `${agentDisplayName(job)} · ${suffix}`;
}

export function agentRegistryStatus(state: JobStatus["state"]): "running" | "parked" | "aborted" {
  if (ACTIVE_STATES.has(state)) return "running";
  if (state === "succeeded") return "parked";
  return "aborted";
}

export function agentRegistryMetrics(usage?: UsageMetrics) {
  if (!usage) return undefined;
  return {
    tokens: usage.inputTokens + usage.outputTokens,
    requests: usage.requests,
    tools: 0,
    cost: usage.costUsd,
    durationMs: usage.runtimeSeconds * 1000,
    durationKind: "active" as const,
  };
}

export function isActiveAgent(job: Pick<JobStatus, "state">): boolean {
  return ACTIVE_STATES.has(job.state);
}
