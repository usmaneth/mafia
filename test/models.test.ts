import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { catalogCandidates, ModelCatalogService, parseClaudeModels, parseClineModels, parseCodexModels, parseKimiModels, parseOmpModels, parseOpenCodeModels } from "../src/models";

describe("model catalog", () => {
  test("parses each harness catalog", () => {
    expect(parseOmpModels(JSON.stringify({ models: [{ provider: "x", id: "m", selector: "x/m" }] }))).toHaveLength(1);
    expect(parseOpenCodeModels("openai/gpt-5\nopenrouter/free\n")).toHaveLength(2);
    expect(parseCodexModels(JSON.stringify({ models: [{ slug: "gpt-5", visibility: "list" }] }))).toHaveLength(1);
    expect(parseKimiModels('[models.k3]\ndisplay_name = "K3"\ncontext_size = 1000\n')).toHaveLength(1);
    expect(parseClineModels(JSON.stringify({ providers: { cline: { settings: { model: "cline/k3" } } } }))).toHaveLength(1);
  });

  test("turns all coding models into route candidates", () => {
    const models = parseOmpModels(JSON.stringify({ models: [
      { provider: "openai", id: "gpt-5.5", selector: "openai/gpt-5.5" },
      { provider: "openai", id: "embedding-3", selector: "openai/embedding-3" },
    ] }));
    const candidates = catalogCandidates({ generatedAt: "", models, sources: [] }, ["local", "vps"]);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((item) => item.model === "openai/gpt-5.5")).toBe(true);
  });

  test("adds Claude Code native aliases without OMP Anthropic models", () => {
    expect(parseClaudeModels([]).map((model) => model.selector)).toEqual([
      "sonnet",
      "opus",
      "haiku",
    ]);
  });

  test("does not treat negative provider price sentinels as a discount", () => {
    const models = parseOmpModels(JSON.stringify({ models: [{
      provider: "openrouter",
      id: "auto",
      selector: "openrouter/auto",
      cost: { input: -1, output: -1 },
    }] }));
    expect(catalogCandidates({ generatedAt: "", models, sources: [] }, ["local"])[0].costWeight).toBe(0);
  });

  test("keeps the last healthy provider models when refresh fails", () => {
    const root = join(tmpdir(), `mafia-model-cache-${crypto.randomUUID()}`);
    const path = join(root, "models", "catalog.json");
    mkdirSync(join(root, "models"), { recursive: true });
    writeFileSync(path, JSON.stringify({
      generatedAt: "2000-01-01T00:00:00.000Z",
      models: [{
        harness: "omp",
        provider: "anthropic",
        id: "claude-sonnet-5",
        selector: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        source: "omp",
        available: true,
      }],
      sources: [],
    }));
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const catalog = new ModelCatalogService(root).discover(true);
      expect(catalog.models.some((model) => model.selector === "anthropic/claude-sonnet-5")).toBe(true);
      expect(catalog.sources.find((source) => source.harness === "omp")?.status).toBe("error");
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
