import { describe, expect, test } from "bun:test";
import { catalogCandidates, parseClineModels, parseCodexModels, parseKimiModels, parseOmpModels, parseOpenCodeModels } from "../src/models";

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

  test("does not treat negative provider price sentinels as a discount", () => {
    const models = parseOmpModels(JSON.stringify({ models: [{
      provider: "openrouter",
      id: "auto",
      selector: "openrouter/auto",
      cost: { input: -1, output: -1 },
    }] }));
    expect(catalogCandidates({ generatedAt: "", models, sources: [] }, ["local"])[0].costWeight).toBe(0);
  });
});
