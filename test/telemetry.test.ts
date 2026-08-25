import { describe, expect, test } from "bun:test";
import { formatVpsTelemetry } from "../src/format";
import type { VpsTelemetry } from "../src/types";

const telemetry: VpsTelemetry = {
  generatedAt: new Date().toISOString(),
  host: "vps-test",
  reachable: true,
  latencyMs: 42,
  load: [1, 0.5, 0.25],
  memory: { usedBytes: 4_000_000_000, totalBytes: 8_000_000_000, swapUsedBytes: 0, swapTotalBytes: 1_000_000_000 },
  disk: { usedBytes: 70, totalBytes: 100, percent: 70 },
  jobs: {
    total: 8,
    running: 3,
    failed: 1,
    lost: 0,
    byHarness: { codex: 2, claude: 1 },
    recent: [{
      id: "job-1",
      title: "Implement API",
      state: "running",
      harness: "codex",
      model: "gpt-5.5",
      updatedAt: new Date().toISOString(),
    }],
  },
  models: {
    total: 800,
    sources: [{ harness: "omp", status: "ok", count: 500 }],
    fallbackOrder: ["codex", "claude", "omp"],
  },
  units: [{ name: "mafia-update.timer", active: "active", sub: "waiting", description: "" }],
  timers: [{ name: "mafia-update.timer", next: "soon" }],
  processes: [{
    pid: 10,
    user: "usman",
    state: "S",
    ageSeconds: 30,
    cpuPercent: 1.5,
    memoryPercent: 2,
    command: "codex exec task",
  }],
};

describe("VPS telemetry", () => {
  test("formats the operational summary and relevant processes", () => {
    const value = formatVpsTelemetry(telemetry);
    expect(value).toContain("VPS vps-test - online 42ms");
    expect(value).toContain("workers 3 active / 1 failed");
    expect(value).toContain("fallback codex > claude > omp");
    expect(value).toContain("claude:unknown");
    expect(value).toContain("running   codex/gpt-5.5 Implement API");
    expect(value).toContain("codex exec task");
  });

  test("formats an unreachable VPS", () => {
    expect(formatVpsTelemetry({ ...telemetry, reachable: false, error: "timeout" })).toContain("offline - timeout");
  });
});
