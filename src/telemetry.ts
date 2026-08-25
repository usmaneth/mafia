import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, repoRoot, resolveHost } from "./config";
import { shellQuote } from "./process";
import type { VpsTelemetry } from "./types";

export function telemetryPath(stateRoot = loadConfig().stateRoot): string {
  return join(stateRoot, "telemetry", "vps.json");
}

export function readVpsTelemetry(stateRoot = loadConfig().stateRoot): VpsTelemetry | undefined {
  try {
    return JSON.parse(readFileSync(telemetryPath(stateRoot), "utf8")) as VpsTelemetry;
  } catch {
    return undefined;
  }
}

export function refreshVpsTelemetry(force = false): VpsTelemetry {
  const config = loadConfig();
  const path = telemetryPath(config.stateRoot);
  const cached = readVpsTelemetry(config.stateRoot);
  if (!force && cached && Date.now() - new Date(cached.generatedAt).getTime() < 10_000) return cached;
  const host = resolveHost(config, "vps");
  if (!host.target) throw new Error("The VPS target is not configured.");
  const started = performance.now();
  const remote = "/home/usman/mafia/src/vps-probe.ts";
  const command = `sudo -iu ${shellQuote(host.defaultUser ?? "usman")} bash -lc ` +
    shellQuote(`/home/usman/.bun/bin/bun ${remote}`);
  const result = spawnSync("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.target, command,
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  let value: VpsTelemetry;
  if (result.status === 0) {
    value = JSON.parse(result.stdout) as VpsTelemetry;
    value.latencyMs = Math.round(performance.now() - started);
  } else {
    value = {
      generatedAt: new Date().toISOString(),
      host: host.name,
      reachable: false,
      latencyMs: Math.round(performance.now() - started),
      error: (result.stderr || `SSH exited ${result.status}`).trim(),
      jobs: { total: 0, running: 0, failed: 0, lost: 0, byHarness: {} },
      models: { total: 0, sources: [], fallbackOrder: config.routing?.fallbackOrder ?? [] },
      units: [],
      timers: [],
      processes: [],
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
  return value;
}
