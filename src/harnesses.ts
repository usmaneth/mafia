import type { HarnessName, JobSpec } from "./types";
import { homedir } from "node:os";
import { roleArgs } from "./roles";
import { join } from "node:path";

export interface HarnessCommand {
  command: string;
  args: string[];
}

export function localOllamaArgs(model: string | undefined, role: "lead" | "worker"): string[] {
  if (!model?.startsWith("ollama/")) return [];
  const prompt = role === "lead"
    ? "You are the Mafia lead. Complete the user task. Use bash for repository work and the mafia CLI for teams, workers, routing, status, logs, and control. Return concise results with verification."
    : "You are a Mafia coding worker. Complete the task in the current repository. Use bash to inspect, edit, and test files. Return a concise result with changed files and verification.";
  return [
    "--system-prompt",
    prompt,
    "--no-skills",
    "--no-rules",
    "--no-lsp",
    "--tools",
    "bash",
    "--thinking",
    "off",
  ];
}

export function commandFor(spec: JobSpec, cwd: string): HarnessCommand {
  const model = spec.model;
  switch (spec.harness) {
    case "claude":
      return {
        command: "claude",
        args: [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          "--permission-mode",
          "bypassPermissions",
          "--effort",
          "high",
          "--no-session-persistence",
          ...(model ? ["--model", model] : []),
          spec.prompt,
        ],
      };
    case "codex":
      return {
        command: "codex",
        args: [
          "exec",
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--dangerously-bypass-hook-trust",
          "--skip-git-repo-check",
          "-C",
          cwd,
          ...(model ? ["--model", model] : []),
          spec.prompt,
        ],
      };
    case "kimi":
      return {
        command: "kimi",
        args: [
          "--prompt",
          spec.prompt,
          "--output-format",
          "stream-json",
          ...(model ? ["--model", model] : []),
        ],
      };
    case "cline":
      return {
        command: "cline",
        args: [
          "--json",
          "--auto-approve",
          "true",
          "--thinking",
          "high",
          "--cwd",
          cwd,
          ...(model ? ["--model", model] : []),
          spec.prompt,
        ],
      };
    case "opencode":
      return {
        command: "opencode",
        args: [
          "run",
          "--format",
          "json",
          "--auto",
          "--dir",
          cwd,
          "--variant",
          "high",
          ...(model ? ["--model", model] : []),
          spec.prompt,
        ],
      };
    case "omp":
      if (model?.startsWith("ollama/")) {
        return {
          command: "node",
          args: [
            join(homedir(), "mafia", "scripts", "ollama-agent.mjs"),
            "--model",
            model,
            "--cwd",
            cwd,
            "--prompt",
            spec.prompt,
          ],
        };
      }
      return {
        command: "omp",
        args: [
          "--profile",
          "mafia",
          "-p",
          "--mode",
          "json",
          "--approval-mode",
          "yolo",
          "--cwd",
          cwd,
          ...(spec.session ? [] : ["--no-session"]),
          "--no-extensions",
          // OMP's own limit ends the session cleanly and still yields a result.
          // The worker's timer stays as the backstop.
          ...(spec.timeoutSeconds ? ["--max-time", String(Math.max(30, spec.timeoutSeconds - 15))] : []),
          // Pin OMP's own subagent roles to providers that can take work. The
          // outer model is not enough: OMP starts its own subagents.
          ...roleArgs(spec.roleModels),
          ...(spec.prewalk ? ["--prewalk"] : []),
          ...(spec.prewalkInto ? ["--prewalk-into", spec.prewalkInto] : []),
          ...(model ? ["--model", model] : []),
          spec.prompt,
        ],
      };
  }
}

export function isHarnessName(value: string): value is HarnessName {
  return ["claude", "codex", "kimi", "cline", "opencode", "omp"].includes(value);
}
