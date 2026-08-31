import { describe, expect, test } from "bun:test";
import {
  applyEffort,
  catalogEfforts,
  filterCatalog,
  effortLevels,
  parseEffort,
  parseModelSelector,
  resolveCatalogModel,
} from "../src/models";
import { formatModels } from "../src/format";
import type { ModelCatalog, ModelRecord } from "../src/types";

function model(input: Partial<ModelRecord> & Pick<ModelRecord, "selector" | "harness">): ModelRecord {
  return {
    provider: input.selector.split("/")[0]!,
    id: input.selector.split("/").pop()!,
    name: input.selector,
    source: input.harness,
    available: true,
    ...input,
  } as ModelRecord;
}

const catalog: ModelCatalog = {
  generatedAt: new Date().toISOString(),
  sources: [
    { harness: "omp", status: "ok", count: 3 },
    { harness: "claude", status: "ok", count: 1 },
  ],
  models: [
    model({
      harness: "omp",
      selector: "anthropic/claude-opus-5",
      name: "Claude Opus 5",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      reasoning: true,
      contextWindow: 1_000_000,
      cost: { input: 5, output: 25 },
    }),
    model({
      harness: "omp",
      selector: "xai-oauth/grok-4.6",
      name: "Grok 4.6",
      efforts: ["low", "medium", "high", "xhigh"],
      reasoning: true,
      contextWindow: 2_000_000,
    }),
    model({
      harness: "omp",
      selector: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      name: "Nemotron Ultra (free)",
      contextWindow: 131_072,
      cost: { input: 0, output: 0 },
    }),
    // A real model id whose tail ("mini") prefix-matches the effort "minimal".
    // Only asking the catalog first can tell these apart.
    model({ harness: "omp", selector: "acme/coder:mini", name: "Acme Coder Mini", contextWindow: 32_000 }),
    // The claude harness exposes a bare "opus" id. A fuzzy rule scores this 96,
    // which is how an effort-suffixed request used to land on the wrong harness.
    model({ harness: "claude", selector: "opus", id: "opus", name: "Claude Opus" }),
  ],
};

describe("effort suffix parsing", () => {
  test("splits a known effort off the selector", () => {
    expect(parseModelSelector("xai-oauth/grok-4.6:high")).toEqual({ base: "xai-oauth/grok-4.6", effort: "high" });
  });

  test("leaves a provider suffix that is not an effort", () => {
    // A free or batch tier is part of the model id, not a reasoning level.
    expect(parseModelSelector("openrouter/nvidia/nemotron:free")).toEqual({ base: "openrouter/nvidia/nemotron:free" });
    expect(parseModelSelector("openrouter/anthropic/claude-opus-5:batch")).toEqual({
      base: "openrouter/anthropic/claude-opus-5:batch",
    });
  });

  test("splits only the final segment", () => {
    expect(parseModelSelector("openrouter/anthropic/claude-opus-5:batch:high")).toEqual({
      base: "openrouter/anthropic/claude-opus-5:batch",
      effort: "high",
    });
  });

  test("handles a selector with no colon", () => {
    expect(parseModelSelector("opus")).toEqual({ base: "opus" });
  });

  test("ignores a leading colon", () => {
    expect(parseModelSelector(":high")).toEqual({ base: ":high" });
  });

  test("accepts an effort the catalog reports but the default list omits", () => {
    const known = catalogEfforts({ ...catalog, models: [model({ harness: "omp", selector: "a/b", efforts: ["turbo"] })] });
    expect(parseModelSelector("a/b:turbo", known)).toEqual({ base: "a/b", effort: "turbo" });
    expect(parseModelSelector("a/b:turbo")).toEqual({ base: "a/b:turbo" });
  });
});

function find(selector: string): ModelRecord {
  const value = catalog.models.find((entry) => entry.selector === selector);
  if (!value) throw new Error(`fixture missing: ${selector}`);
  return value;
}

describe("effort application", () => {
  const opus = find("anthropic/claude-opus-5");

  test("attaches a supported level to the selector", () => {
    expect(applyEffort(opus, "high").selector).toBe("anthropic/claude-opus-5:high");
    expect(applyEffort(opus, "high").effort).toBe("high");
  });

  test("drops a level the model does not accept", () => {
    // Passing it through would build a selector the harness rejects at runtime.
    expect(applyEffort(opus, "minimal").selector).toBe("anthropic/claude-opus-5");
    expect(applyEffort(opus, "minimal").effort).toBeUndefined();
  });

  test("returns the model unchanged when no effort is asked for", () => {
    expect(applyEffort(opus, undefined)).toBe(opus);
  });

  test("does not invent an effort for a harness that has none", () => {
    expect(applyEffort(find("opus"), "high").selector).toBe("opus");
  });
});

describe("resolving a model with an effort", () => {
  test("keeps the effort and returns the right harness", () => {
    // The regression: "anthropic/claude-opus-5:xhigh" used to resolve to the
    // claude harness's bare "opus" record, silently running a different model.
    const value = resolveCatalogModel(catalog, "anthropic/claude-opus-5:xhigh");
    expect(value.harness).toBe("omp");
    expect(value.selector).toBe("anthropic/claude-opus-5:xhigh");
  });

  test("resolves a selector that used to fail outright", () => {
    const value = resolveCatalogModel(catalog, "xai-oauth/grok-4.6:high");
    expect(value.selector).toBe("xai-oauth/grok-4.6:high");
  });

  test("does not strip a free tier that looks like an effort", () => {
    const value = resolveCatalogModel(catalog, "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(value.selector).toBe("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
  });

  test("still resolves a bare selector", () => {
    expect(resolveCatalogModel(catalog, "anthropic/claude-opus-5").selector).toBe("anthropic/claude-opus-5");
  });
});

describe("harness-compatible effort syntax", () => {
  test("accepts the abbreviations OMP accepts, and canonicalises them", () => {
    // `omp --model x:med` works, so `mafia --model x:med` must too. Mafia used
    // to reject a selector the harness it drives would have taken.
    expect(resolveCatalogModel(catalog, "xai-oauth/grok-4.6:med").selector).toBe("xai-oauth/grok-4.6:medium");
    expect(resolveCatalogModel(catalog, "xai-oauth/grok-4.6:xhi").selector).toBe("xai-oauth/grok-4.6:xhigh");
  });

  test("refuses an abbreviation too short to be unambiguous", () => {
    // "m" could be minimal, medium, or max, so it must stay part of the id.
    expect(parseModelSelector("a/b:m")).toEqual({ base: "a/b:m" });
  });

  test("a real model id wins over reading its tail as an effort", () => {
    // "mini" prefix-matches "minimal". Without asking the catalog first, this
    // resolves to a different model at an effort nobody asked for.
    const value = resolveCatalogModel(catalog, "acme/coder:mini");
    expect(value.selector).toBe("acme/coder:mini");
    expect(value.effort).toBeUndefined();
  });

  test("the ladder comes from the harness, not a local copy", () => {
    // The local list omitted "max" on the day it was written.
    expect(effortLevels.map(String)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("effort filter", () => {
  test("keeps only models that accept the level", () => {
    const value = filterCatalog(catalog, { effort: "max" });
    expect(value.models.map((entry) => entry.selector)).toEqual(["anthropic/claude-opus-5"]);
  });

  test("an unknown level matches nothing rather than everything", () => {
    expect(filterCatalog(catalog, { effort: "turbo" }).models).toHaveLength(0);
  });

  test("no filter keeps every model", () => {
    expect(filterCatalog(catalog, {}).models).toHaveLength(5);
  });
});

describe("catalog rendering", () => {
  const rendered = formatModels(catalog, catalog.models);

  test("aligns the selector column across rows of differing name width", () => {
    // Tab separation put the selector, the field a reader copies, at a
    // different column on every row. Every data row must start it in one place.
    const starts = [
      ["  ", "anthropic/claude-opus-5"],
      ["  ", "xai-oauth/grok-4.6"],
      ["  ", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"],
    ].map(([indent, selector]) => {
      const row = rendered.split("\n").find((line) => line.startsWith(indent!) && line.includes(` ${selector} `));
      expect(row).toBeDefined();
      return row!.indexOf(selector!);
    });
    expect(new Set(starts).size).toBe(1);
  });

  test("puts the header over the same column as the data", () => {
    const header = rendered.split("\n").find((line) => line.includes("SELECTOR"))!;
    const row = rendered.split("\n").find((line) => line.includes(" anthropic/claude-opus-5 "))!;
    expect(header.indexOf("SELECTOR")).toBe(row.indexOf("anthropic/claude-opus-5"));
  });

  test("shows the effort ladder for a reasoning model", () => {
    expect(rendered).toContain("low med high xhigh max");
  });

  test("marks a model with no effort levels", () => {
    expect(rendered).toMatch(/Nemotron Ultra \(free\).*\s-\s*$/m);
  });

  test("groups by provider and harness", () => {
    expect(rendered).toContain("anthropic via omp");
    expect(rendered).toContain("xai-oauth via omp");
  });

  test("explains the effort syntax", () => {
    expect(rendered).toContain("append an effort to a selector");
  });

  test("reports a failed source instead of hiding it behind a count", () => {
    const broken = { ...catalog, sources: [{ harness: "omp" as const, status: "error" as const, count: 3, error: "omp not found" }] };
    const value = formatModels(broken, catalog.models);
    expect(value).toContain("omp not found");
    expect(value).toContain("last good list");
  });

  test("says so when nothing matches", () => {
    expect(formatModels(catalog, [])).toContain("no matching models");
  });
});


describe("parity with OMP's own effort parser", () => {
  // The local copy exists for startup cost. These assertions are what make it
  // safe: if OMP adds a level or changes the abbreviation rule, this fails.
  test("the ladder matches THINKING_EFFORTS exactly", async () => {
    const { THINKING_EFFORTS } = await import("@oh-my-pi/pi-ai");
    expect(effortLevels.map(String)).toEqual(THINKING_EFFORTS.map(String));
  });

  test("every input parses the same as OMP's parseEffort", async () => {
    const { parseEffort: ompParse } = await import("@oh-my-pi/pi-coding-agent/thinking");
    const inputs = [
      "minimal", "low", "medium", "high", "xhigh", "max",
      "min", "med", "hi", "xhi", "ma", "lo", "m", "x", "l",
      "free", "batch", "mini", "", "HIGH", "Medium", "turbo", "xh",
    ];
    for (const input of inputs) {
      expect(`${input}=${parseEffort(input)}`).toBe(`${input}=${ompParse(input) ?? undefined}`);
    }
  });
});
