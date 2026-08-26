import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessName, ModelCatalog } from "./types";

function readJson(path: string): any | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function cleanClaudeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/\[[^\]]+\]$/, "").trim() || undefined;
}

function catalogDefault(harness: HarnessName, catalog?: ModelCatalog): string | undefined {
  const models = catalog?.models.filter((model) => model.harness === harness && model.available) ?? [];
  const preferred = harness === "kimi"
    ? models.find((model) => /(^|\/)k3$/.test(model.selector))
    : harness === "cline"
      ? models.find((model) => /kimi-k3$/.test(model.selector))
      : undefined;
  return preferred?.selector ?? (models.length === 1 ? models[0].selector : undefined);
}

export function detectHarnessModel(
  harness: HarnessName,
  options: { home?: string; catalog?: ModelCatalog } = {},
): string | undefined {
  const home = options.home ?? homedir();
  try {
    if (harness === "codex") {
      const path = join(home, ".codex", "config.toml");
      if (existsSync(path)) {
        const config = Bun.TOML.parse(readFileSync(path, "utf8")) as { model?: unknown };
        if (typeof config.model === "string" && config.model.trim()) return config.model.trim();
      }
    }
    if (harness === "claude") {
      return cleanClaudeModel(readJson(join(home, ".claude", "settings.json"))?.model);
    }
    if (harness === "cline") {
      const providers = readJson(join(home, ".cline", "data", "settings", "providers.json"))?.providers;
      const model = providers?.cline?.settings?.model ?? providers?.["cline-pass"]?.settings?.model;
      if (typeof model === "string" && model.trim()) return model.trim();
    }
    if (harness === "omp") {
      const path = join(home, ".omp", "profiles", "mafia", "agent", "config.yml");
      if (existsSync(path)) {
        const config = Bun.YAML.parse(readFileSync(path, "utf8")) as { modelRoles?: { default?: unknown } };
        const model = config.modelRoles?.default;
        if (typeof model === "string" && model.trim()) return model.trim();
      }
    }
  } catch {}
  return catalogDefault(harness, options.catalog);
}
