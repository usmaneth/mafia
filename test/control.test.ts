import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { budgetState } from "../src/budget";
import { ControlPlane } from "../src/control";
import { buildHandoffPacket } from "../src/packet";
import { protocolSpec } from "../src/protocols";
import { routeTask } from "../src/router";
import type { JobStatus, MafiaConfig, TeamStatus } from "../src/types";

const roots: string[] = [];

function tempRoot(): string {
  const root = join(tmpdir(), `mafia-control-test-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Mafia control plane", () => {
  test("delivers direct and broadcast messages with an audit log", () => {
    const root = tempRoot();
    const control = new ControlPlane(root);
    const teamDir = join(root, "teams", "team-test");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "status.json"), JSON.stringify({
      tasks: [{ jobId: "job-a" }, { jobId: "job-b" }],
    }));

    const direct = control.send({
      teamId: "team-test",
      from: "lead",
      to: "job-a",
      type: "blocker",
      body: "Stop and inspect the schema.",
    });
    expect(control.deliverLocal(direct)).toBe(1);
    expect(readFileSync(join(root, "jobs", "job-a", "inbox.jsonl"), "utf8")).toContain("schema");

    const broadcast = control.send({
      teamId: "team-test",
      from: "job-a",
      type: "finding",
      body: "The schema uses events.",
    });
    expect(control.deliverLocal(broadcast)).toBe(1);
    expect(readFileSync(join(root, "jobs", "job-b", "inbox.jsonl"), "utf8")).toContain("uses events");
    expect(control.store.listEvents({ teamId: "team-test" }).length).toBe(2);
  });

  test("leaves remote recipients pending for the service router", () => {
    const root = tempRoot();
    const control = new ControlPlane(root);
    const teamDir = join(root, "teams", "team-remote");
    const jobDir = join(root, "jobs", "job-remote");
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(teamDir, "status.json"), JSON.stringify({ tasks: [{ jobId: "job-remote" }] }));
    writeFileSync(join(jobDir, "spec.json"), JSON.stringify({ host: "vps" }));

    const message = control.send({
      teamId: "team-remote",
      from: "job-local",
      to: "job-remote",
      body: "Cross-host message.",
    });
    expect(control.deliverLocal(message)).toBe(0);
    expect(control.store.listUndeliveredMessages().map((value) => value.id)).toContain(message.id);
  });

  test("stores decisions and checkpoints", () => {
    const root = tempRoot();
    const control = new ControlPlane(root);
    const decision = control.decision({
      teamId: "team-test",
      question: "Storage model?",
      recommendation: "Event log",
      alternatives: ["Mutable rows"],
      selected: "Event log",
      selectedBy: "Usman",
      affectedTasks: ["storage"],
    });
    expect(control.decisions("team-test")[0].id).toBe(decision.id);
  });
});

describe("routing and budget", () => {
  test("routes implementation work and downgrades on a budget warning", () => {
    const config = {
      version: 2,
      defaultHost: "local",
      defaultHarness: "codex",
      stateRoot: tempRoot(),
      hosts: { local: { name: "local", kind: "local", stateRoot: tempRoot() } },
    } satisfies MafiaConfig;
    expect(routeTask(config, { capability: "implementation" }).harness).toBe("codex");
    expect(routeTask(config, { capability: "implementation", downgrade: true }).model)
      .toBe("ollama/qwen3.8-27b-obliterated:q3_k_m");
    expect(routeTask(config, { capability: "research", downgrade: true }).model).toContain("nemotron");
  });

  test("stops a team at its hard budget", () => {
    const team = {
      id: "team-test",
      name: "test",
      goal: "test",
      state: "running",
      maxParallel: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
      budget: { maxCostUsd: 10, warningPercent: 70, downgradeAtPercent: 85, stopAtPercent: 100 },
    } satisfies TeamStatus;
    const state = budgetState(team, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 10,
      requests: 1,
      failures: 0,
      runtimeSeconds: 1,
    });
    expect(state.stop).toBe(true);
  });
});

describe("protocols and packets", () => {
  test("creates adversarial protocols with dependencies", () => {
    const spec = protocolSpec("builder-reviewer", "Build it.");
    expect(spec.tasks.map((task) => task.id)).toEqual(["builder", "reviewer", "final"]);
    expect(spec.tasks[1].dependsOn).toEqual(["builder"]);
  });

  test("compresses worker output into a packet", () => {
    const job = {
      id: "job-test",
      title: "test",
      prompt: "test",
      harness: "codex",
      host: "local",
      isolate: false,
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stateRoot: tempRoot(),
      timeoutSeconds: 30,
      state: "succeeded",
      logPath: "/tmp/output.log",
      result: "# Outcome\nDone.\n\n## Tests\n- bun test\n\n## Risks\n- none",
    } satisfies JobStatus;
    const packet = buildHandoffPacket(job);
    expect(packet.tests).toEqual(["bun test"]);
    expect(packet.unresolvedRisks).toEqual(["none"]);
  });
});
