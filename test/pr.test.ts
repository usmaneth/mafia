import { describe, expect, test } from "bun:test";
import { formatPrDashboard, formatPrWidget } from "../src/format";
import { classifyPr } from "../src/pr";
import type { PrTelemetry } from "../src/types";

const base = {
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  checks: "SUCCESS",
  unresolvedThreads: 0,
  sweeps: 0,
  autoMerge: false,
};

const telemetry: PrTelemetry = {
  generatedAt: new Date().toISOString(),
  reachable: true,
  latencyMs: 30,
  totals: {
    open: 2,
    "needs-you": 0,
    fixing: 1,
    conflict: 0,
    "ci-failing": 0,
    "ci-pending": 0,
    ready: 1,
    queued: 0,
    "awaiting-review": 0,
    watching: 0,
  },
  units: [{
    name: "pr-shepherd.timer",
    active: "active",
    sub: "waiting",
    result: "success",
  }],
  prs: [{
    repo: "zeta-chain/ai-portal",
    number: 1701,
    title: "Fix referral alert",
    url: "https://example.test/pr/1701",
    updatedAt: new Date().toISOString(),
    headSha: "abc123",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    checks: "SUCCESS",
    unresolvedThreads: 0,
    botThreads: 0,
    sweeps: 1,
    autoMerge: false,
    state: "ready",
  }, {
    repo: "zeta-chain/ai-memoryless-client",
    number: 6389,
    title: "Fix nearby prompt",
    url: "https://example.test/pr/6389",
    updatedAt: new Date().toISOString(),
    headSha: "def456",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "CHANGES_REQUESTED",
    checks: "SUCCESS",
    unresolvedThreads: 2,
    botThreads: 1,
    sweeps: 3,
    autoMerge: false,
    state: "fixing",
  }],
};

describe("PR automation", () => {
  test("classifies work by the first blocking gate", () => {
    expect(classifyPr(base)).toBe("ready");
    expect(classifyPr({ ...base, autoMerge: true })).toBe("queued");
    expect(classifyPr({ ...base, checks: "FAILURE" })).toBe("ci-failing");
    expect(classifyPr({ ...base, unresolvedThreads: 2 })).toBe("fixing");
    expect(classifyPr({ ...base, unresolvedThreads: 1, sweeps: 8 })).toBe("needs-you");
    expect(classifyPr({ ...base, mergeable: "CONFLICTING" })).toBe("conflict");
  });

  test("formats the full PR desk and filtered views", () => {
    const all = formatPrDashboard(telemetry);
    expect(all).toContain("MAFIA PR DESK");
    expect(all).toContain("Ready 1");
    expect(all).toContain("ai-portal#1701");
    expect(formatPrDashboard(telemetry, "fixing")).not.toContain("ai-portal#1701");
    expect(formatPrWidget(telemetry)).toContain("2 open");
  });
});
