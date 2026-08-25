import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { HostConfig, JobSpec, JobStatus, MafiaEvent, MafiaMessage } from "./types";
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
  const remoteDir = join(host.stateRoot, "jobs", spec.id);
  const remoteSpec = join(remoteDir, "spec.json");
  run("ssh", [host.target, `mkdir -p ${shellQuote(remoteDir)}`]);
  const remoteValue = { ...spec };
  const snapshot = spec.repo && existsSync(spec.repo)
    ? prepareRemoteWorkspace(host, spec)
    : undefined;
  if (snapshot) Object.assign(remoteValue, snapshot);
  if (spec.contextPackPath && existsSync(spec.contextPackPath)) {
    const remoteContext = join(remoteDir, "context.md");
    run("scp", [spec.contextPackPath, `${host.target}:${remoteContext}`]);
    remoteValue.contextPackPath = remoteContext;
  }
  const localSpec = join(tmpdir(), `${spec.id}.json`);
  writeFileSync(localSpec, `${JSON.stringify(remoteValue, null, 2)}\n`, { mode: 0o600 });
  run("scp", [localSpec, `${host.target}:${remoteSpec}`]);
  const user = host.harnessUsers?.[spec.harness] ?? host.defaultUser;
  if (user) run("ssh", [host.target, `chown -R ${shellQuote(user)} ${shellQuote(remoteDir)}`]);
  const inner = [
    `nohup env -u OPENAI_API_KEY -u CODEX_API_KEY node ${shellQuote(host.workerPath)} ${shellQuote(remoteSpec)}`,
    `> ${shellQuote(join(remoteDir, "launcher.log"))} 2>&1 < /dev/null & echo $!`,
  ].join(" ");
  const command = user ? `sudo -iu ${shellQuote(user)} bash -lc ${shellQuote(inner)}` : inner;
  return Number(run("ssh", [host.target, command]));
}

export function repoSlugFromOrigin(origin: string): string | undefined {
  const normalized = origin.trim().replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function prepareRemoteWorkspace(host: HostConfig, spec: JobSpec): Partial<JobSpec> | undefined {
  if (!host.target || !spec.repo) return undefined;
  const root = run("git", ["-C", spec.repo, "rev-parse", "--show-toplevel"]);
  const origin = run("git", ["-C", root, "remote", "get-url", "origin"]);
  const slug = repoSlugFromOrigin(origin);
  if (!slug) throw new Error(`Cannot map the Git remote for ${root} to the VPS.`);
  const remoteRepo = `/home/${host.defaultUser ?? "usman"}/mafia-workspaces/${slug}`;
  const remoteSnapshot = join(host.stateRoot, "snapshots", spec.id);
  const ref = `refs/mafia/snapshots/${spec.id}`;
  const temp = mkdtempSync(join(tmpdir(), `${spec.id}-`));
  const bundle = join(temp, "workspace.bundle");
  const patch = join(temp, "workspace.patch");
  const archive = join(temp, "untracked.tar");
  try {
    run("git", ["-C", root, "bundle", "create", bundle, "HEAD"]);
    const diff = spawnSync("git", ["-C", root, "diff", "--binary", "HEAD"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (diff.status !== 0) throw new Error((diff.stderr?.toString() || "Cannot create the workspace patch.").trim());
    writeFileSync(patch, diff.stdout);
    const untracked = spawnSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], {
      encoding: "buffer",
    });
    if (untracked.status !== 0) throw new Error("Cannot list untracked files.");
    const tar = spawnSync("tar", ["-cf", archive, "--null", "-T", "-"], {
      cwd: root,
      input: untracked.stdout,
      encoding: "buffer",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (tar.status !== 0) throw new Error((tar.stderr?.toString() || "Cannot archive untracked files.").trim());
    const ownership = host.defaultUser
      ? ` && chown -R ${shellQuote(host.defaultUser)} ${shellQuote(remoteSnapshot)} ${shellQuote(dirname(remoteRepo))}`
      : "";
    run("ssh", [
      host.target,
      `mkdir -p ${shellQuote(remoteSnapshot)} ${shellQuote(dirname(remoteRepo))}${ownership}`,
    ]);
    run("scp", [bundle, patch, archive, `${host.target}:${remoteSnapshot}/`]);
    const user = host.defaultUser;
    const inner = [
      `if ! git -C ${shellQuote(remoteRepo)} rev-parse --git-dir >/dev/null 2>&1; then gh repo clone ${shellQuote(slug)} ${shellQuote(remoteRepo)}; fi`,
      `git -C ${shellQuote(remoteRepo)} fetch origin --prune`,
      `git -C ${shellQuote(remoteRepo)} fetch ${shellQuote(join(remoteSnapshot, "workspace.bundle"))} HEAD:${shellQuote(ref)}`,
    ].join(" && ");
    run("ssh", [host.target, user ? `sudo -iu ${shellQuote(user)} bash -lc ${shellQuote(inner)}` : inner]);
    return {
      repo: remoteRepo,
      cwd: undefined,
      baseRef: ref,
      isolate: true,
      workspaceSource: root,
      workspacePatchPath: diff.stdout.length ? join(remoteSnapshot, "workspace.patch") : undefined,
      workspaceArchivePath: join(remoteSnapshot, "untracked.tar"),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function appendRemoteMessage(host: HostConfig, message: MafiaMessage): void {
  if (host.kind !== "ssh" || !host.target) return;
  const encoded = Buffer.from(`${JSON.stringify(message)}\n`).toString("base64");
  const path = join(host.stateRoot, "jobs", message.to ?? "", "inbox.jsonl");
  const ownership = host.defaultUser ? ` && chown ${shellQuote(host.defaultUser)} ${shellQuote(path)}` : "";
  run("ssh", [
    host.target,
    `mkdir -p ${shellQuote(dirname(path))} && printf %s ${shellQuote(encoded)} | base64 -d >> ${shellQuote(path)}${ownership}`,
  ]);
}

export function appendRemoteControl(host: HostConfig, id: string, event: MafiaEvent): void {
  if (host.kind !== "ssh" || !host.target) return;
  const encoded = Buffer.from(`${JSON.stringify(event)}\n`).toString("base64");
  const path = join(host.stateRoot, "jobs", id, "control.jsonl");
  const ownership = host.defaultUser ? ` && chown ${shellQuote(host.defaultUser)} ${shellQuote(path)}` : "";
  run("ssh", [
    host.target,
    `mkdir -p ${shellQuote(dirname(path))} && printf %s ${shellQuote(encoded)} | base64 -d >> ${shellQuote(path)}${ownership}`,
  ]);
}

export function discoverRemoteEvents(host: HostConfig): { events: MafiaEvent[]; messages: MafiaMessage[] } {
  if (host.kind !== "ssh" || !host.target) return { events: [], messages: [] };
  const audit = join(host.stateRoot, "events", "audit.jsonl");
  const messages = join(host.stateRoot, "events", "messages.jsonl");
  const raw = run("ssh", [
    host.target,
    `printf '%s\\n' __MAFIA_EVENTS__; tail -n 10000 ${shellQuote(audit)} 2>/dev/null || true; ` +
      `printf '%s\\n' __MAFIA_MESSAGES__; tail -n 10000 ${shellQuote(messages)} 2>/dev/null || true`,
  ]);
  const [eventRaw = "", messageRaw = ""] = raw
    .split("__MAFIA_MESSAGES__")
    .map((part) => part.replace("__MAFIA_EVENTS__", "").trim());
  return {
    events: parseJsonLines<MafiaEvent>(eventRaw),
    messages: parseJsonLines<MafiaMessage>(messageRaw),
  };
}

export function resetRemoteWorktree(host: HostConfig, path: string, sha: string): void {
  if (host.kind !== "ssh" || !host.target) throw new Error("The host is not remote.");
  const inner = `git -C ${shellQuote(path)} reset --hard ${shellQuote(sha)} && git -C ${shellQuote(path)} clean -fd`;
  const command = host.defaultUser
    ? `sudo -iu ${shellQuote(host.defaultUser)} bash -lc ${shellQuote(inner)}`
    : inner;
  run("ssh", [host.target, command]);
}

export function compareRemoteBranches(
  host: HostConfig,
  worktree: string,
  left: string,
  right: string,
): string {
  if (host.kind !== "ssh" || !host.target) throw new Error("The host is not remote.");
  return run("ssh", [
    host.target,
    `git -C ${shellQuote(worktree)} diff --stat ${shellQuote(left)}...${shellQuote(right)} && ` +
      `git -C ${shellQuote(worktree)} diff --name-status ${shellQuote(left)}...${shellQuote(right)}`,
  ]);
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

function parseJsonLines<T>(raw: string): T[] {
  return raw.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}
