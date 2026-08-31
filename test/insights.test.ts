import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInsights, formatInsights, type Insight } from "../src/insights";
import { TelemetryStore } from "../src/telemetry-store";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "mafia-ins-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function seed(state: string, turns: Array<Partial<Parameters<TelemetryStore["ingest"]>[5][number]>>): void {
  const store = new TelemetryStore(state);
  store.ingest("f", "claude", 1, 1, 1, turns.map((turn, index) => ({
    id: `t${index}`, harness: "claude", sessionId: "s", startedAt: "2026-08-01T00:00:00.000Z",
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ok: 1,
    ...turn,
  })) as never);
}

describe("insights", () => {
  test("flags a harness that is not getting cache reads", () => {
    // Cache reads are the cheapest input available; sending fresh instead is
    // paying full price for context already sent.
    const state = root();
    seed(state, [{ inputTokens: 5_000_000, cacheReadTokens: 100_000 }]);
    const found = buildInsights(state);
    expect(found.some((entry) => entry.title.includes("uncached"))).toBe(true);
  });

  test("stays quiet when caching is working", () => {
    const state = root();
    seed(state, [{ inputTokens: 100_000, cacheReadTokens: 5_000_000 }]);
    expect(buildInsights(state).some((entry) => entry.title.includes("uncached"))).toBe(false);
  });

  test("names the model that produces most of the output", () => {
    const state = root();
    seed(state, [
      { model: "big", outputTokens: 9_000_000 },
      { model: "small", outputTokens: 100_000 },
    ]);
    const found = buildInsights(state);
    expect(found.some((entry) => entry.title.includes("big") && entry.title.includes("of all output"))).toBe(true);
  });

  test("does not claim concentration when work is spread", () => {
    const state = root();
    seed(state, [
      { model: "a", outputTokens: 1_000_000 },
      { model: "b", outputTokens: 1_000_000 },
      { model: "c", outputTokens: 1_000_000 },
    ]);
    expect(buildInsights(state).some((entry) => entry.title.includes("of all output"))).toBe(false);
  });

  test("ignores a model with too little history to judge", () => {
    // One expensive turn is not a pattern, and one model is trivially all of
    // the output when there is barely any output.
    const state = root();
    seed(state, [{ model: "rare", outputTokens: 500, reasoningTokens: 400 }]);
    expect(buildInsights(state).some((entry) => entry.title.includes("rare"))).toBe(false);
  });

  test("every finding carries evidence and one action", () => {
    // A dashboard that reports a number without naming what to do gets read
    // once and then ignored.
    const state = root();
    seed(state, [{ model: "big", outputTokens: 9_000_000, inputTokens: 5_000_000 }, { model: "b", outputTokens: 100_000 }]);
    for (const entry of buildInsights(state)) {
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.action.length).toBeGreaterThan(0);
    }
  });

  test("orders the largest lever first", () => {
    const found: Insight[] = [
      { weight: 1, title: "small", evidence: "e", action: "a" },
      { weight: 100, title: "large", evidence: "e", action: "a" },
    ].sort((left, right) => right.weight - left.weight);
    expect(formatInsights(found).indexOf("large")).toBeLessThan(formatInsights(found).indexOf("small"));
  });

  test("says so plainly when nothing stands out", () => {
    expect(formatInsights([])).toContain("nothing stands out");
  });
});
