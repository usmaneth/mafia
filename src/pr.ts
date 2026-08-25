import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, repoRoot, resolveHost } from "./config";
import { shellQuote } from "./process";
import type { PrOperationalState, PrTelemetry } from "./types";

export interface PrFacts {
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  checks: string;
  unresolvedThreads: number;
  sweeps: number;
  autoMerge: boolean;
  shepherdStatus?: string;
}

export function classifyPr(value: PrFacts): PrOperationalState {
  if (value.mergeable === "CONFLICTING") return "conflict";
  if (value.unresolvedThreads > 0 && value.sweeps >= 8) return "needs-you";
  if (value.unresolvedThreads > 0) return "fixing";
  if (value.checks === "FAILURE" || value.checks === "ERROR") return "ci-failing";
  if (value.autoMerge || value.shepherdStatus === "queued") return "queued";
  if (value.reviewDecision === "APPROVED" && ["SUCCESS", "NONE"].includes(value.checks)) return "ready";
  if (value.reviewDecision === "APPROVED" && ["PENDING", "EXPECTED"].includes(value.checks)) return "ci-pending";
  if (value.reviewDecision !== "APPROVED") return "awaiting-review";
  return "watching";
}

export function prTelemetryPath(stateRoot = loadConfig().stateRoot): string {
  return join(stateRoot, "telemetry", "prs.json");
}

export function readPrTelemetry(stateRoot = loadConfig().stateRoot): PrTelemetry | undefined {
  try {
    return JSON.parse(readFileSync(prTelemetryPath(stateRoot), "utf8")) as PrTelemetry;
  } catch {
    return undefined;
  }
}

export function refreshPrTelemetry(force = false): PrTelemetry {
  const config = loadConfig();
  const path = prTelemetryPath(config.stateRoot);
  const cached = readPrTelemetry(config.stateRoot);
  if (!force && cached && Date.now() - new Date(cached.generatedAt).getTime() < 20_000) return cached;
  const host = resolveHost(config, "vps");
  if (!host.target) throw new Error("The VPS target is not configured.");
  const started = performance.now();
  const remote = "/home/usman/mafia/src/pr-probe.ts";
  const command = `sudo -iu ${shellQuote(host.defaultUser ?? "usman")} bash -lc ` +
    shellQuote(`/home/usman/.bun/bin/bun ${remote}`);
  const result = spawnSync("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.target, command,
  ], { encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
  let value: PrTelemetry;
  if (result.status === 0) {
    value = JSON.parse(result.stdout) as PrTelemetry;
    value.latencyMs = Math.round(performance.now() - started);
  } else {
    value = {
      generatedAt: new Date().toISOString(),
      reachable: false,
      latencyMs: Math.round(performance.now() - started),
      error: (result.stderr || `SSH exited ${result.status}`).trim(),
      totals: {
        open: 0,
        "needs-you": 0,
        fixing: 0,
        conflict: 0,
        "ci-failing": 0,
        "ci-pending": 0,
        ready: 0,
        queued: 0,
        "awaiting-review": 0,
        watching: 0,
      },
      units: [],
      prs: [],
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
  return value;
}

export type PrAutomationAction = "shepherd" | "merge";

export function runPrAutomation(action: PrAutomationAction): void {
  const host = resolveHost(loadConfig(), "vps");
  if (!host.target) throw new Error("The VPS target is not configured.");
  const unit = action === "shepherd" ? "pr-shepherd.service" : "pr-automerge.service";
  const result = spawnSync("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.target,
    `systemctl start ${unit}`,
  ], { cwd: repoRoot, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Cannot start ${unit}.`).trim());
  }
}

export function installPrAutomation(): void {
  const host = resolveHost(loadConfig(), "vps");
  if (!host.target) throw new Error("The VPS target is not configured.");
  const files = [
    "pr-automerge.py",
    "pr-automerge.service",
    "pr-automerge.timer",
    "pr-shepherd.service",
    "pr-shepherd.timer",
  ];
  for (const file of files) {
    const result = spawnSync("scp", [
      join(repoRoot, "deploy", file),
      `${host.target}:/tmp/${file}`,
    ], { encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) throw new Error((result.stderr || `Cannot upload ${file}.`).trim());
  }
  const install = [
    "install -m 0755 /tmp/pr-automerge.py /home/usman/pr-watch/automerge.py",
    "install -m 0644 /tmp/pr-automerge.service /etc/systemd/system/pr-automerge.service",
    "install -m 0644 /tmp/pr-automerge.timer /etc/systemd/system/pr-automerge.timer",
    "install -m 0644 /tmp/pr-shepherd.service /etc/systemd/system/pr-shepherd.service",
    "install -m 0644 /tmp/pr-shepherd.timer /etc/systemd/system/pr-shepherd.timer",
    "sed -i 's/^ALLOW_AUTOMERGE=.*/ALLOW_AUTOMERGE=0/' /home/usman/.hermes/scripts/pr-shepherd.sh",
    "systemctl daemon-reload",
    "(systemctl disable --now pr-automerge.service || true)",
    "python3 -c 'import json; p=\"/home/usman/.hermes/cron/jobs.json\"; d=json.load(open(p)); [j.update(enabled=False) for j in d.get(\"jobs\",[]) if j.get(\"name\")==\"pr-shepherd\"]; json.dump(d,open(p,\"w\"),indent=2)'",
    "systemctl enable --now pr-automerge.timer pr-shepherd.timer",
  ].join(" && ");
  const result = spawnSync("ssh", [host.target, install], { encoding: "utf8", timeout: 45_000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "Cannot install PR automation.").trim());
}
