import { join } from "node:path";
import { loadConfig } from "./config";
import { run, shellQuote } from "./process";
import { JobStore } from "./store";
import type { HostConfig, JobStatus } from "./types";

const terminalStates = new Set(["succeeded", "failed", "cancelled", "lost"]);

export interface GcEntry {
  kind: "worktree" | "job" | "audit";
  path: string;
  reason: string;
  bytes: number;
  removed: boolean;
}

export interface GcReport {
  host: string;
  dryRun: boolean;
  entries: GcEntry[];
  reclaimedBytes: number;
  keptBytes: number;
  errors: string[];
}

export interface GcOptions {
  dryRun?: boolean;
  olderThanDays?: number;
  auditMaxBytes?: number;
  host?: string;
  force?: boolean;
}

function remote(host: HostConfig, command: string, fallback = ""): string {
  try {
    return run("ssh", [host.target!, command]);
  } catch {
    return fallback;
  }
}

function ageDays(value?: string): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? (Date.now() - at) / 86_400_000 : Number.POSITIVE_INFINITY;
}

/**
 * Reclaim the disk that finished jobs leave behind.
 *
 * `prepareWorkspace` adds a Git worktree for every isolated job and nothing
 * removes it. The worktrees directory reached 3.7 GB. Removing a worktree keeps
 * the branch, because `git worktree add -b` writes a real branch into the
 * parent repository, so committed work survives. Uncommitted work does not, so
 * a worktree with local changes is kept unless the caller passes `force`.
 */
export function collectHost(host: HostConfig, options: GcOptions = {}): GcReport {
  const dryRun = options.dryRun ?? false;
  const cutoff = options.olderThanDays ?? 14;
  const auditMax = options.auditMaxBytes ?? 32 * 1024 * 1024;
  const report: GcReport = { host: host.name, dryRun, entries: [], reclaimedBytes: 0, keptBytes: 0, errors: [] };
  if (host.kind !== "ssh" || !host.target) {
    report.errors.push(`${host.name} is not a reachable SSH host.`);
    return report;
  }

  const store = new JobStore(loadConfig().stateRoot);
  const byId = new Map<string, JobStatus>(store.list(2000).map((job) => [job.id, job]));

  const worktreeRoot = join(host.stateRoot, "worktrees");
  const listing = remote(host, `find ${shellQuote(worktreeRoot)} -mindepth 2 -maxdepth 2 -type d -print 2>/dev/null || true`);
  for (const path of listing.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const id = path.split("/").pop() ?? "";
    const job = byId.get(id);
    const bytes = Number(remote(host, `du -sb ${shellQuote(path)} 2>/dev/null | cut -f1`, "0")) || 0;
    if (job && !terminalStates.has(job.state)) {
      report.keptBytes += bytes;
      continue;
    }
    if (job && ageDays(job.completedAt ?? job.updatedAt) < cutoff) {
      report.keptBytes += bytes;
      continue;
    }
    const dirty = remote(host, `git -C ${shellQuote(path)} status --porcelain 2>/dev/null | head -c 1 || true`);
    if (dirty && !options.force) {
      report.keptBytes += bytes;
      report.entries.push({ kind: "worktree", path, reason: "The worktree has uncommitted changes.", bytes, removed: false });
      continue;
    }
    const entry: GcEntry = {
      kind: "worktree",
      path,
      reason: job ? `The job is ${job.state} and older than ${cutoff} day(s).` : "No job record refers to this worktree.",
      bytes,
      removed: false,
    };
    if (dryRun) {
      // A dry run must report the size it would free. Counting only real
      // deletions made the summary read "would reclaim 0.0 MB" above a list of
      // gigabytes.
      report.reclaimedBytes += bytes;
    } else {
      try {
        // `git worktree remove` keeps the branch and the parent's administrative
        // files consistent. A plain delete would leave a stale registration.
        run("ssh", [host.target, `git -C ${shellQuote(path)} rev-parse --show-toplevel >/dev/null 2>&1 && ` +
          `git -C ${shellQuote(path)} worktree remove --force ${shellQuote(path)} 2>/dev/null || rm -rf ${shellQuote(path)}`]);
        entry.removed = true;
        report.reclaimedBytes += bytes;
      } catch (error) {
        report.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    report.entries.push(entry);
  }

  if (!dryRun && report.entries.some((entry) => entry.kind === "worktree" && entry.removed)) {
    remote(host, `find ${shellQuote(join(host.stateRoot, "worktrees"))} -mindepth 1 -maxdepth 1 -type d -exec git -C {} worktree prune \\; 2>/dev/null || true`);
  }

  // Prune the local event table in the same pass. It is not on the host, but
  // it is the same class of unbounded growth.
  if (!dryRun) {
    const removed = store.pruneEvents(Math.max(cutoff, 30));
    if (removed) {
      report.entries.push({
        kind: "job",
        path: "events table",
        reason: `Removed ${removed} event row(s) older than ${Math.max(cutoff, 30)} day(s).`,
        bytes: 0,
        removed: true,
      });
    }
  }

  // Snapshots are content-addressed and shared, so they are not tied to any one
  // job. Age is the only safe signal: a snapshot older than the window cannot
  // belong to a job still being planned.
  const snapshots = remote(host, `find ${shellQuote(join(host.stateRoot, "snapshots"))} -mindepth 1 -maxdepth 1 -type d -mtime +${cutoff} -print 2>/dev/null || true`);
  for (const path of snapshots.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const bytes = Number(remote(host, `du -sb ${shellQuote(path)} 2>/dev/null | cut -f1`, "0")) || 0;
    const entry: GcEntry = {
      kind: "job",
      path,
      reason: `Workspace snapshot older than ${cutoff} day(s).`,
      bytes,
      removed: false,
    };
    if (dryRun) report.reclaimedBytes += bytes;
    else {
      remote(host, `rm -rf ${shellQuote(path)}`);
      entry.removed = true;
      report.reclaimedBytes += bytes;
    }
    report.entries.push(entry);
  }

  const audit = join(host.stateRoot, "events", "audit.jsonl");
  const auditBytes = Number(remote(host, `wc -c < ${shellQuote(audit)} 2>/dev/null || echo 0`, "0")) || 0;
  if (auditBytes > auditMax) {
    const entry: GcEntry = {
      kind: "audit",
      path: audit,
      reason: `The audit log is ${Math.round(auditBytes / 1_048_576)} MB, above the ${Math.round(auditMax / 1_048_576)} MB limit.`,
      bytes: auditBytes,
      removed: false,
    };
    if (dryRun) {
      report.reclaimedBytes += auditBytes;
    } else {
      // Rotate rather than truncate in place. A truncation while a worker
      // appends would corrupt the line the worker is writing.
      remote(host, `mv ${shellQuote(audit)} ${shellQuote(`${audit}.1`)} && : > ${shellQuote(audit)} && chown ${shellQuote(host.defaultUser ?? "usman")} ${shellQuote(audit)}`);
      entry.removed = true;
      report.reclaimedBytes += auditBytes;
    }
    report.entries.push(entry);
  }

  return report;
}

export function collectAll(options: GcOptions = {}): GcReport[] {
  const config = loadConfig();
  return Object.values(config.hosts)
    .filter((host) => host.kind === "ssh" && host.target && (!options.host || host.name === options.host))
    .map((host) => collectHost(host, options));
}

export function formatGc(reports: GcReport[]): string {
  const mb = (value: number) => `${(value / 1_048_576).toFixed(1)} MB`;
  return reports.map((report) => {
    const head = `${report.host}: ${report.dryRun ? "would reclaim" : "reclaimed"} ${mb(report.reclaimedBytes)}, kept ${mb(report.keptBytes)}`;
    const lines = report.entries.map((entry) =>
      `  ${entry.removed ? "removed" : report.dryRun ? "would remove" : "kept   "}  ${mb(entry.bytes).padStart(9)}  ${entry.path}\n            ${entry.reason}`);
    const errors = report.errors.map((error) => `  error: ${error}`);
    return [head, ...lines, ...errors].join("\n");
  }).join("\n\n") || "no ssh hosts configured";
}
