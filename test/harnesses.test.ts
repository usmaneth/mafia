import { describe, expect, test } from "bun:test";
import { commandFor } from "../src/harnesses";
import type { JobSpec } from "../src/types";

function ompSpec(model: string): JobSpec {
  return {
    id: "job-test",
    title: "test",
    prompt: "Reply with OK.",
    harness: "omp",
    host: "local",
    repo: "/tmp/repo",
    cwd: "/tmp/repo",
    model,
    baseRef: "HEAD",
    isolate: false,
    labels: [],
    createdAt: "2026-08-24T00:00:00.000Z",
    stateRoot: "/tmp/mafia",
    timeoutSeconds: 60,
  };
}

describe("OMP harness command", () => {
  test("uses the direct local agent for local Ollama models", () => {
    const { command, args } = commandFor(
      ompSpec("ollama/qwen3.8-27b-obliterated:q4_k_m"),
      "/tmp/repo",
    );

    expect(command).toBe("node");
    expect(args.join(" ")).toContain("scripts/ollama-agent.mjs");
    expect(args[args.indexOf("--model") + 1]).toBe("ollama/qwen3.8-27b-obliterated:q4_k_m");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/tmp/repo");
  });

  test("keeps the full OMP profile for remote models", () => {
    const { args } = commandFor(
      ompSpec("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"),
      "/tmp/repo",
    );

    expect(args).not.toContain("--no-skills");
    expect(args).not.toContain("--no-rules");
    expect(args).not.toContain("--no-lsp");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--system-prompt");
  });
});
