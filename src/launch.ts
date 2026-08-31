import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localOllamaArgs } from "./harnesses";

function selectedModel(extra: string[]): string | undefined {
  const modelIndex = extra.indexOf("--model");
  if (modelIndex >= 0) return extra[modelIndex + 1];
  const inlineModel = extra.find((value) => value.startsWith("--model="));
  if (inlineModel) return inlineModel.slice("--model=".length);
  try {
    const profile = Bun.YAML.parse(
      readFileSync(join(homedir(), ".omp", "profiles", "mafia", "agent", "config.yml"), "utf8"),
    ) as { modelRoles?: { default?: string } };
    return profile.modelRoles?.default;
  } catch {
    return undefined;
  }
}

export function buildOmpArgs(extra: string[]): string[] {
  const model = selectedModel(extra);
  return [
    "--profile",
    "mafia",
    "--allow-home",
    "--approval-mode",
    "yolo",
    "--auto-approve",
    ...localOllamaArgs(model, "lead"),
    "--append-system-prompt",
    join(homedir(), "mafia", "rules", "MAFIA.md"),
    ...extra,
  ];
}
