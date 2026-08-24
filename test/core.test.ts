import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobStore } from "../src/store";
import { extractHarnessResult } from "../src/result";
import type { JobStatus } from "../src/types";

const roots: string[] = [];

function tempRoot(): string {
  const root = join(tmpdir(), `mafia-test-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("extractHarnessResult", () => {
  test("extracts OMP and Codex final text", () => {
    const omp = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OMP_OK" }] } }),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n");
    expect(extractHarnessResult(omp)).toBe("OMP_OK");

    const codex = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "CODEX_OK" },
    });
    expect(extractHarnessResult(codex)).toBe("CODEX_OK");

    const cline = JSON.stringify({ type: "run_result", text: "CLINE_OK" });
    expect(extractHarnessResult(cline)).toBe("CLINE_OK");
  });
});

describe("JobStore", () => {
  test("stores and updates a job", () => {
    const root = tempRoot();
    const store = new JobStore(root);
    const job: JobStatus = {
      id: "job-test",
      title: "test",
      prompt: "do work",
      harness: "codex",
      host: "local",
      isolate: false,
      labels: [],
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      stateRoot: root,
      timeoutSeconds: 3600,
      state: "queued",
      logPath: join(root, "jobs", "job-test", "output.log"),
    };
    store.upsert(job);
    expect(store.get(job.id)?.state).toBe("queued");
    store.upsert({ ...job, state: "succeeded", exitCode: 0 });
    expect(store.get(job.id)?.state).toBe("succeeded");
  });

  test("imports a worker status file", () => {
    const root = tempRoot();
    const store = new JobStore(root);
    const jobDir = join(root, "jobs", "job-import");
    mkdirSync(jobDir, { recursive: true });
    const job = {
      id: "job-import",
      title: "import",
      prompt: "work",
      harness: "claude",
      host: "local",
      isolate: false,
      labels: [],
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:01:00.000Z",
      stateRoot: root,
      timeoutSeconds: 3600,
      state: "running",
      logPath: join(jobDir, "output.log"),
    };
    writeFileSync(join(jobDir, "status.json"), JSON.stringify(job));
    expect(store.importLocalStatus(job.id)?.state).toBe("running");
  });
});
