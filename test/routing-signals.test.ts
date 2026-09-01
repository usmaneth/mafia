import { describe, expect, test } from "bun:test";
import { catalogCandidates, type RoutingSignals } from "../src/models";
import { rankTaskRoutes } from "../src/router";
import type { MafiaConfig, ModelCatalog, ModelRecord } from "../src/types";

const model = (selector: string, harness: string, cost?: { input: number; output: number }): ModelRecord =>
  ({ harness, provider: selector.split("/")[0]!, id: selector.split("/").at(-1)!, selector, name: selector, source: harness, available: true, cost }) as ModelRecord;

const catalog: ModelCatalog = {
  generatedAt: new Date().toISOString(),
  sources: [],
  models: [
    model("openai-codex/gpt-5.6-sol", "codex", { input: 5, output: 20 }),
    model("anthropic/claude-opus-5", "claude", { input: 5, output: 25 }),
    model("kimi-code/k3", "kimi", { input: 1, output: 3 }),
  ],
};

function candidates(signals: RoutingSignals = {}) {
  return catalogCandidates(catalog, ["vps"], {}, signals);
}

describe("merge outcomes as a quality signal", () => {
  test("a model whose work merges outranks its name-pattern score", () => {
    const [plain] = candidates().filter((c) => c.model === "openai-codex/gpt-5.6-sol");
    const [scored] = candidates({ outcomes: [{ model: "gpt-5.6-sol", prs: 7, mergeRate: 1 }] })
      .filter((c) => c.model === "openai-codex/gpt-5.6-sol");
    expect(scored!.quality).toBeGreaterThan(plain!.quality);
    expect(scored!.mergeRate).toBe(1);
  });

  test("a handful of pull requests is a hint, not a verdict", () => {
    // Below five, the sample says nothing and must change nothing.
    const [scored] = candidates({ outcomes: [{ model: "gpt-5.6-sol", prs: 3, mergeRate: 1 }] })
      .filter((c) => c.model === "openai-codex/gpt-5.6-sol");
    expect(scored!.quality).toBe(candidates()[0]!.quality);
    expect(scored!.mergeRate).toBeUndefined();
  });

  test("the bonus is capped so a streak cannot displace a frontier model", () => {
    const [scored] = candidates({ outcomes: [{ model: "gpt-5.6-sol", prs: 50, mergeRate: 1 }] })
      .filter((c) => c.model === "openai-codex/gpt-5.6-sol");
    expect(scored!.quality).toBeLessThanOrEqual(0.99);
  });

  test("work that does not merge lowers the score", () => {
    const [plain] = candidates().filter((c) => c.model === "kimi-code/k3");
    const [scored] = candidates({ outcomes: [{ model: "k3", prs: 8, mergeRate: 0 }] })
      .filter((c) => c.model === "kimi-code/k3");
    expect(scored!.quality).toBeLessThan(plain!.quality);
  });
});

describe("observed cache rate as effective cost", () => {
  test("a harness that caches nearly everything is cheaper than its list price", () => {
    const [plain] = candidates().filter((c) => c.harness === "claude");
    const [scored] = candidates({ cacheRates: { claude: 1 } }).filter((c) => c.harness === "claude");
    // A cached token is about a tenth of the fresh price.
    expect(scored!.costWeight).toBeLessThan(plain!.costWeight * 0.2);
  });

  test("no observation leaves the list price alone", () => {
    const [plain] = candidates().filter((c) => c.harness === "claude");
    const [scored] = candidates({ cacheRates: {} }).filter((c) => c.harness === "claude");
    expect(scored!.costWeight).toBe(plain!.costWeight);
  });

  test("only the observed harness is adjusted", () => {
    const scored = candidates({ cacheRates: { claude: 1 } });
    expect(scored.find((c) => c.harness === "codex")!.costWeight)
      .toBe(candidates().find((c) => c.harness === "codex")!.costWeight);
  });
});

describe("visibility", () => {
  test("the route decision says when outcomes and caching moved it", () => {
    const config = {
      hosts: { vps: { name: "vps", kind: "ssh", target: "x@y", stateRoot: "/s", maxParallel: 1 } },
      defaultHarness: "omp", defaultHost: "vps",
    } as unknown as MafiaConfig;
    const ranked = rankTaskRoutes(config, { capability: "general" }, new Map(),
      candidates({ outcomes: [{ model: "gpt-5.6-sol", prs: 7, mergeRate: 1 }], cacheRates: { codex: 0.5 } }));
    // The signals belong to the route they moved, wherever it ranks.
    const sol = ranked.find((route) => route.model === "openai-codex/gpt-5.6-sol");
    const reasons = sol!.reasons.join(" | ");
    expect(reasons).toContain("pull requests merged");
    expect(reasons).toContain("input cached");
  });

  test("no signals means no invented reasons", () => {
    const config = {
      hosts: { vps: { name: "vps", kind: "ssh", target: "x@y", stateRoot: "/s", maxParallel: 1 } },
      defaultHarness: "omp", defaultHost: "vps",
    } as unknown as MafiaConfig;
    const [top] = rankTaskRoutes(config, { capability: "general" }, new Map(), candidates());
    expect(top!.reasons.join(" ")).not.toContain("merged");
  });
});
