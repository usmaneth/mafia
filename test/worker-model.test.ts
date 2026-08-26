import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JobSpec, JobStatus } from "../src/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker model telemetry", () => {
  test("shows the detected default without forcing it and records the served model", () => {
    const root = join(tmpdir(), `mafia-worker-model-${crypto.randomUUID()}`);
    const bin = join(root, "bin");
    const repo = join(root, "repo");
    const stateRoot = join(root, "state");
    const argsPath = join(root, "args.txt");
    roots.push(root);
    mkdirSync(bin, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const fakeCodex = join(bin, "codex");
    writeFileSync(
      fakeCodex,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ARGS_PATH\"\nprintf '%s\\n' '{\"model\":\"gpt-served\",\"item\":{\"type\":\"agent_message\",\"text\":\"MODEL_OK\"}}'\n",
    );
    chmodSync(fakeCodex, 0o755);

    const spec: JobSpec = {
      id: "job-worker-model",
      title: "model telemetry",
      prompt: "test",
      harness: "codex",
      host: "local",
      cwd: repo,
      model: "gpt-detected",
      modelSource: "detected",
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
      env: { ...process.env, ARGS_PATH: argsPath, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(argsPath, "utf8")).not.toContain("--model");
    const status = JSON.parse(readFileSync(join(jobDir, "status.json"), "utf8")) as JobStatus;
    expect(status.model).toBe("gpt-served");
    expect(status.modelSource).toBe("observed");
  });
});
