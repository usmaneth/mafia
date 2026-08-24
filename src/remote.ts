import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { HostConfig, JobSpec, JobStatus } from "./types";
import { repoRoot } from "./config";
import { run, shellQuote } from "./process";

export function installRemote(host: HostConfig): void {
  if (host.kind !== "ssh" || !host.target || !host.workerPath) return;
  run("ssh", [host.target, `mkdir -p ${shellQuote(dirname(host.workerPath))} ${shellQuote(host.stateRoot)}`]);
  run("scp", [join(repoRoot, "worker", "worker.mjs"), `${host.target}:${host.workerPath}`]);
  const ownership = host.defaultUser
    ? ` && chown -R ${shellQuote(host.defaultUser)} ${shellQuote(host.stateRoot)}`
    : "";
  run("ssh", [host.target, `chmod 755 ${shellQuote(host.workerPath)}${ownership}`]);
}

export function dispatchRemote(host: HostConfig, spec: JobSpec): number {
  if (host.kind !== "ssh" || !host.target || !host.workerPath) {
    throw new Error(`Host ${host.name} is not a complete SSH host.`);
  }
  installRemote(host);
  const localSpec = join(tmpdir(), `${spec.id}.json`);
  writeFileSync(localSpec, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
  const remoteDir = join(host.stateRoot, "jobs", spec.id);
  const remoteSpec = join(remoteDir, "spec.json");
  run("ssh", [host.target, `mkdir -p ${shellQuote(remoteDir)}`]);
  run("scp", [localSpec, `${host.target}:${remoteSpec}`]);
  const user = host.harnessUsers?.[spec.harness] ?? host.defaultUser;
  if (user) run("ssh", [host.target, `chown -R ${shellQuote(user)} ${shellQuote(remoteDir)}`]);
  const inner = [
    `nohup node ${shellQuote(host.workerPath)} ${shellQuote(remoteSpec)}`,
    `> ${shellQuote(join(remoteDir, "launcher.log"))} 2>&1 < /dev/null & echo $!`,
  ].join(" ");
  const command = user ? `sudo -iu ${shellQuote(user)} bash -lc ${shellQuote(inner)}` : inner;
  return Number(run("ssh", [host.target, command]));
}

export function readRemoteStatus(host: HostConfig, id: string): JobStatus | undefined {
  if (host.kind !== "ssh" || !host.target) return undefined;
  try {
    const path = join(host.stateRoot, "jobs", id, "status.json");
    return JSON.parse(run("ssh", [host.target, `cat ${shellQuote(path)}`])) as JobStatus;
  } catch {
    return undefined;
  }
}

export function readRemoteLog(host: HostConfig, id: string, lines: number): string {
  if (host.kind !== "ssh" || !host.target) throw new Error("The host is not remote.");
  const path = join(host.stateRoot, "jobs", id, "output.log");
  return run("ssh", [host.target, `tail -n ${Math.max(1, lines)} ${shellQuote(path)}`]);
}

export function cancelRemote(host: HostConfig, id: string): void {
  const status = readRemoteStatus(host, id);
  if (!status?.pid || !host.target) throw new Error(`No live remote PID for ${id}.`);
  run("ssh", [host.target, `kill -TERM ${status.pid}`]);
}

export function discoverRemote(host: HostConfig): JobStatus[] {
  if (host.kind !== "ssh" || !host.target) return [];
  const command = `find ${shellQuote(join(host.stateRoot, "jobs"))} -mindepth 2 -maxdepth 2 -name status.json -type f -print0 2>/dev/null | xargs -0 -r cat`;
  const raw = run("ssh", [host.target, command]);
  if (!raw) return [];
  const statuses: JobStatus[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && start >= 0) statuses.push(JSON.parse(raw.slice(start, i + 1)));
    }
  }
  return statuses;
}
