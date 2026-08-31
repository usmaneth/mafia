import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JobSpec, JobStatus } from "../src/types";

const roots: string[] = [];

function tempRoot(): string {
  const root = join(tmpdir(), `mafia-worker-test-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker", () => {
  test("uses an isolated worktree and extracts the final result", () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const stateRoot = join(root, "state");
    mkdirSync(repo);
    mkdirSync(bin);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "mafia-test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Mafia Test"], { cwd: repo });
    writeFileSync(join(repo, "source.txt"), "source\n");
    execFileSync("git", ["add", "source.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });

    const fakeCodex = join(bin, "codex");
    writeFileSync(
      fakeCodex,
      "#!/bin/sh\nprintf 'worker\\n' > worker-created.txt\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"FAKE_WORKER_OK\"}}'\n",
    );
    chmodSync(fakeCodex, 0o755);

    const spec: JobSpec = {
      id: "job-worker-test",
      title: "worker test",
      prompt: "test",
      harness: "codex",
      host: "local",
      repo,
      isolate: true,
      labels: [],
      createdAt: new Date().toISOString(),
      stateRoot,
      timeoutSeconds: 30,
    };
    const jobDir = join(stateRoot, "jobs", spec.id);
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));

    const result = spawnSync(process.execPath, [join(import.meta.dir, "..", "worker", "worker.mjs"), specPath], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);

    const status = JSON.parse(readFileSync(join(jobDir, "status.json"), "utf8")) as JobStatus;
    expect(status.state).toBe("succeeded");
    expect(status.result).toBe("FAKE_WORKER_OK");
    expect(status.worktree).not.toBe(repo);
    expect(readFileSync(join(status.worktree!, "worker-created.txt"), "utf8")).toBe("worker\n");
    expect(() => readFileSync(join(repo, "worker-created.txt"), "utf8")).toThrow();
  });

  test("uses the direct local agent for a local Ollama model", () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const stateRoot = join(root, "state");
    const capturePath = join(root, "node-args.txt");
    mkdirSync(repo);
    mkdirSync(bin);

    const fakeNode = join(bin, "node");
    writeFileSync(
      fakeNode,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_PATH\"\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"FAKE_OMP_OK\"}]}}'\n",
    );
    chmodSync(fakeNode, 0o755);

    const spec: JobSpec = {
      id: "job-worker-ollama-test",
      title: "worker Ollama test",
      prompt: "test",
      harness: "omp",
      host: "local",
      repo,
      model: "ollama/qwen3.8-27b-obliterated:q4_k_m",
      isolate: false,
      labels: [],
      createdAt: new Date().toISOString(),
      stateRoot,
      timeoutSeconds: 30,
    };
    const jobDir = join(stateRoot, "jobs", spec.id);
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));

    const result = spawnSync(process.execPath, [join(import.meta.dir, "..", "worker", "worker.mjs"), specPath], {
      env: {
        ...process.env,
        CAPTURE_PATH: capturePath,
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);

    const args = readFileSync(capturePath, "utf8").trim().split("\n");
    expect(args[0]).toContain("scripts/ollama-agent.mjs");
    expect(args[args.indexOf("--model") + 1]).toBe("ollama/qwen3.8-27b-obliterated:q4_k_m");
    expect(args[args.indexOf("--cwd") + 1]).toBe(repo);

    const status = JSON.parse(readFileSync(join(jobDir, "status.json"), "utf8")) as JobStatus;
    expect(status.state).toBe("succeeded");
    expect(status.result).toBe("FAKE_OMP_OK");
  });
});
