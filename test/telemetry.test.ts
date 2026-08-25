import { describe, expect, test } from "bun:test";
import { formatAgentDashboard, formatAgentWidget, formatVpsDashboard, formatVpsTelemetry, formatVpsWidget } from "../src/format";
import type { VpsTelemetry } from "../src/types";

const telemetry: VpsTelemetry = {
  generatedAt: new Date().toISOString(),
  host: "vps-test",
  reachable: true,
  latencyMs: 42,
  load: [1, 0.5, 0.25],
  memory: { usedBytes: 4_000_000_000, totalBytes: 8_000_000_000, swapUsedBytes: 0, swapTotalBytes: 1_000_000_000 },
  disk: { usedBytes: 70, totalBytes: 100, percent: 70 },
  deployment: {
    repoPath: "/home/usman/mafia",
    branch: "master",
    sha: "abc123",
    originSha: "abc123",
    dirty: false,
    dirtyFiles: 0,
  },
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
  units: [{
    name: "mafia-update.timer",
    active: "active",
    sub: "waiting",
    description: "Refresh Mafia",
    result: "success",
    execStatus: 0,
  }],
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
  test("formats one compact worker line and a detailed hub", () => {
    const jobs = telemetry.jobs.recent.map((job) => ({
      ...job,
      prompt: "work",
      host: "vps",
      isolate: true,
      labels: [],
      createdAt: job.updatedAt,
      stateRoot: "/tmp/mafia",
      timeoutSeconds: 60,
      logPath: "/tmp/output.log",
    }));
    expect(formatAgentWidget(jobs)).toContain("Agents 1 active | VPS 1");
    expect(formatAgentDashboard(jobs, "active")).toContain("Implement API");
  });

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

  test("formats one stable VPS health line", async () => {
    const widgetTelemetry = {
      ...telemetry,
      units: [
        ...telemetry.units,
        {
          name: "mafia-update.service",
          active: "inactive",
          sub: "dead",
          description: "Refresh Mafia",
          result: "success",
          execStatus: 0,
        },
      ],
    };
    const first = formatVpsWidget(widgetTelemetry);
    await Bun.sleep(20);
    const second = formatVpsWidget(widgetTelemetry);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(Math.max(...first.map((line) => line.length))).toBeLessThanOrEqual(80);
    expect(first[0]).toContain("VPS vps-test online 42ms");
    expect(first[0]).toContain("load 1.00 | mem 50% | disk 70%");
    expect(first[0]).not.toContain("route");
    expect(first[0]).not.toContain("watch");
  });

  test("formats the full operations dashboard", () => {
    const value = formatVpsDashboard(telemetry);

    expect(value).toContain("== DEPLOYMENT ==");
    expect(value).toContain("HEAD: abc123");
    expect(value).toContain("== MODEL ROUTING ==");
    expect(value).toContain("claude fallback is unavailable");
    expect(value).toContain("== WATCHERS AND SERVICES ==");
    expect(value).toContain("== PROCESSES - AGENT-RELATED ==");
  });

  test("alerts when a long-running watcher is inactive", () => {
    const value = formatVpsDashboard({
      ...telemetry,
      units: [{
        name: "vault-daemon.service",
        active: "inactive",
        sub: "dead",
        description: "Vault daemon",
      }],
    });

    expect(value).toContain("vault-daemon.service is inactive/dead");
  });
});
