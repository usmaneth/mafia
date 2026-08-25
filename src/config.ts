import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { defaultCandidates } from "./router";
import type { MafiaConfig } from "./types";

export const repoRoot = dirname(import.meta.dir);

function expandHome(value: string): string {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export function configPath(): string {
  return process.env.MAFIA_CONFIG ?? join(homedir(), ".config", "mafia", "config.json");
}

export function defaultConfig(): MafiaConfig {
  return {
    version: 3,
    defaultHost: "vps",
    defaultHarness: "codex",
    stateRoot: join(homedir(), ".local", "share", "mafia"),
    vaultRoot: join(homedir(), "vault"),
    harnessModels: {
      opencode: "opencode/nemotron-3-ultra-free",
    },
    routing: {
      candidates: defaultCandidates(),
      fallbackOrder: ["codex", "claude", "omp", "opencode", "kimi", "cline"],
    },
    defaultBudget: {
      maxCostUsd: 50,
      maxTokens: 10_000_000,
      maxWorkers: 128,
      maxRuntimeSeconds: 14_400,
      warningPercent: 70,
      downgradeAtPercent: 85,
      stopAtPercent: 100,
      minExpectedValue: 0.2,
    },
    hosts: {
      local: {
        name: "local",
        kind: "local",
        stateRoot: join(homedir(), ".local", "share", "mafia"),
        maxParallel: 64,
      },
      vps: {
        name: "vps",
        kind: "ssh",
        target: "root@15.204.120.156",
        stateRoot: "/home/usman/.local/share/mafia",
        workerPath: "/opt/mafia/worker.mjs",
        defaultUser: "usman",
        maxParallel: 64,
      },
    },
  };
}

export function ensureConfig(): MafiaConfig {
  const path = configPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { mode: 0o600 });
  }
  return loadConfig();
}

export function loadConfig(): MafiaConfig {
  const defaults = defaultConfig();
  const input = JSON.parse(readFileSync(configPath(), "utf8")) as MafiaConfig;
  const raw: MafiaConfig = {
    ...defaults,
    ...input,
    harnessModels: { ...defaults.harnessModels, ...input.harnessModels },
    routing: input.routing ?? defaults.routing,
    defaultBudget: { ...defaults.defaultBudget, ...input.defaultBudget },
    hosts: Object.fromEntries(Object.entries(input.hosts).map(([name, host]) => [
      name,
      { ...defaults.hosts[name], ...host },
    ])),
  };
  raw.stateRoot = expandHome(raw.stateRoot);
  if (raw.vaultRoot) raw.vaultRoot = expandHome(raw.vaultRoot);
  for (const host of Object.values(raw.hosts)) {
    host.stateRoot = expandHome(host.stateRoot);
  }
  return raw;
}

export function resolveHost(config: MafiaConfig, name?: string) {
  const hostName = name ?? config.defaultHost;
  const host = config.hosts[hostName];
  if (!host) throw new Error(`Unknown host: ${hostName}`);
  if (host.kind === "ssh" && !host.target) throw new Error(`Host ${hostName} has no SSH target.`);
  return host;
}
