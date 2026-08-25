import { describe, expect, test } from "bun:test";
import { resolveCatalogModel } from "../src/models";
import { rankTaskRoutes } from "../src/router";
import type { MafiaConfig, ModelCatalog, RoutingCandidate } from "../src/types";

const catalog: ModelCatalog = {
  generatedAt: "",
  sources: [],
  models: [
    {
      harness: "claude",
      provider: "anthropic",
      id: "claude-3-5-sonnet-20240620",
      selector: "claude-3-5-sonnet-20240620",
      name: "Claude Sonnet 3.5",
      source: "claude",
      available: true,
    },
    {
      harness: "opencode",
      provider: "openrouter",
      id: "anthropic/claude-sonnet-5",
      selector: "openrouter/anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      source: "opencode",
      available: true,
    },
    {
      harness: "claude",
      provider: "anthropic",
      id: "sonnet",
      selector: "sonnet",
      name: "Claude Sonnet",
      source: "claude",
      available: true,
    },
    {
      harness: "omp",
      provider: "anthropic",
      id: "claude-sonnet-5",
      selector: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      source: "omp",
      available: true,
    },
    {
      harness: "claude",
      provider: "anthropic",
      id: "claude-sonnet-5",
      selector: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      source: "claude",
      available: true,
    },
    {
      harness: "codex",
      provider: "openai-codex",
      id: "gpt-5.4",
      selector: "gpt-5.4",
      name: "GPT-5.4",
      source: "codex",
      available: true,
    },
  ],
};

describe("model selection", () => {
  test("maps a friendly model name to its native harness", () => {
    const selected = resolveCatalogModel(catalog, "sonnet 5");
    expect(selected.harness).toBe("claude");
    expect(selected.selector).toBe("sonnet");
  });

  test("honors an exact provider selector", () => {
    const selected = resolveCatalogModel(catalog, "anthropic/claude-sonnet-5");
    expect(selected.harness).toBe("omp");
  });

  test("does not confuse Sonnet 5 with Sonnet 3.5", () => {
    expect(resolveCatalogModel(catalog, "sonnet 5").id).not.toBe("claude-3-5-sonnet-20240620");
  });

  test("honors an exact native Claude model ID", () => {
    expect(resolveCatalogModel(catalog, "claude-sonnet-5").selector).toBe("claude-sonnet-5");
  });

  test("maps a versioned family request to a native Claude alias", () => {
    const aliasOnly = { ...catalog, models: catalog.models.filter((model) => model.id !== "claude-sonnet-5") };
    const selected = resolveCatalogModel(aliasOnly, "sonnet 5");
    expect(selected.harness).toBe("claude");
    expect(selected.selector).toBe("sonnet");
  });

  test("ranks the complete eligible fallback set", () => {
    const config = {
      version: 2,
      defaultHost: "local",
      defaultHarness: "codex",
      stateRoot: "/tmp/mafia",
      hosts: { local: { name: "local", kind: "local", stateRoot: "/tmp/mafia" } },
    } satisfies MafiaConfig;
    const candidates: RoutingCandidate[] = [
      {
        harness: "claude",
        model: "claude-sonnet-5",
        host: "local",
        capabilities: ["general"],
        enabled: true,
        costWeight: 0.7,
        quality: 0.98,
        latency: 0.6,
      },
      {
        harness: "codex",
        model: "gpt-5.4",
        host: "local",
        capabilities: ["general"],
        enabled: true,
        costWeight: 0.5,
        quality: 0.96,
        latency: 0.5,
      },
      {
        harness: "omp",
        model: "openrouter/nvidia/nemotron",
        host: "local",
        capabilities: ["general"],
        enabled: true,
        costWeight: 0,
        quality: 0.8,
        latency: 0.8,
      },
    ];
    const routes = rankTaskRoutes(config, { capability: "general" }, new Map(), candidates);
    expect(routes).toHaveLength(3);
    expect(new Set(routes.map((route) => route.model))).toEqual(new Set([
      "claude-sonnet-5",
      "gpt-5.4",
      "openrouter/nvidia/nemotron",
    ]));
  });

  test("prefers the VPS when the caller does not select a host", () => {
    const config = {
      version: 3,
      defaultHost: "vps",
      defaultHarness: "codex",
      stateRoot: "/tmp/mafia",
      hosts: {
        local: { name: "local", kind: "local", stateRoot: "/tmp/mafia" },
        vps: { name: "vps", kind: "ssh", target: "example", stateRoot: "/tmp/mafia-vps" },
      },
    } satisfies MafiaConfig;
    const base = {
      harness: "codex" as const,
      model: "gpt-5.4",
      capabilities: ["general" as const],
      enabled: true,
      costWeight: 0.5,
      quality: 0.96,
      latency: 0.5,
    };
    const routes = rankTaskRoutes(config, { capability: "general" }, new Map(), [
      { ...base, host: "local" },
      { ...base, host: "vps" },
    ]);
    expect(routes[0].host).toBe("vps");
    expect(rankTaskRoutes(config, { capability: "general", host: "local" }, new Map(), [
      { ...base, host: "local" },
      { ...base, host: "vps" },
    ])[0].host).toBe("local");
  });
});
