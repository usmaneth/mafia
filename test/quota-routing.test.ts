import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isQuotaFailure,
  modelIdentity,
  parseProviderUsage,
  penaliseProvider,
  providerHeadroom,
  providerOfSelector,
  readPenalties,
  substituteExhaustedModel,
  unavailableProviders,
} from "../src/provider-usage";
import { rankTaskRoutes } from "../src/router";
import type { MafiaConfig, RoutingCandidate } from "../src/types";

const now = Date.UTC(2026, 7, 31, 20, 0, 0);
const roots: string[] = [];

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mafia-quota-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const usage = parseProviderUsage(JSON.stringify({
  generatedAt: now,
  reports: [
    { provider: "anthropic", limits: [{ label: "5 Hour", amount: { usedFraction: 0.99 } }] },
    { provider: "openrouter", limits: [{ label: "7 Day", amount: { usedFraction: 0.10 } }] },
    { provider: "kimi-code", limits: [{ label: "7 Day", amount: { usedFraction: 0.77 } }] },
  ],
}), now);

const model = (harness: string, provider: string, id: string, selector: string) =>
  ({ harness, provider, id, selector, available: true });

// The same model reached two ways: direct, and resold through OpenRouter.
const catalogModels = [
  model("omp", "anthropic", "claude-opus-5", "anthropic/claude-opus-5"),
  model("omp", "openrouter", "anthropic/claude-opus-5", "openrouter/anthropic/claude-opus-5"),
  model("opencode", "openrouter", "anthropic/claude-opus-5", "openrouter/anthropic/claude-opus-5-oc"),
  model("omp", "kimi-code", "k3", "kimi-code/k3"),
];

describe("model identity across providers", () => {
  test("two routes to one model share an identity", () => {
    expect(modelIdentity(catalogModels[0]!)).toBe(modelIdentity(catalogModels[1]!));
  });

  test("different models do not", () => {
    expect(modelIdentity(catalogModels[0]!)).not.toBe(modelIdentity(catalogModels[3]!));
  });
});

describe("substituting an exhausted provider", () => {
  test("swaps to the same model on a provider with headroom", () => {
    // A swap between two routes to one model changes only which account pays,
    // so it is safe to do without asking.
    const found = substituteExhaustedModel(catalogModels, catalogModels[0]!, usage);
    expect(found?.model.selector).toBe("openrouter/anthropic/claude-opus-5");
    expect(found?.substitution.reason).toContain("99%");
  });

  test("prefers keeping the same harness", () => {
    const found = substituteExhaustedModel(catalogModels, catalogModels[0]!, usage);
    expect(found?.model.harness).toBe("omp");
  });

  test("does nothing when the requested provider is fine", () => {
    expect(substituteExhaustedModel(catalogModels, catalogModels[1]!, usage)).toBeUndefined();
  });

  test("never drops to a different, smaller model", () => {
    // kimi-code/k3 has no second route. Silently sending the caller to some
    // other model would change the answer they get, so it must refuse instead.
    const spent = new Set(["kimi-code"]);
    expect(substituteExhaustedModel(catalogModels, catalogModels[3]!, usage, 0, spent)).toBeUndefined();
  });

  test("honours an explicit blocked set over the numeric threshold", () => {
    // A provider benched for refusing a request is unusable even at 10% quota.
    const found = substituteExhaustedModel(catalogModels, catalogModels[1]!, usage, 0, new Set(["openrouter"]));
    expect(found?.model.provider).toBe("anthropic");
    expect(found?.substitution.reason).toContain("refused");
  });
});

describe("reacting to a provider refusing work", () => {
  test("recognises the failures that mean stop sending work", () => {
    expect(isQuotaFailure("Error 429: rate limit exceeded")).toBe(true);
    expect(isQuotaFailure("HTTP 402 Payment Required")).toBe(true);
    expect(isQuotaFailure("401 unauthorized")).toBe(true);
    expect(isQuotaFailure("insufficient credits")).toBe(true);
  });

  test("does not bench a provider for an ordinary failure", () => {
    // Benching on any error would remove a healthy provider after one bad task.
    expect(isQuotaFailure("TypeError: cannot read property of undefined")).toBe(false);
    expect(isQuotaFailure("the worker heartbeat is stale")).toBe(false);
    expect(isQuotaFailure(undefined)).toBe(false);
  });

  test("reads the provider off a selector", () => {
    expect(providerOfSelector("anthropic/claude-opus-5")).toBe("anthropic");
    expect(providerOfSelector("opus")).toBeUndefined();
  });

  test("a benched provider counts as unavailable, then recovers on its own", () => {
    const root = stateRoot();
    penaliseProvider(root, "openrouter", "402 payment required", 60_000, now);
    expect(unavailableProviders(usage, root, 0.95, now).has("openrouter")).toBe(true);
    // The ban is short so a recovered provider returns without manual cleanup.
    expect(unavailableProviders(usage, root, 0.95, now + 61_000).has("openrouter")).toBe(false);
  });

  test("benching one provider does not evict another", () => {
    const root = stateRoot();
    penaliseProvider(root, "a", "429", 60_000, now);
    penaliseProvider(root, "b", "402", 60_000, now);
    expect(readPenalties(root, now).map((entry) => entry.provider).sort()).toEqual(["a", "b"]);
  });

  test("combines quota exhaustion with recent refusals", () => {
    const root = stateRoot();
    penaliseProvider(root, "openrouter", "429", 60_000, now);
    expect([...unavailableProviders(usage, root, 0.95, now)].sort()).toEqual(["anthropic", "openrouter"]);
  });
});

describe("headroom-weighted ranking", () => {
  const candidate = (provider: string): RoutingCandidate => ({
    harness: "omp",
    model: `${provider}/model`,
    host: "local",
    capabilities: ["general"],
    enabled: true,
    costWeight: 1,
    quality: 1,
    latency: 1,
    provider,
  });
  const config = {
    hosts: { local: { name: "local", kind: "local", stateRoot: "/tmp", maxParallel: 1 } },
    defaultHarness: "omp",
    defaultHost: "local",
  } as unknown as MafiaConfig;
  const candidates = [candidate("kimi-code"), candidate("openrouter")];

  test("prefers the provider with more room when models are otherwise equal", () => {
    // A hard cut-off alone keeps loading the fullest provider until it tips.
    // Grading spreads the work before that happens.
    const routes = rankTaskRoutes(config, {
      capability: "general",
      headroom: (provider) => providerHeadroom(usage, provider),
    }, new Map(), candidates);
    expect(routes[0]!.model).toBe("openrouter/model");
  });

  test("ties are unaffected when no quota is known", () => {
    const routes = rankTaskRoutes(config, { capability: "general" }, new Map(), candidates);
    expect(routes[0]!.model).toBe("kimi-code/model");
  });

  test("records the remaining quota in the decision's reasons", () => {
    const routes = rankTaskRoutes(config, {
      capability: "general",
      headroom: (provider) => providerHeadroom(usage, provider),
    }, new Map(), candidates);
    expect(routes[0]!.reasons.join(" ")).toContain("90% provider quota left");
  });

  test("headroom does not outrank a large quality gap", () => {
    // A nearly-full premium model should still beat a weak empty one.
    const strong = { ...candidate("kimi-code"), quality: 1 };
    const weak = { ...candidate("openrouter"), quality: 0.5 };
    const routes = rankTaskRoutes(config, {
      capability: "general",
      headroom: (provider) => providerHeadroom(usage, provider),
    }, new Map(), [strong, weak]);
    expect(routes[0]!.model).toBe("kimi-code/model");
  });
});
