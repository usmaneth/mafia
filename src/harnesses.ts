import type { HarnessName, JobSpec } from "./types";

export interface HarnessCommand {
  command: string;
  args: string[];
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
          "--no-session",
          "--no-extensions",
          ...(model ? ["--model", model] : []),
          spec.prompt,
        ],
      };
  }
}

export function isHarnessName(value: string): value is HarnessName {
  return ["claude", "codex", "kimi", "cline", "opencode", "omp"].includes(value);
}
