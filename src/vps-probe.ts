#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { JobStatus, ModelCatalog, VpsProcess, VpsTelemetry, VpsTimer, VpsUnit } from "./types";

function command(name: string, args: string[]): string {
  const result = spawnSync(name, args, { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

function jobs(stateRoot: string): JobStatus[] {
  const root = join(stateRoot, "jobs");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((id) => {
    const path = join(root, id, "status.json");
    try {
      return [JSON.parse(readFileSync(path, "utf8")) as JobStatus];
    } catch {
      return [];
    }
  });
}

function units(): VpsUnit[] {
  const required = [
    "mafia-update.timer",
    "mafia-update.service",
    "provider-auth-monitor.timer",
    "provider-auth-monitor.service",
    "pr-watch.service",
    "pr-shepherd.timer",
    "pr-shepherd.service",
    "pr-automerge.timer",
    "pr-automerge.service",
    "vault-daemon.service",
    "herdr.service",
  ];
  const discovered = command("systemctl", ["list-unit-files", "--no-legend", "--no-pager"])
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((name) =>
      /^(mafia|provider-auth|pr-watch|vault|herdr|claude|codex|cline|kimi|opencode|omp)[-.].*\.(service|timer)$/i.test(name));
  const names = [...new Set([...required, ...discovered])];
  return names.map((name) => {
    const raw = command("systemctl", [
      "show",
      name,
      "--property=ActiveState,SubState,Description,Result,ExecMainStatus",
    ]);
    const fields = Object.fromEntries(raw.split("\n").map((line) => line.split("=", 2)));
    return {
      name,
      active: fields.ActiveState ?? "unknown",
      sub: fields.SubState ?? "unknown",
      description: fields.Description ?? "",
      result: fields.Result || undefined,
      execStatus: fields.ExecMainStatus ? Number(fields.ExecMainStatus) : undefined,
    };
  });
}

function timers(unitList: VpsUnit[]): VpsTimer[] {
  const names = unitList.filter((unit) => unit.name.endsWith(".timer")).map((unit) => unit.name);
  return names.map((name) => {
    const fieldsRaw = command("systemctl", ["show", name, "--property=LastTriggerUSec,Unit"]);
    const fields = Object.fromEntries(fieldsRaw.split("\n").map((line) => line.split("=", 2)));
    const row = command("systemctl", ["list-timers", "--all", "--no-legend", "--no-pager", name]).split(/\s+/);
    return {
      name,
      next: row.length >= 5 ? `${row[1]} ${row[2]} ${row[3]} (${row[4]})` : undefined,
      last: fields.LastTriggerUSec || undefined,
      activates: fields.Unit || undefined,
    };
  });
}

function processes(): VpsProcess[] {
  const raw = command("ps", ["-eo", "pid=,user=,stat=,etimes=,%cpu=,%mem=,args=", "--sort=-%cpu"]);
  return raw.split("\n").filter(Boolean).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      user: match[2],
      state: match[3],
      ageSeconds: Number(match[4]),
      cpuPercent: Number(match[5]),
      memoryPercent: Number(match[6]),
      command: match[7],
    }];
  });
}

function main(): void {
  const stateRoot = join(homedir(), ".local", "share", "mafia");
  const repoPath = "/home/usman/mafia";
  const allJobs = jobs(stateRoot);
  const byHarness: Record<string, number> = {};
  for (const job of allJobs.filter((item) => ["queued", "starting", "running"].includes(item.state))) {
    byHarness[job.harness] = (byHarness[job.harness] ?? 0) + 1;
  }
  let catalog: ModelCatalog | undefined;
  try {
    catalog = JSON.parse(readFileSync(join(stateRoot, "models", "catalog.json"), "utf8"));
  } catch {}
  const memory = readFileSync("/proc/meminfo", "utf8");
  const value = (key: string) => Number(memory.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
  const total = value("MemTotal");
  const available = value("MemAvailable");
  const swapTotal = value("SwapTotal");
  const swapFree = value("SwapFree");
  const diskRaw = command("df", ["-B1", "--output=size,used,pcent", "/"]).split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const load = readFileSync("/proc/loadavg", "utf8").split(/\s+/).slice(0, 3).map(Number) as [number, number, number];
  const uptimeSeconds = Number(readFileSync("/proc/uptime", "utf8").split(/\s+/)[0]);
  const unitList = units();
  const dirtyFiles = command("git", ["-C", repoPath, "status", "--porcelain"]).split("\n").filter(Boolean).length;
  const telemetry: VpsTelemetry = {
    generatedAt: new Date().toISOString(),
    host: command("hostname", []),
    reachable: true,
    latencyMs: 0,
    uptimeSeconds,
    load,
    memory: {
      usedBytes: total - available,
      totalBytes: total,
      swapUsedBytes: swapTotal - swapFree,
      swapTotalBytes: swapTotal,
    },
    disk: {
      totalBytes: Number(diskRaw[0] ?? 0),
      usedBytes: Number(diskRaw[1] ?? 0),
      percent: Number((diskRaw[2] ?? "0").replace("%", "")),
    },
    deployment: {
      repoPath,
      branch: command("git", ["-C", repoPath, "branch", "--show-current"]) || undefined,
      sha: command("git", ["-C", repoPath, "rev-parse", "--short=12", "HEAD"]) || undefined,
      originSha: command("git", ["-C", repoPath, "rev-parse", "--short=12", "origin/master"]) || undefined,
      dirty: dirtyFiles > 0,
      dirtyFiles,
    },
    jobs: {
      total: allJobs.length,
      running: allJobs.filter((job) => ["queued", "starting", "running"].includes(job.state)).length,
      failed: allJobs.filter((job) => job.state === "failed").length,
      lost: allJobs.filter((job) => job.state === "lost").length,
      byHarness,
      recent: [...allJobs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 12).map((job) => ({
        id: job.id,
        title: job.title,
        state: job.state,
        harness: job.harness,
        model: job.model,
        updatedAt: job.updatedAt,
        error: job.error,
      })),
    },
    models: {
      total: catalog?.models.length ?? 0,
      generatedAt: catalog?.generatedAt,
      sources: catalog?.sources ?? [],
      fallbackOrder: ["codex", "claude", "omp", "opencode", "kimi", "cline"],
    },
    units: unitList,
    timers: timers(unitList),
    processes: processes(),
  };
  console.log(JSON.stringify(telemetry));
}

main();
