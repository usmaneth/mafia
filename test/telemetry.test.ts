import { describe, expect, test } from "bun:test";
import { agentDisplayName, modelDisplayName } from "../src/agent-display";
import {
  formatAgentDashboard,
  formatAgentDetail,
  formatAgentWidget,
  formatVpsDashboard,
  formatVpsTelemetry,
  formatVpsWidget,
} from "../src/format";
import type { JobStatus, VpsTelemetry } from "../src/types";

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
  test("shows harness and model as one subagent identity", () => {
    expect(agentDisplayName({ harness: "codex", model: "openai-codex/gpt-5.6-luna-pro:high" }))
      .toBe("Codex - GPT-5.6 Luna Pro");
    expect(agentDisplayName({ harness: "claude", model: "claude-opus-5" }))
      .toBe("Claude Code - Opus 5");
    expect(agentDisplayName({ harness: "kimi", model: "kimi-k3" }))
      .toBe("Kimi Code - K3");
    expect(agentDisplayName({ harness: "cline", model: "k3" }))
      .toBe("Cline - K3");
    expect(modelDisplayName("openrouter/nvidia/nemotron-3-ultra-free"))
      .toBe("Nemotron 3 Ultra");
  });

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
    expect(formatAgentWidget(jobs)).toBe("Agents 1 | Codex - GPT-5.5 @ VPS");
    expect(formatAgentDashboard(jobs, "active")).toContain("Implement API");
    expect(formatAgentDashboard(jobs, "active")).toContain("Codex - GPT-5.5");
    expect(formatAgentDashboard(jobs, "active", { selectedId: "job-1" })).toContain("> Codex - GPT-5.5");
  });

  test("keeps the basic UI compact for a large active team", () => {
    const now = new Date().toISOString();
    const jobs = [
      { harness: "codex", model: "gpt-5.6-sol", host: "vps" },
      { harness: "claude", model: "claude-opus-5", host: "local" },
      { harness: "kimi", model: "kimi-k3", host: "vps" },
    ] as const satisfies ReadonlyArray<Pick<JobStatus, "harness" | "model" | "host">>;
    const activeJobs: JobStatus[] = jobs.map((job, index) => ({
      ...job,
      id: `job-${index}`,
      title: `worker ${index}`,
      prompt: "work",
      isolate: false,
      labels: [],
      createdAt: now,
      updatedAt: now,
      stateRoot: "/tmp/mafia",
      timeoutSeconds: 60,
      state: "running" as const,
      logPath: `/tmp/job-${index}.log`,
    }));

    expect(formatAgentWidget(activeJobs))
      .toBe("Agents 3 | Codex - GPT-5.6 Sol @ VPS | Claude Code - Opus 5 @ local | +1");
  });

  test("formats the selected agent model and operational details", () => {
    const now = new Date().toISOString();
    const detail = formatAgentDetail({
      id: "job-detail",
      title: "Review the transport",
      prompt: "review",
      harness: "claude",
      host: "vps",
      model: "claude-opus-5",
      modelSource: "observed",
      isolate: true,
      labels: [],
      createdAt: now,
      updatedAt: now,
      stateRoot: "/tmp/mafia",
      timeoutSeconds: 60,
      state: "running",
      pid: 4512,
      branch: "mafia/job-detail",
      command: ["claude", "-p", "review"],
      logPath: "/tmp/mafia/output.log",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        costUsd: 0.12,
        requests: 1,
        failures: 0,
        runtimeSeconds: 5,
      },
    }, 'worker started\n{"type":"item.completed","item":{"type":"agent_message","text":"checking files"}}');

    expect(detail).toContain("Claude Code - Opus 5");
    expect(detail).toContain("Model source: observed");
    expect(detail).toContain("PID: 4512");
    expect(detail).toContain("Branch: mafia/job-detail");
    expect(detail).toContain("125 total");
    expect(detail).toContain("checking files");
    expect(detail).toContain("[prompt omitted]");
    expect(detail).not.toContain("claude -p review");
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
