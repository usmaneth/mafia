import { describe, expect, test } from "bun:test";
import { exhaustedProviders, formatProviderUsage, parseProviderUsage } from "../src/provider-usage";
import { rankTaskRoutes } from "../src/router";
import type { MafiaConfig, RoutingCandidate } from "../src/types";

const now = Date.UTC(2026, 7, 31, 20, 0, 0);

function report(provider: string, limits: Array<{ label: string; usedFraction?: number; remainingFraction?: number }>) {
  return {
    provider,
    limits: limits.map((limit) => ({
      label: limit.label,
      window: { label: limit.label, resetsAt: now + 3_600_000 },
      amount: { usedFraction: limit.usedFraction, remainingFraction: limit.remainingFraction },
    })),
  };
}

describe("provider quota parsing", () => {
  test("reports the window closest to full, not the average", () => {
    // A five-hour window at 90% blocks work now even when the weekly window is
    // nearly empty. Averaging the two would hide that.
    const value = parseProviderUsage(JSON.stringify({
      generatedAt: now,
      reports: [report("anthropic", [
        { label: "5 Hour", usedFraction: 0.9 },
        { label: "7 Day", usedFraction: 0.05 },
      ])],
    }), now);
    expect(value.providers[0]!.usedFraction).toBe(0.9);
    expect(value.providers[0]!.bindingWindow).toBe("5 Hour");
  });

  test("derives usage from a remaining fraction when that is all a provider gives", () => {
    const value = parseProviderUsage(JSON.stringify({
      generatedAt: now,
      reports: [report("kimi-code", [{ label: "7 Day", remainingFraction: 0.23 }])],
    }), now);
    expect(value.providers[0]!.usedFraction).toBeCloseTo(0.77, 5);
  });

  test("sorts the tightest provider first", () => {
    const value = parseProviderUsage(JSON.stringify({
      generatedAt: now,
      reports: [
        report("codex", [{ label: "7 Day", usedFraction: 0.34 }]),
        report("kimi-code", [{ label: "7 Day", usedFraction: 0.77 }]),
      ],
    }), now);
    expect(value.providers.map((entry) => entry.provider)).toEqual(["kimi-code", "codex"]);
  });

  test("treats a provider with no readable window as unconstrained rather than full", () => {
    // Reporting an unknown quota as exhausted would silently remove a working
    // provider from every route.
    const value = parseProviderUsage(JSON.stringify({
      generatedAt: now,
      reports: [{ provider: "ollama", limits: [] }],
    }), now);
    expect(value.providers[0]!.usedFraction).toBe(0);
    expect(exhaustedProviders(value).size).toBe(0);
  });

  test("skips a report with no provider name", () => {
    const value = parseProviderUsage(JSON.stringify({ generatedAt: now, reports: [{ limits: [] }] }), now);
    expect(value.providers).toHaveLength(0);
  });
});

describe("exhaustion threshold", () => {
  const usage = parseProviderUsage(JSON.stringify({
    generatedAt: now,
    reports: [
      report("spent", [{ label: "7 Day", usedFraction: 0.97 }]),
      report("tight", [{ label: "7 Day", usedFraction: 0.94 }]),
    ],
  }), now);

  test("flags only providers at or past the threshold", () => {
    expect([...exhaustedProviders(usage)]).toEqual(["spent"]);
  });

  test("the threshold is adjustable", () => {
    expect([...exhaustedProviders(usage, 0.9)].sort()).toEqual(["spent", "tight"]);
  });

  test("no usage means nothing is excluded", () => {
    expect(exhaustedProviders(undefined).size).toBe(0);
  });

  test("renders a readable bar with the binding window", () => {
    const value = formatProviderUsage(usage);
    expect(value).toContain("spent");
    expect(value).toContain("EXHAUSTED");
    expect(value).toContain("97%");
  });
});

describe("quota-aware routing", () => {
  const candidate = (harness: "omp" | "claude", provider: string, quality: number): RoutingCandidate => ({
    harness,
    model: `${provider}/model`,
    host: "local",
    capabilities: ["general"],
    enabled: true,
    costWeight: 1,
    quality,
    latency: 1,
    provider,
  });
  const config = {
    hosts: { local: { name: "local", kind: "local", stateRoot: "/tmp", maxParallel: 1 } },
    defaultHarness: "omp",
    defaultHost: "local",
  } as unknown as MafiaConfig;
  const candidates = [candidate("omp", "kimi-code", 10), candidate("omp", "openai", 5)];

  test("drops a provider that has no headroom left", () => {
    // Before this, a provider at 99% of its window drew the same share of work
    // as one at 2%, so a fleet could spend a weekly allowance in one run.
    const routes = rankTaskRoutes(config, {
      capability: "general",
      exhaustedProviders: new Set(["kimi-code"]),
    }, new Map(), candidates);
    expect(routes.every((route) => route.model !== "kimi-code/model")).toBe(true);
    expect(routes[0]!.model).toBe("openai/model");
  });

  test("keeps the best provider when nothing is exhausted", () => {
    const routes = rankTaskRoutes(config, { capability: "general" }, new Map(), candidates);
    expect(routes[0]!.model).toBe("kimi-code/model");
  });

  test("still returns a route when every provider is spent, and says why", () => {
    // Routing to nothing is worse than routing to a full provider: the caller
    // needs a decision, and the reason has to explain the situation.
    const routes = rankTaskRoutes(config, {
      capability: "general",
      exhaustedProviders: new Set(["kimi-code", "openai"]),
    }, new Map(), candidates);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0]!.reasons.join(" ")).toContain("quota limit");
  });

  test("a candidate with no provider is never filtered out", () => {
    const anonymous = { ...candidate("claude", "x", 9), provider: undefined };
    const routes = rankTaskRoutes(config, {
      capability: "general",
      exhaustedProviders: new Set(["kimi-code", "openai"]),
    }, new Map(), [...candidates, anonymous]);
    expect(routes.some((route) => route.harness === "claude")).toBe(true);
  });
});
