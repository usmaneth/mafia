import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { NativeAgentBridge, visibleAgentJobs } from "../extension/native-agent-bridge";
import type { JobStatus } from "../src/types";

function job(overrides: Partial<JobStatus> = {}): JobStatus {
  const now = new Date().toISOString();
  return {
    id: "job-test-a10599",
    title: "Review the transport",
    prompt: "Review it",
    harness: "codex",
    host: "vps",
    model: "gpt-5.6-luna-pro",
    isolate: true,
    labels: [],
    createdAt: now,
    stateRoot: "/tmp/mafia",
    timeoutSeconds: 60,
    state: "running",
    updatedAt: now,
    heartbeatAt: now,
    logPath: "/tmp/mafia/output.log",
    ...overrides,
  };
}

describe("native agent bridge", () => {
  test("mirrors Mafia work into the OMP Agent Hub registry", () => {
    const registry = new AgentRegistry();
    const mafia = {
      listCached: () => [job()],
      cancel: () => {},
    };
    const bridge = new NativeAgentBridge(registry, mafia);

    bridge.sync();

    const [ref] = bridge.refs();
    expect(ref.id).toBe("Codex - GPT-5.6 Luna Pro · a10599");
    expect(ref.displayName).toBe("VPS - Review the transport");
    expect(ref.status).toBe("running");
    expect(ref.history?.resolvedModel).toBe("gpt-5.6-luna-pro");
    expect(ref.history?.outputPath).toBe("/tmp/mafia/output.log");
  });

  test("keeps all active workers and only recent completed workers", () => {
    const now = Date.now();
    const jobs = [
      job({ id: "active", updatedAt: new Date(now - 60 * 60_000).toISOString() }),
      job({ id: "recent", state: "succeeded", updatedAt: new Date(now - 10_000).toISOString() }),
      job({ id: "old", state: "succeeded", updatedAt: new Date(now - 60 * 60_000).toISOString() }),
    ];

    expect(visibleAgentJobs(jobs, now).map((item) => item.id)).toEqual(["active", "recent"]);
  });

  test("maps a native kill to the real Mafia worker", () => {
    const registry = new AgentRegistry();
    const active = job();
    const cancelled: string[] = [];
    const mafia = {
      listCached: () => [active],
      cancel: (id: string) => cancelled.push(id),
    };
    const bridge = new NativeAgentBridge(registry, mafia);
    bridge.sync();
    const [ref] = bridge.refs();

    registry.setStatus(ref.id, "aborted", ref);

    expect(cancelled).toEqual([active.id]);
  });
});
