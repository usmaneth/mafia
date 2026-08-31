import { describe, expect, test } from "bun:test";
import { formatDoctor } from "../src/doctor";
import type { Check } from "../src/doctor";

const check = (state: Check["state"], name = "thing", fix?: string): Check =>
  ({ name, state, detail: "detail", fix });

describe("doctor reporting", () => {
  test("every failing check names a fix", () => {
    // A health check that reports a problem without saying what to do about it
    // is a slower way of reading a log.
    const value = formatDoctor([check("fail", "disk", "mafia gc")]);
    expect(value).toContain("FAIL");
    expect(value).toContain("-> mafia gc");
  });

  test("summarises failures and warnings separately", () => {
    const value = formatDoctor([check("fail", "a", "x"), check("warn", "b", "y"), check("ok", "c")]);
    expect(value).toContain("1 failing, 1 warning");
  });

  test("says so plainly when nothing is wrong", () => {
    expect(formatDoctor([check("ok"), check("ok")])).toContain("everything healthy");
  });

  test("a healthy check prints no fix line", () => {
    expect(formatDoctor([check("ok")])).not.toContain("->");
  });

  test("counts only warnings when there are no failures", () => {
    expect(formatDoctor([check("warn", "a", "x"), check("ok")])).toContain("1 warning");
  });
});

import { formatSubagents } from "../src/format";
import { summariseToolCall } from "../hooks/subagent-activity";

const now = Date.UTC(2026, 7, 31, 22, 0, 0);
const agent = (over: Partial<Parameters<typeof formatSubagents>[0][number]> = {}) => ({
  id: "1", name: "Scout", model: "grok-4.6", cwd: "/r", state: "working",
  tool: "bash", detail: "rg trackEvent", toolCount: 3,
  startedAt: new Date(now - 60_000).toISOString(),
  updatedAt: new Date(now - 1_000).toISOString(),
  ...over,
});

describe("subagent view", () => {
  test("shows the model, which the built-in panel omits", () => {
    // Two subagents listed identically can be running different models at very
    // different cost. That is the gap this view exists to close.
    expect(formatSubagents([agent()], now)).toContain("grok-4.6");
  });

  test("shows what the subagent is currently doing", () => {
    expect(formatSubagents([agent()], now)).toContain("bash: rg trackEvent");
  });

  test("calls a subagent stalled when its last update is old", () => {
    // A subagent that stopped reporting still claims to be working. Elapsed
    // time alone cannot separate a busy agent from a wedged one.
    const value = formatSubagents([agent({ updatedAt: new Date(now - 200_000).toISOString() })], now);
    expect(value).toContain("stalled");
  });

  test("keeps a finished subagent visible for a few minutes", () => {
    expect(formatSubagents([agent({ state: "done" })], now)).toContain("Scout");
  });

  test("drops a subagent that finished long ago", () => {
    const old = agent({ state: "done", updatedAt: new Date(now - 30 * 60_000).toISOString() });
    expect(formatSubagents([old], now)).toContain("no OMP subagents");
  });
});

describe("tool call summaries", () => {
  test("shows the command for bash", () => {
    expect(summariseToolCall("bash", { command: "rg -n trackEvent src/" })).toBe("rg -n trackEvent src/");
  });

  test("shortens a long path to its file name", () => {
    // The tail of a path identifies the file; the head is shared noise.
    expect(summariseToolCall("read", { path: "/very/long/prefix/that/keeps/going/and/going/deeper/still/telemetry.ts" }))
      .toBe(".../telemetry.ts");
  });

  test("truncates a long command from the front", () => {
    expect(summariseToolCall("bash", { command: "x".repeat(200) }).length).toBeLessThanOrEqual(64);
  });

  test("falls back to the tool name when nothing is recognisable", () => {
    expect(summariseToolCall("mystery", {})).toBe("mystery");
  });

  test("collapses newlines so a multi-line command stays on one row", () => {
    expect(summariseToolCall("bash", { command: "a\n  b\n  c" })).toBe("a b c");
  });
});
