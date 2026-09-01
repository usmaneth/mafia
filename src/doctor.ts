import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadConfig, repoRoot } from "./config";
import { toolEnvironment } from "./process";
import { withSshMultiplexing } from "./ssh";
import { mirrorIsHealthy, readMirrorState } from "./mirror";
import { exhaustedProviders, ProviderUsageService, readPenalties } from "./provider-usage";
import { healthyRoleModels, readConfiguredRoles } from "./roles";
import { ModelCatalogService } from "./models";
import { readMetrics } from "./bench";
import { JobStore } from "./store";
import { resultProblems } from "./result-quality";
import type { HostConfig } from "./types";

export type CheckState = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** What to run or change. Every non-ok check must name one. */
  fix?: string;
}

function sh(command: string, args: string[], timeout = 20_000): { ok: boolean; out: string } {
  const result = spawnSync(command, withSshMultiplexing(command, args), {
    encoding: "utf8",
    env: toolEnvironment(),
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return { ok: false, out: result.error.message };
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function toolchain(): Check {
  // One shell, not one per binary. Six spawns were most of this command's time.
  const wanted = ["git", "node", "bun", "rsync", "ssh", "omp"];
  const found = new Set(
    sh("sh", ["-c", wanted.map((binary) => `command -v ${binary} >/dev/null 2>&1 && echo ${binary}`).join("; ")])
      .out.split("\n").map((line) => line.trim()).filter(Boolean),
  );
  const missing = wanted.filter((binary) => !found.has(binary));
  return missing.length
    ? { name: "toolchain", state: "fail", detail: `not on PATH: ${missing.join(", ")}`, fix: "Install the missing tools, or check the PATH a timer passes." }
    : { name: "toolchain", state: "ok", detail: "every required binary resolves" };
}

export interface HostFacts {
  ok: boolean;
  latencyMs: number;
  error?: string;
  workerHashes: string[];
  diskPercent: number;
  ownedBytes: number;
  staleWorktrees: number;
  staleSnapshots: number;
  auditBytes: number;
}

/**
 * Ask the host everything in one round trip.
 *
 * The checks below each used to open their own connection. Six sequential
 * probes made `doctor` the slowest command in the tool at 0.73 s, for facts
 * that all come from the same shell.
 */
export function probeHost(host: HostConfig, cutoffDays = 7): HostFacts {
  const started = Date.now();
  const script = [
    `printf 'HASH\n'`,
    `sha256sum ${host.workerPath} /home/${host.defaultUser ?? "usman"}/mafia/worker/worker.mjs 2>/dev/null | awk '{print $1}'`,
    `printf 'DISK\n'; df -P / | tail -1 | awk '{print $5}' | tr -d %`,
    `printf 'OWNED\n'; du -sb ${host.stateRoot} 2>/dev/null | cut -f1`,
    `printf 'WORKTREES\n'; find ${host.stateRoot}/worktrees -mindepth 2 -maxdepth 2 -type d -mtime +${cutoffDays} 2>/dev/null | wc -l`,
    `printf 'SNAPSHOTS\n'; find ${host.stateRoot}/snapshots -mindepth 1 -maxdepth 1 -type d -mtime +${cutoffDays} 2>/dev/null | wc -l`,
    `printf 'AUDIT\n'; wc -c < ${host.stateRoot}/events/audit.jsonl 2>/dev/null || echo 0`,
  ].join("; ");
  const result = sh("ssh", [host.target!, script], 45_000);
  const latencyMs = Date.now() - started;
  if (!result.ok) {
    return { ok: false, latencyMs, error: result.out.slice(0, 90), workerHashes: [], diskPercent: 0, ownedBytes: 0, staleWorktrees: 0, staleSnapshots: 0, auditBytes: 0 };
  }
  const section = (name: string): string[] => {
    const lines = result.out.split("\n").map((line) => line.trim());
    const start = lines.indexOf(name);
    if (start < 0) return [];
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^(HASH|DISK|OWNED|WORKTREES|SNAPSHOTS|AUDIT)$/.test(lines[i]!)) break;
      if (lines[i]) out.push(lines[i]!);
    }
    return out;
  };
  const one = (name: string) => Number(section(name)[0] ?? 0) || 0;
  return {
    ok: true,
    latencyMs,
    workerHashes: section("HASH"),
    diskPercent: one("DISK"),
    ownedBytes: one("OWNED"),
    staleWorktrees: one("WORKTREES"),
    staleSnapshots: one("SNAPSHOTS"),
    auditBytes: one("AUDIT"),
  };
}

function reachable(host: HostConfig, facts: HostFacts): Check {
  if (!facts.ok) {
    return { name: `ssh:${host.name}`, state: "fail", detail: facts.error || "no answer", fix: "Check the VPS is up and the key is loaded." };
  }
  const ms = facts.latencyMs;
  // A reused connection answers in tens of milliseconds; a fresh handshake to
  // this host costs about 580 ms.
  const shared = ms < 250;
  return {
    name: `ssh:${host.name}`,
    state: shared ? "ok" : "warn",
    detail: `${ms}ms${shared ? " (connection reused)" : " (no shared connection)"}`,
    fix: shared ? undefined : "Expected multiplexing. Check MAFIA_SSH_MULTIPLEX is not set to 0.",
  };
}

function mirror(stateRoot: string): Check {
  const state = readMirrorState(stateRoot);
  if (!state) return { name: "mirror", state: "warn", detail: "never run", fix: "mafia mirror" };
  if (state.verdict === "conflict") {
    return { name: "mirror", state: "fail", detail: `${state.conflicts.length} remote-only path(s): ${state.conflicts.slice(0, 3).join(", ")}`, fix: "Resolve them on the VPS, or `mafia mirror --force` to overwrite." };
  }
  if (!mirrorIsHealthy(state)) {
    return { name: "mirror", state: "warn", detail: `${state.verdict} at ${state.checkedAt}`, fix: "mafia mirror" };
  }
  return { name: "mirror", state: "ok", detail: `${state.verdict}, checked ${state.checkedAt.slice(11, 19)}Z` };
}

function workerParity(host: HostConfig, facts: HostFacts): Check {
  const local = existsSync(join(repoRoot, "worker", "worker.mjs"))
    ? createHash("sha256").update(readFileSync(join(repoRoot, "worker", "worker.mjs"))).digest("hex")
    : "";
  const hashes = facts.workerHashes;
  const agreed = hashes.length >= 1 && hashes.every((value) => value === local);
  return agreed
    ? { name: "worker-parity", state: "ok", detail: "the running worker matches the source" }
    : {
      name: "worker-parity",
      state: "fail",
      // The deployed worker used to be copied outside Git, so the file being
      // executed could differ from the one a reader would open.
      detail: "the deployed worker differs from local worker/worker.mjs",
      fix: "mafia mirror",
    };
}

function timer(): Check {
  const list = sh("launchctl", ["list"]);
  if (!list.out.includes("dev.mafia.update")) {
    return { name: "timer", state: "warn", detail: "the update timer is not loaded", fix: "mafia install-updater" };
  }
  const log = join(homedir(), ".local", "share", "mafia", "update.log");
  if (!existsSync(log)) return { name: "timer", state: "warn", detail: "loaded but has never run", fix: "Wait for the interval, or run `mafia update --deploy`." };
  try {
    // launchd appends, so the file holds one JSON array per run. Only the most
    // recent one describes the current state.
    const raw = readFileSync(log, "utf8");
    const last = raw.lastIndexOf("\n[\n");
    const entries = JSON.parse(last >= 0 ? raw.slice(last + 1) : raw) as Array<{ target: string; status: string; detail: string }>;
    const bad = entries.filter((entry) => entry.status === "error");
    const age = Math.round((Date.now() - statSync(log).mtimeMs) / 60_000);
    if (bad.length) {
      return { name: "timer", state: "fail", detail: `${bad.length} failing target(s): ${bad.map((entry) => entry.target).join(", ")}`, fix: "Read ~/.local/share/mafia/update.log for the reason." };
    }
    const bytes = statSync(log).size;
    if (bytes > 2 * 1024 * 1024) {
      return { name: "timer", state: "warn", detail: `healthy, but the log has grown to ${Math.round(bytes / 1048576)} MB`, fix: `: > ${log}` };
    }
    return { name: "timer", state: age > 20 ? "warn" : "ok", detail: `last run ${age}m ago, every target ok`, fix: age > 20 ? "The timer looks stalled; try `mafia install-updater`." : undefined };
  } catch {
    return { name: "timer", state: "warn", detail: "the update log is not readable JSON", fix: "Check for output written before the report." };
  }
}

function quota(stateRoot: string): Check {
  const usage = new ProviderUsageService(stateRoot).cached();
  if (!usage) return { name: "quota", state: "warn", detail: "provider quota has never been read", fix: "mafia quota --refresh" };
  const spent = [...exhaustedProviders(usage)];
  const benched = readPenalties(stateRoot);
  const tight = usage.providers.filter((entry) => entry.usedFraction >= 0.75 && entry.usedFraction < 0.95);
  if (spent.length || benched.length) {
    return {
      name: "quota",
      state: "warn",
      detail: [spent.length ? `at the limit: ${spent.join(", ")}` : "", benched.length ? `benched: ${benched.map((entry) => entry.provider).join(", ")}` : ""].filter(Boolean).join("; "),
      fix: "Routing already avoids these. `mafia quota` for the windows.",
    };
  }
  return {
    name: "quota",
    state: "ok",
    detail: tight.length ? `all under the limit (${tight.map((entry) => `${entry.provider} ${Math.round(entry.usedFraction * 100)}%`).join(", ")})` : "every provider has room",
  };
}

function roles(stateRoot: string): Check {
  const catalog = new ModelCatalogService(stateRoot).cached();
  const usage = new ProviderUsageService(stateRoot).cached();
  const result = healthyRoleModels(readConfiguredRoles(), catalog, usage, stateRoot);
  if (result.unfixable.length) {
    return {
      name: "omp-roles",
      state: "fail",
      // A role with no command-line flag can only be fixed in the profile, and
      // OMP's own subagents use it on every run.
      detail: `${result.unfixable.map((entry) => entry.role).join(", ")} point at a provider that cannot take work`,
      fix: "omp --profile mafia config set modelRoles '{...}' with a healthy model.",
    };
  }
  if (result.changes.length) {
    return { name: "omp-roles", state: "warn", detail: `${result.changes.length} role(s) repinned at dispatch`, fix: "mafia roles" };
  }
  return { name: "omp-roles", state: "ok", detail: "every role points at a healthy provider" };
}

function catalogHealth(stateRoot: string): Check {
  const catalog = new ModelCatalogService(stateRoot).cached();
  if (!catalog) return { name: "model-catalog", state: "warn", detail: "no catalog", fix: "mafia models --refresh" };
  const failed = catalog.sources.filter((source) => source.status !== "ok");
  const ageMinutes = Math.round((Date.now() - new Date(catalog.generatedAt).getTime()) / 60_000);
  const measured = Object.keys(readMetrics(stateRoot).models).length;
  if (failed.length) {
    return { name: "model-catalog", state: "warn", detail: `${failed.map((source) => source.harness).join(", ")} failed; showing the last good list`, fix: "mafia models --refresh" };
  }
  return {
    name: "model-catalog",
    state: "ok",
    detail: `${catalog.models.length} models, ${ageMinutes}m old, ${measured} measured`,
    fix: measured === 0 ? "No measured latency yet; routing is guessing. `mafia bench --models <a,b>`." : undefined,
  };
}

/**
 * Result extraction degrades silently: the job still says it succeeded.
 * Nothing else in the system reports it, so it is checked here.
 */
function resultExtraction(stateRoot: string): Check {
  // Health describes now. Extraction failures from weeks ago stay visible in
  // `mafia results`, but a warning that can never clear stops being read.
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const jobs = new JobStore(stateRoot).list(300).filter((job) => job.updatedAt >= cutoff);
  const finished = jobs.filter((job) => job.state === "succeeded");
  const problems = resultProblems(jobs);
  if (!finished.length) return { name: "result-extraction", state: "ok", detail: "no finished jobs yet" };
  const rate = problems.length / finished.length;
  const harnesses = [...new Set(problems.map((problem) => problem.harness))];
  return {
    name: "result-extraction",
    state: rate > 0.1 ? "fail" : problems.length ? "warn" : "ok",
    detail: problems.length
      ? `${problems.length} of ${finished.length} succeeded jobs have no usable result (${harnesses.join(", ")})`
      : `all ${finished.length} succeeded jobs produced a result`,
    fix: problems.length ? "mafia results - the harness output shape probably changed" : undefined,
  };
}

function database(stateRoot: string): Check {
  const store = new JobStore(stateRoot);
  const indexes = (store.db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
    .map((row) => row.name);
  const wanted = ["jobs_updated", "events_created", "messages_undelivered"];
  const missing = wanted.filter((name) => !indexes.includes(name));
  const events = (store.db.query("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
  if (missing.length) {
    return { name: "database", state: "fail", detail: `missing index: ${missing.join(", ")}`, fix: "Open Mafia once to apply the schema, or check for a write error." };
  }
  return {
    name: "database",
    state: events > 100_000 ? "warn" : "ok",
    detail: `indexed, ${events} event row(s)`,
    fix: events > 100_000 ? "mafia gc" : undefined,
  };
}

function diskAndState(host: HostConfig, facts: HostFacts, cutoffDays = 7): Check {
  const percent = facts.diskPercent;
  const reclaimable = facts.staleWorktrees + facts.staleSnapshots;
  if (Number.isFinite(percent) && percent >= 90) {
    // Report only what Mafia owns. A `du` across the whole home directory took
    // 202 seconds here, which is far too slow for a health check, and the
    // answer would be about directories Mafia does not manage anyway.
    const owned = sh("ssh", [host.target!, `du -sh ${host.stateRoot} 2>/dev/null | cut -f1`], 30_000).out.trim();
    return {
      name: `disk:${host.name}`,
      state: "fail",
      detail: `${percent}% used; Mafia state is ${owned || "unknown"}`,
      fix: reclaimable
        ? `mafia gc --days 3 reclaims ${reclaimable} director(ies).`
        : `Mafia has nothing left to reclaim. For the rest: ssh ${host.target} 'du -sh /home/${host.defaultUser ?? "usman"}/* | sort -rh | head'`,
    };
  }
  return {
    name: `disk:${host.name}`,
    state: reclaimable > 20 ? "warn" : "ok",
    detail: `${percent}% used, ${reclaimable} director(ies) past ${cutoffDays} days`,
    fix: reclaimable > 20 ? "mafia gc" : undefined,
  };
}

/**
 * A cursor ahead of the file it tracks means events are being skipped.
 *
 * Both cursors reset themselves when the remote file shrinks, but a cursor that
 * is somehow past the end would silently stop delivering anything, and nothing
 * else in the system would report it.
 */
function cursors(host: HostConfig, stateRoot: string, facts: HostFacts): Check {
  const path = join(stateRoot, "cursors", `${host.name}.json`);
  if (!existsSync(path)) return { name: "cursors", state: "ok", detail: "no cursor yet; the next read starts from the beginning" };
  try {
    const cursor = JSON.parse(readFileSync(path, "utf8")) as { events?: number };
    const size = facts.auditBytes;
    if ((cursor.events ?? 0) > size) {
      return { name: "cursors", state: "fail", detail: `event cursor ${cursor.events} is past the file at ${size}`, fix: `rm ${path}` };
    }
    return { name: "cursors", state: "ok", detail: `${size - (cursor.events ?? 0)} byte(s) pending` };
  } catch {
    return { name: "cursors", state: "warn", detail: "the cursor file is unreadable", fix: `rm ${path}` };
  }
}

export function runDoctor(): Check[] {
  const config = loadConfig();
  const checks: Check[] = [toolchain(), timer(), mirror(config.stateRoot)];
  for (const host of Object.values(config.hosts)) {
    if (host.kind !== "ssh" || !host.target) continue;
    const facts = probeHost(host);
    const live = reachable(host, facts);
    checks.push(live);
    // Every remaining host check needs the connection, so skip them cleanly
    // rather than emitting a cascade of failures that all mean the same thing.
    if (live.state === "fail") continue;
    checks.push(workerParity(host, facts), diskAndState(host, facts), cursors(host, config.stateRoot, facts));
  }
  checks.push(quota(config.stateRoot), roles(config.stateRoot), catalogHealth(config.stateRoot),
    resultExtraction(config.stateRoot), database(config.stateRoot));
  return checks;
}

/** Remedies that are safe to run unattended: idempotent, and never destructive. */
const safeFixes: Record<string, string[]> = {
  mirror: ["mirror"],
  "model-catalog": ["models", "--refresh"],
  quota: ["quota", "--refresh"],
  timer: ["install-updater"],
  "worker-parity": ["mirror"],
};

export interface FixResult {
  name: string;
  ran: string;
  ok: boolean;
  detail: string;
}

/**
 * Apply the remedies that carry no judgement.
 *
 * A check whose fix deletes data, edits a profile, or spends quota is never run
 * here. Those are named and left to a person. `mafia gc` is excluded on purpose:
 * reclaiming disk is a choice about how much history to keep.
 */
export function applyFixes(checks: Check[], runCommand: (args: string[]) => { ok: boolean; out: string }): FixResult[] {
  const results: FixResult[] = [];
  for (const check of checks) {
    if (check.state === "ok") continue;
    const fix = safeFixes[check.name];
    if (!fix) {
      results.push({ name: check.name, ran: "", ok: false, detail: check.fix ?? "No automatic remedy; this one needs a person." });
      continue;
    }
    const outcome = runCommand(fix);
    results.push({ name: check.name, ran: `mafia ${fix.join(" ")}`, ok: outcome.ok, detail: outcome.out.split("\n")[0]?.slice(0, 90) ?? "" });
  }
  return results;
}

export function formatFixes(results: FixResult[]): string {
  if (!results.length) return "nothing needed fixing";
  return results.map((result) => result.ran
    ? `  ${result.ok ? "fixed  " : "FAILED "} ${result.name.padEnd(16)} ${result.ran}\n            ${result.detail}`
    : `  manual  ${result.name.padEnd(16)} ${result.detail}`).join("\n");
}

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Report only what changed since the last run.
 *
 * A scheduled health check that repeats its findings every five minutes trains
 * the reader to skip it, and the one time something new appears it reads like
 * the same noise. Alerting on the transition keeps a quiet system quiet.
 */
export function changedChecks(checks: Check[], stateRoot: string): Check[] {
  const path = join(stateRoot, "doctor-state.json");
  let previous: Record<string, string> = {};
  try {
    previous = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {}
  const current: Record<string, string> = {};
  for (const check of checks) current[check.name] = check.state;
  const changed = checks.filter((check) => previous[check.name] !== check.state);
  // A check that vanished, because a host went away, is not a change worth
  // reporting; only states that exist now are recorded.
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch {}
  return changed;
}

export function formatDoctor(checks: Check[]): string {
  const mark: Record<CheckState, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const lines = checks.map((check) => {
    const head = `  ${mark[check.state]}  ${check.name.padEnd(16)} ${check.detail}`;
    return check.fix ? `${head}\n            -> ${check.fix}` : head;
  });
  const failed = checks.filter((check) => check.state === "fail").length;
  const warned = checks.filter((check) => check.state === "warn").length;
  const summary = failed
    ? `${failed} failing, ${warned} warning`
    : warned ? `${warned} warning` : "everything healthy";
  return [...lines, "", `  ${summary}`].join("\n");
}
