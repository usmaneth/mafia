import type { TeamBudget, TeamStatus, UsageMetrics } from "./types";

export interface BudgetState {
  percent: number;
  warning: boolean;
  downgrade: boolean;
  stop: boolean;
  reasons: string[];
}

export function budgetState(
  team: TeamStatus,
  usage: UsageMetrics,
  now = Date.now(),
  providerCost: Record<string, number> = {},
): BudgetState {
  const budget = team.budget;
  if (!budget) return { percent: 0, warning: false, downgrade: false, stop: false, reasons: [] };
  const values: Array<{ name: string; used: number; max?: number }> = [
    { name: "cost", used: usage.costUsd, max: budget.maxCostUsd },
    { name: "tokens", used: usage.inputTokens + usage.outputTokens, max: budget.maxTokens },
    { name: "runtime", used: (now - new Date(team.createdAt).getTime()) / 1000, max: budget.maxRuntimeSeconds },
    { name: "workers", used: team.tasks.filter((task) => task.state === "running").length, max: budget.maxWorkers },
  ];
  let percent = 0;
  const reasons: string[] = [];
  for (const value of values) {
    if (!value.max || value.max <= 0) continue;
    const current = value.used / value.max * 100;
    percent = Math.max(percent, current);
    if (current >= (budget.warningPercent ?? 75)) {
      reasons.push(`${value.name} is ${current.toFixed(1)}% of the limit`);
    }
  }
  for (const [provider, max] of Object.entries(budget.providerCostUsd ?? {})) {
    if (max <= 0) continue;
    const current = (providerCost[provider] ?? 0) / max * 100;
    percent = Math.max(percent, current);
    if (current >= (budget.warningPercent ?? 75)) {
      reasons.push(`${provider} cost is ${current.toFixed(1)}% of the limit`);
    }
  }
  return {
    percent,
    warning: percent >= (budget.warningPercent ?? 75),
    downgrade: percent >= (budget.downgradeAtPercent ?? 85),
    stop: percent >= (budget.stopAtPercent ?? 100),
    reasons,
  };
}

export function zeroUsage(): UsageMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    requests: 0,
    failures: 0,
    runtimeSeconds: 0,
  };
}
