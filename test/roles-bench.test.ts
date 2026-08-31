import { describe, expect, test } from "bun:test";
import { healthyRoleModels, roleArgs, formatRoleChanges } from "../src/roles";
import { latencyWeight, parseBench } from "../src/bench";
import { commandFor } from "../src/harnesses";
import { parseProviderUsage } from "../src/provider-usage";
import type { JobSpec, ModelCatalog, ModelRecord } from "../src/types";

const now = Date.UTC(2026, 7, 31, 20, 0, 0);
const stateRoot = "/nonexistent-mafia-test-root";

const record = (harness: string, provider: string, id: string, selector: string, output = 5): ModelRecord =>
  ({ harness, provider, id, selector, name: selector, source: harness, available: true, cost: { input: 1, output } }) as ModelRecord;

const catalog: ModelCatalog = {
  generatedAt: new Date(now).toISOString(),
  sources: [],
  models: [
    record("omp", "anthropic", "claude-opus-5", "anthropic/claude-opus-5", 25),
    record("omp", "openrouter", "anthropic/claude-opus-5", "openrouter/anthropic/claude-opus-5", 25),
    record("omp", "xai-oauth", "grok-build", "xai-oauth/grok-build", 15),
    record("omp", "openai-codex", "gpt-5.6-sol", "openai-codex/gpt-5.6-sol", 20),
    record("omp", "google", "gemini-3.7-flash", "google/gemini-3.7-flash", 0.5),
    record("omp", "openai-codex", "gpt-5.4-mini", "openai-codex/gpt-5.4-mini", 1),
  ],
};

const usage = (fractions: Record<string, number>) => parseProviderUsage(JSON.stringify({
  generatedAt: now,
  reports: Object.entries(fractions).map(([provider, used]) => ({
    provider,
    limits: [{ label: "7 Day", amount: { usedFraction: used } }],
  })),
}), now);

const configured = {
  smol: "openai-codex/gpt-5.4-mini",
  slow: "anthropic/claude-opus-5",
  plan: "xai-oauth/grok-build",
  task: "openrouter/anthropic/claude-opus-5",
  designer: "google/gemini-3.7-flash",
  default: "xai-oauth/grok-build",
};

describe("repinning OMP roles off a spent provider", () => {
  test("does nothing while every provider can take work", () => {
    const value = healthyRoleModels(configured, catalog, usage({ anthropic: 0.1 }), stateRoot);
    expect(value.changes).toHaveLength(0);
    expect(roleArgs(value.overrides)).toEqual([]);
  });

  test("swaps a role to the same model on a healthy provider", () => {
    // Mafia only ever set the outer --model. OMP's own subagents kept using the
    // profile's roles, so a dead provider there was still being called.
    const value = healthyRoleModels(configured, catalog, usage({ anthropic: 0.99 }), stateRoot);
    expect(value.overrides.slow).toBe("openrouter/anthropic/claude-opus-5");
  });

  test("repins a reasoning role only to a comparable model", () => {
    // grok-build at $15 against opus at $25 is a peer, not a downgrade, so the
    // swap is allowed. The flash model in the catalog must not win it.
    const value = healthyRoleModels(
      configured,
      catalog,
      usage({ anthropic: 0.99, openrouter: 0.99, "openai-codex": 0.99 }),
      stateRoot,
    );
    expect(value.overrides.slow).toBe("xai-oauth/grok-build");
    expect(value.overrides.slow).not.toBe("google/gemini-3.7-flash");
  });

  test("refuses rather than dropping a reasoning role to a flash model", () => {
    // With only the cheap model left there is no honest substitute. Quietly
    // taking it would weaken every plan the agent makes without saying so.
    const value = healthyRoleModels(
      configured,
      catalog,
      usage({ anthropic: 0.99, openrouter: 0.99, "openai-codex": 0.99, "xai-oauth": 0.99 }),
      stateRoot,
    );
    expect(value.overrides.slow).toBeUndefined();
    expect(value.unfixable.some((entry) => entry.role === "slow")).toBe(true);
  });

  test("a cheap role may take anything, cheapest first", () => {
    const value = healthyRoleModels(configured, catalog, usage({ "openai-codex": 0.99 }), stateRoot);
    expect(value.overrides.smol).toBe("google/gemini-3.7-flash");
  });

  test("reports a role OMP cannot override instead of claiming all is well", () => {
    // `task` has no command-line flag. Skipping it silently reported "every
    // role is healthy" while it pointed at a provider that was out of credits.
    const value = healthyRoleModels(configured, catalog, usage({ openrouter: 0.99 }), stateRoot);
    expect(value.unfixable.some((entry) => entry.role === "task")).toBe(true);
    expect(formatRoleChanges(value.changes, value.unfixable)).toContain("STUCK");
  });

  test("never calls `default` stuck, because --model supersedes it", () => {
    const value = healthyRoleModels(configured, catalog, usage({ "xai-oauth": 0.99 }), stateRoot);
    expect(value.unfixable.some((entry) => entry.role === "default")).toBe(false);
  });

  test("emits only flags OMP accepts", () => {
    const args = roleArgs({ smol: "a/b", slow: "c/d", plan: "e/f", task: "g/h", designer: "i/j" });
    expect(args).toEqual(["--smol", "a/b", "--slow", "c/d", "--plan", "e/f"]);
  });
});

describe("measured latency", () => {
  test("reads the median, not the mean", () => {
    // A mean is dragged by one slow response; routing wants the usual case.
    const value = parseBench(JSON.stringify({
      models: [{ selector: "a/b", byChallenge: { chat: { ttftMs: { mean: 9000, p50: 600 }, tokensPerSecond: { p50: 40 } } } }],
    }), new Date(now).toISOString());
    expect(value["a/b"]!.ttftMs).toBe(600);
    expect(value["a/b"]!.tokensPerSecond).toBe(40);
  });

  test("records a failure instead of inventing a number", () => {
    const value = parseBench(JSON.stringify({
      models: [{ selector: "a/b", stats: null, results: [{ ok: false, error: "thinking level unsupported" }] }],
    }));
    expect(value["a/b"]!.ttftMs).toBeUndefined();
    expect(value["a/b"]!.error).toContain("unsupported");
  });

  test("converts time to first token into the router's weight", () => {
    expect(latencyWeight({ selector: "x", measuredAt: "", ttftMs: 600 })).toBeCloseTo(0.15, 2);
    expect(latencyWeight({ selector: "x", measuredAt: "", ttftMs: 4000 })).toBe(1);
  });

  test("an unmeasured model yields nothing, so the caller keeps its fallback", () => {
    expect(latencyWeight(undefined)).toBeUndefined();
    expect(latencyWeight({ selector: "x", measuredAt: "", error: "failed" })).toBeUndefined();
  });

  test("clamps an implausibly fast measurement rather than scoring zero", () => {
    expect(latencyWeight({ selector: "x", measuredAt: "", ttftMs: 1 })).toBeGreaterThan(0);
  });
});

describe("the OMP invocation", () => {
  const spec = (extra: Partial<JobSpec> = {}): JobSpec => ({
    id: "job-1", title: "t", prompt: "p", harness: "omp", host: "vps",
    isolate: false, labels: [], createdAt: "", stateRoot: "/s", timeoutSeconds: 600,
    model: "anthropic/claude-opus-5", ...extra,
  }) as JobSpec;

  test("lets OMP stop itself before the worker kills the process group", () => {
    // OMP's own limit ends the session cleanly and still writes a result.
    const args = commandFor(spec(), "/repo").args;
    expect(args).toContain("--max-time");
    expect(Number(args[args.indexOf("--max-time") + 1])).toBeLessThan(600);
  });

  test("carries the healthy role pins", () => {
    const args = commandFor(spec({ roleModels: { slow: "x/y" } }), "/repo").args;
    expect(args.join(" ")).toContain("--slow x/y");
  });

  test("is ephemeral unless a session is asked for", () => {
    expect(commandFor(spec(), "/repo").args).toContain("--no-session");
    expect(commandFor(spec({ session: true }), "/repo").args).not.toContain("--no-session");
  });

  test("only adds prewalk when asked", () => {
    expect(commandFor(spec(), "/repo").args).not.toContain("--prewalk");
    expect(commandFor(spec({ prewalk: true }), "/repo").args).toContain("--prewalk");
  });
});
