import { describe, expect, test } from "bun:test";
import {
  REFRESH_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  buildShowcase,
  compareVersions,
  mergeShowcase,
  parseOmpVersion,
  parseUpdateCheck,
  pinnedOmp,
  refreshDue,
  roleUpgrades,
  stripThinking,
  type CatalogEntry,
} from "../src/omp-sync";

const entries = (provider: string, ids: string[]): CatalogEntry[] => ids.map((id) => ({ provider, id }));

const anthropic = entries("anthropic", [
  "claude-3-5-sonnet-20241022",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-haiku-5-5",
  "claude-mythos-5-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
]);

const google = entries("google", [
  "gemini-2.5-flash-preview-09-2025",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-flash-live-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.8-flash-tts",
  "gemini-3.1-flash-image",
  "gemini-4-argon",
  "gemini-flash-latest",
  "gemma-4-31b-it",
]);

const openai = entries("openai", [
  "gpt-4.1",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-sol-pro",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-5-chat-latest",
  "gpt-5.1-codex-mini",
  "gpt-realtime",
  "gpt-6-audio",
]);

describe("buildShowcase", () => {
  test("takes the newest model of each Claude family and drops dated ids", () => {
    const list = buildShowcase(anthropic);
    expect(list).toHaveLength(5);
    expect(new Set(list)).toEqual(new Set([
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-mythos-5-1",
    ]));
  });

  test("shows the newest Gemini of each line and skips speech, image and live models", () => {
    const list = new Set(buildShowcase(google));
    expect(list).toEqual(new Set([
      "google/gemini-4-argon",
      "google/gemini-3.8-flash",
      "google/gemini-3.5-flash-lite",
      "google/gemini-3.1-pro-preview",
    ]));
  });

  test("a final release beats its preview on the same version", () => {
    const list = buildShowcase(entries("google", ["gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite"]));
    expect(list).toEqual(["google/gemini-3.1-flash-lite"]);
  });

  test("names GPT models under openai-codex and never under openai", () => {
    const list = buildShowcase(openai);
    expect(list.every((selector) => selector.startsWith("openai-codex/"))).toBe(true);
    // Chat, audio and realtime ids are out. Each tier keeps its newest model.
    expect(new Set(list)).toEqual(new Set([
      "openai-codex/gpt-6.1-sol",
      "openai-codex/gpt-6-astra",
      "openai-codex/gpt-6-luna",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-sol-pro",
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.5-pro",
    ]));
    expect(list).toHaveLength(7);
  });

  test("uses the Codex catalog alone when its login works", () => {
    const codex = entries("openai-codex", ["gpt-5.6-sol", "gpt-6-astra"]);
    const list = buildShowcase([...codex, ...openai]);
    expect(new Set(list)).toEqual(new Set(["openai-codex/gpt-5.6-sol", "openai-codex/gpt-6-astra"]));
  });

  test("falls back to the openai catalog when Codex lists nothing", () => {
    expect(buildShowcase(openai)).toContain("openai-codex/gpt-6.1-sol");
  });

  test("groups providers in a fixed order, newest first inside a group", () => {
    const list = buildShowcase([...google, ...anthropic, ...entries("xai-oauth", ["grok-4.6", "grok-4.5", "grok-build", "grok-build-0.1"])]);
    const providers = list.map((selector) => selector.split("/")[0]);
    expect(providers.indexOf("anthropic")).toBeLessThan(providers.indexOf("google"));
    expect(providers.indexOf("google")).toBeLessThan(providers.indexOf("xai-oauth"));
    expect(list.filter((selector) => selector.startsWith("xai-oauth/"))).toEqual(["xai-oauth/grok-4.6", "xai-oauth/grok-build"]);
  });

  test("keeps role models, strips the thinking level, and keeps :free", () => {
    const list = buildShowcase(anthropic, [
      "google/gemini-3.8-flash:high",
      "spark1-qwen/qwen3.8-flash-next:medium",
      "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      "openai-codex/gpt-5.4-mini:auto",
      "no-slash-alias",
    ]);
    expect(list).toContain("google/gemini-3.8-flash");
    expect(list).toContain("spark1-qwen/qwen3.8-flash-next");
    expect(list).toContain("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(list).toContain("openai-codex/gpt-5.4-mini");
    expect(list).not.toContain("no-slash-alias");
  });

  test("lists a model once when a role and a rule both name it", () => {
    const list = buildShowcase(anthropic, ["anthropic/claude-opus-5-5:high"]);
    expect(list.filter((selector) => selector === "anthropic/claude-opus-5-5")).toHaveLength(1);
  });

  test("returns an empty list for an empty catalog", () => {
    expect(buildShowcase([])).toEqual([]);
  });
});

describe("retired families", () => {
  test("drops a family that is more than one major version behind", () => {
    const list = buildShowcase([
      ...openai,
      ...entries("openai", ["gpt-4-turbo"]),
      ...entries("google", ["gemini-1.5-flash-8b", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-4-argon"]),
    ]);
    expect(list).not.toContain("openai-codex/gpt-4-turbo");
    expect(list).not.toContain("google/gemini-1.5-flash-8b");
    expect(list).toContain("google/gemini-3.5-flash-lite");
  });

  test("one new family alone does not retire the others", () => {
    const list = buildShowcase(entries("google", ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-5-nova"]));
    expect(list).toContain("google/gemini-5-nova");
    expect(list).toContain("google/gemini-3.8-flash");
    expect(list).toContain("google/gemini-3.1-pro-preview");
  });

  test("keeps a pinned role model even when its family is retired", () => {
    const list = buildShowcase(entries("openai", ["gpt-4-turbo", "gpt-6-sol", "gpt-6-luna"]), ["openai-codex/gpt-4-turbo"]);
    expect(list).toContain("openai-codex/gpt-4-turbo");
  });
});

describe("roleUpgrades", () => {
  test("names a role that points at an older model of its family", () => {
    const upgrades = roleUpgrades([...anthropic, ...openai, ...google], {
      slow: "anthropic/claude-opus-5",
      advisor: "openai-codex/gpt-5.6-sol",
      default: "google/gemini-3.8-flash:high",
      local: "spark1-qwen/qwen3.8-flash-next:medium",
    });
    expect(upgrades).toEqual([
      { role: "slow", from: "anthropic/claude-opus-5", to: "anthropic/claude-opus-5-5" },
      { role: "advisor", from: "openai-codex/gpt-5.6-sol", to: "openai-codex/gpt-6.1-sol" },
    ]);
  });

  test("reports nothing when every role is current", () => {
    expect(roleUpgrades(anthropic, { slow: "anthropic/claude-opus-5-5:high" })).toEqual([]);
  });
});

describe("stripThinking", () => {
  test("removes a level and keeps other tails", () => {
    expect(stripThinking("google/gemini-3.8-flash:high")).toBe("google/gemini-3.8-flash");
    expect(stripThinking("openrouter/x/y:free")).toBe("openrouter/x/y:free");
    expect(stripThinking("anthropic/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
  });
});

describe("compareVersions", () => {
  test("compares number by number and treats a missing number as zero", () => {
    expect(compareVersions([6, 1], [6])).toBeGreaterThan(0);
    expect(compareVersions([5, 6], [6])).toBeLessThan(0);
    expect(compareVersions([5], [5, 0])).toBe(0);
    expect(compareVersions([3, 10], [3, 8])).toBeGreaterThan(0);
  });
});

describe("mergeShowcase", () => {
  test("keeps an entry that a person added", () => {
    const merged = mergeShowcase(["a/1", "a/2"], ["a/1", "mine/x"], ["a/1"]);
    expect(merged).toEqual(["a/1", "a/2", "mine/x"]);
  });

  test("drops an entry that the last refresh wrote and this one does not", () => {
    expect(mergeShowcase(["a/2"], ["a/1", "a/2"], ["a/1", "a/2"])).toEqual(["a/2"]);
  });

  test("does not repeat an entry", () => {
    expect(mergeShowcase(["a/1"], ["a/1"], [])).toEqual(["a/1"]);
  });
});

describe("refreshDue", () => {
  const week = REFRESH_INTERVAL_MS;
  const now = 10 * week;

  test("runs on the first pass", () => {
    expect(refreshDue(undefined, now, "18.11.3")).toBe(true);
  });

  test("waits a week after a good run", () => {
    const state = { at: now - week + 60_000, attemptedAt: now - week + 60_000, omp: "18.11.3" };
    expect(refreshDue(state, now, "18.11.3")).toBe(false);
    expect(refreshDue({ ...state, at: now - week - 1 }, now, "18.11.3")).toBe(true);
  });

  test("runs at once when the installed OMP changed", () => {
    const state = { at: now - 1000, attemptedAt: now - 1000, omp: "18.2.3" };
    expect(refreshDue(state, now, "18.11.3")).toBe(true);
  });

  test("runs on demand", () => {
    expect(refreshDue({ at: now, attemptedAt: now, omp: "18.11.3" }, now, "18.11.3", true)).toBe(true);
  });

  test("waits an hour after a failed try", () => {
    const state = { at: now - week - 1, attemptedAt: now - 60_000, omp: "18.11.3" };
    expect(refreshDue(state, now, "18.11.3")).toBe(false);
    expect(refreshDue({ ...state, attemptedAt: now - RETRY_INTERVAL_MS - 1 }, now, "18.11.3")).toBe(true);
  });
});

describe("omp output parsing", () => {
  test("reads a pending update", () => {
    expect(parseUpdateCheck("Current version: 18.2.3\nNew version available: 18.11.3")).toEqual({ current: "18.2.3", latest: "18.11.3" });
  });

  test("reports no new version when current", () => {
    expect(parseUpdateCheck("Current version: 18.11.3\n✔ Already up to date")).toEqual({ current: "18.11.3", latest: undefined });
  });

  test("reads the version from omp --version", () => {
    expect(parseOmpVersion("omp/18.11.3\n")).toBe("18.11.3");
    expect(parseOmpVersion("nothing here")).toBeUndefined();
  });
});

describe("pinnedOmp", () => {
  test("returns the pin when both packages agree", () => {
    const pins = { "@oh-my-pi/pi-coding-agent": "18.11.3", "@oh-my-pi/pi-tui": "18.11.3" };
    expect(pinnedOmp({ dependencies: pins })).toBe("18.11.3");
  });

  test("returns undefined when they disagree or are missing", () => {
    expect(pinnedOmp({ dependencies: { "@oh-my-pi/pi-coding-agent": "18.11.3", "@oh-my-pi/pi-tui": "18.0.4" } })).toBeUndefined();
    expect(pinnedOmp({})).toBeUndefined();
  });
});
