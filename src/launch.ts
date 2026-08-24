import { homedir } from "node:os";
import { join } from "node:path";

export function buildOmpArgs(extra: string[]): string[] {
  return [
    "--profile",
    "mafia",
    "--allow-home",
    "--approval-mode",
    "yolo",
    "--auto-approve",
    "--append-system-prompt",
    join(homedir(), "mafia", "rules", "MAFIA.md"),
    ...extra,
  ];
}
