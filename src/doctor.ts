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
  const missing = ["git", "node", "bun", "rsync", "ssh", "omp"].filter((binary) =>
    !sh("sh", ["-c", `command -v ${binary}`]).ok);
  return missing.length
    ? { name: "toolchain", state: "fail", detail: `not on PATH: ${missing.join(", ")}`, fix: "Install the missing tools, or check the PATH a timer passes." }
    : { name: "toolchain", state: "ok", detail: "every required binary resolves" };
}

function reachable(host: HostConfig): Check {
  const started = Date.now();
  const result = sh("ssh", [host.target!, "true"]);
  const ms = Date.now() - started;
  if (!result.ok) {
    return { name: `ssh:${host.name}`, state: "fail", detail: result.out.slice(0, 90) || "no answer", fix: "Check the VPS is up and the key is loaded." };
  }
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

function workerParity(host: HostConfig): Check {
  const local = existsSync(join(repoRoot, "worker", "worker.mjs"))
    ? createHash("sha256").update(readFileSync(join(repoRoot, "worker", "worker.mjs"))).digest("hex")
    : "";
  const remote = sh("ssh", [host.target!, `sha256sum ${host.workerPath} /home/usman/mafia/worker/worker.mjs 2>/dev/null | awk '{print $1}'`]);
  const hashes = remote.out.split("\n").map((line) => line.trim()).filter(Boolean);
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

function diskAndState(host: HostConfig, cutoffDays = 7): Check {
  const usage = sh("ssh", [host.target!, "df -P / | tail -1 | awk '{print $5}' | tr -d %"]);
  const percent = Number(usage.out.trim());
  const stale = sh("ssh", [host.target!, [
    `find ${host.stateRoot}/worktrees -mindepth 2 -maxdepth 2 -type d -mtime +${cutoffDays} 2>/dev/null | wc -l`,
    `find ${host.stateRoot}/snapshots -mindepth 1 -maxdepth 1 -type d -mtime +${cutoffDays} 2>/dev/null | wc -l`,
  ].join("; ")]);
  const [worktrees = "0", snapshots = "0"] = stale.out.split("\n").map((line) => line.trim());
  const reclaimable = Number(worktrees) + Number(snapshots);
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
function cursors(host: HostConfig, stateRoot: string): Check {
  const path = join(stateRoot, "cursors", `${host.name}.json`);
  if (!existsSync(path)) return { name: "cursors", state: "ok", detail: "no cursor yet; the next read starts from the beginning" };
  try {
    const cursor = JSON.parse(readFileSync(path, "utf8")) as { events?: number };
    const size = Number(sh("ssh", [host.target!, `wc -c < ${host.stateRoot}/events/audit.jsonl 2>/dev/null || echo 0`]).out.trim());
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
    const live = reachable(host);
    checks.push(live);
    // Every remaining host check needs the connection, so skip them cleanly
    // rather than emitting a cascade of failures that all mean the same thing.
    if (live.state === "fail") continue;
    checks.push(workerParity(host), diskAndState(host), cursors(host, config.stateRoot));
  }
  checks.push(quota(config.stateRoot), roles(config.stateRoot), catalogHealth(config.stateRoot), database(config.stateRoot));
  return checks;
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
