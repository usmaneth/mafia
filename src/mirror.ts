import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, repoRoot } from "./config";
import { toolEnvironment } from "./process";
import { withSshMultiplexing } from "./ssh";
import type { HostConfig, MirrorReport, MirrorVerdict } from "./types";

/**
 * Paths that must never cross the mirror.
 *
 * `.git` stays local because each side keeps its own object store. The other
 * entries are host-specific build output or private state.
 */
export const mirrorExcludes = [
  ".git",
  "node_modules",
  ".DS_Store",
  "*.log",
  ".env",
  ".env.*",
];


/**
 * The longest a single mirror pass may take.
 *
 * Per-command timeouts are not enough on their own. A degraded link makes every
 * step slow rather than failing outright, and eight slow steps in sequence run
 * far past any interval a five-minute timer can absorb.
 */
const mirrorDeadlineMs = 240_000;

class Deadline {
  private readonly endsAt: number;

  constructor(budgetMs: number) {
    this.endsAt = Date.now() + budgetMs;
  }

  remaining(): number {
    return this.endsAt - Date.now();
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }

  /** The time a step may take: its own limit, or what is left, whichever is less. */
  allow(timeout: number): number {
    return Math.max(1, Math.min(timeout, this.remaining()));
  }
}

function asRemoteUser(host: HostConfig, inner: string): string {
  return host.defaultUser ? `sudo -iu ${JSON.stringify(host.defaultUser)} bash -lc ${JSON.stringify(inner)}` : inner;
}

function shell(
  command: string,
  args: string[],
  timeout = 120_000,
  deadline?: Deadline,
): { ok: boolean; output: string } {
  if (deadline?.expired()) return { ok: false, output: "The mirror ran out of time." };
  const result = spawnSync(command, withSshMultiplexing(command, args), {
    cwd: repoRoot,
    encoding: "utf8",
    env: toolEnvironment(),
    timeout: deadline ? deadline.allow(timeout) : timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) return { ok: false, output: output || result.error.message };
  return { ok: result.status === 0, output };
}

/**
 * Hold an exclusive claim on the mirror for this host.
 *
 * The timer fires every five minutes and a person can run `mafia mirror` at any
 * moment. Two `rsync --delete` passes against one target must never overlap.
 */
function acquireLock(stateRoot: string, host: string): (() => void) | undefined {
  const path = join(stateRoot, "locks", `mirror-${host}.pid`);
  mkdirSync(dirname(path), { recursive: true });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const held = Number(readFileSync(path, "utf8").trim());
    if (held && held !== process.pid && alive(held)) return undefined;
  } catch {}
  writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
  return () => {
    try {
      if (Number(readFileSync(path, "utf8").trim()) === process.pid) rmSync(path, { force: true });
    } catch {}
  };
}

/**
 * Build a shell fragment that prints one `sha256  path` line per mirrored file.
 *
 * The same fragment runs on both hosts, so a byte-for-byte match of the sorted
 * output proves the two trees are identical. This lets the timer skip the copy
 * when nothing changed, which is the common case.
 */
function manifestCommand(root: string): string {
  // The manifest must cover exactly what rsync copies. Hashing a narrower set
  // would let a change outside that set sit on one host forever, because the
  // digests would still match and the mirror would report "current".
  const prune = mirrorExcludes.map((value) => `-name ${JSON.stringify(value)}`).join(" -o ");
  const pipeline = [
    `find . \\( ${prune} \\) -prune -o -type f -print 2>/dev/null`,
    "LC_ALL=C sort",
    "xargs shasum -a 256 2>/dev/null",
  ].join(" | ");
  // The `cd` needs its own statement terminator. Joining it to the pipeline
  // with a space makes the shell read `exit 3 find ...`, which runs no find at
  // all and returns an empty manifest with a zero exit code.
  return `cd ${JSON.stringify(root)} 2>/dev/null || exit 3\n${pipeline}\n`;
}

function localManifest(): string {
  const result = spawnSync("sh", ["-c", manifestCommand(repoRoot)], {
    encoding: "utf8",
    env: toolEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
  });
  return (result.stdout ?? "").trim();
}

/**
 * Reject a manifest that lists nothing.
 *
 * An empty manifest means the listing failed, not that the tree is empty. Two
 * empty manifests hash the same, so without this check a broken listing on both
 * hosts reports a perfect match and the mirror silently copies nothing.
 */
function manifestIsUsable(value: string): boolean {
  return value.split("\n").filter(Boolean).length > 0;
}

function remoteManifest(host: HostConfig, root: string, deadline?: Deadline): { ok: boolean; value: string } {
  const inner = manifestCommand(root).replaceAll("shasum -a 256", "sha256sum");
  const result = shell("ssh", [host.target!, inner], 60_000, deadline);
  return { ok: result.ok, value: result.output };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function mirrorStatePath(stateRoot: string, host = "vps"): string {
  return join(stateRoot, "mirror", `${host}.json`);
}

export function readMirrorState(stateRoot: string, host = "vps"): MirrorReport | undefined {
  try {
    return JSON.parse(readFileSync(mirrorStatePath(stateRoot, host), "utf8")) as MirrorReport;
  } catch {
    return undefined;
  }
}

function writeMirrorState(stateRoot: string, report: MirrorReport): void {
  const path = mirrorStatePath(stateRoot, report.host);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Compare the file list a mirror would delete against the remote tree.
 *
 * The mirror copies with `--delete`, so a file that exists only on the VPS is
 * lost. `rsync --dry-run` names those files before any write happens. Work that
 * exists only on the remote host stops the mirror instead of being deleted.
 */
function remoteOnlyFiles(host: HostConfig, remoteRoot: string, deadline?: Deadline): string[] {
  const result = shell("rsync", [
    "-a", "--delete", "--dry-run", "--out-format=%o %n",
    ...mirrorExcludes.flatMap((value) => ["--exclude", value]),
    `${repoRoot}/`,
    `${host.target!}:${remoteRoot}/`,
  ], 180_000, deadline);
  if (!result.ok) return [];
  return result.output
    .split("\n")
    .filter((line) => line.startsWith("del. "))
    .map((line) => line.slice(5).trim())
    .filter((name) => Boolean(name) && !name.endsWith("/"));
}

/**
 * List the paths a checkout has changed, as bare paths.
 *
 * `git status --porcelain` prefixes every path with a two-character status and
 * a space. The output of this module is trimmed, which removes the leading
 * space of an unstaged entry and shifts that prefix by one, so a fixed-width
 * slice cuts into the path itself. `ls-files` prints the path alone.
 */
const dirtyArgs = ["ls-files", "--modified", "--others", "--deleted", "--exclude-standard"];

function remoteDirtyPaths(host: HostConfig, remoteRoot: string, deadline?: Deadline): string[] {
  const result = shell("ssh", [
    host.target!,
    `git -C ${JSON.stringify(remoteRoot)} ${dirtyArgs.join(" ")} 2>/dev/null || true`,
  ], 60_000, deadline);
  if (!result.ok) return [];
  return result.output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function localDirtyPaths(): string[] {
  const result = shell("git", dirtyArgs);
  if (!result.ok) return [];
  return result.output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export interface MirrorOptions {
  force?: boolean;
  dryRun?: boolean;
  host?: string;
}

/**
 * Make the VPS tree match the local tree.
 *
 * The local checkout is the source of truth. The mirror copies the working
 * tree, so uncommitted work reaches the VPS. It refuses to run when the VPS
 * holds a file the local tree does not, because `--delete` would destroy it.
 */
export function mirrorHost(host: HostConfig, options: MirrorOptions = {}): MirrorReport {
  const startedAt = Date.now();
  const deadline = new Deadline(mirrorDeadlineMs);
  const remoteRoot = `/home/${host.defaultUser ?? "usman"}/mafia`;
  const base: MirrorReport = {
    host: host.name,
    verdict: "error",
    detail: "",
    localDigest: "",
    remoteDigest: "",
    changedFiles: 0,
    conflicts: [],
    durationMs: 0,
    checkedAt: new Date().toISOString(),
  };

  const reachable = shell("ssh", [host.target!, "true"], 20_000, deadline);
  if (!reachable.ok) {
    return { ...base, verdict: "unreachable", detail: reachable.output || "The host did not answer.", durationMs: Date.now() - startedAt };
  }

  const local = localManifest();
  if (!manifestIsUsable(local)) {
    return {
      ...base,
      verdict: "error",
      detail: `Cannot list the local tree at ${repoRoot}. The mirror will not run against an empty listing.`,
      durationMs: Date.now() - startedAt,
    };
  }
  const remote = remoteManifest(host, remoteRoot, deadline);
  const remoteUsable = remote.ok && manifestIsUsable(remote.value);
  const localHash = digest(local);
  const remoteHash = remoteUsable ? digest(remote.value) : "";

  if (remoteUsable && localHash === remoteHash && !options.force) {
    return {
      ...base,
      verdict: "current",
      detail: "The VPS tree already matches the local tree.",
      localDigest: localHash,
      remoteDigest: remoteHash,
      durationMs: Date.now() - startedAt,
    };
  }

  // Only guard against changes the VPS made on its own. When its tree still
  // hashes to what the last pass left there, nothing has touched it since, so
  // every difference is local work waiting to be copied. Without this check the
  // guard fires on the mirror's own output: revert a file locally and the copy
  // still sitting on the VPS reads as remote-only work.
  const lastPass = readMirrorState(loadConfig().stateRoot, host.name);
  const untouchedSinceLastPass = Boolean(
    remoteUsable && lastPass?.remoteDigest && lastPass.remoteDigest === remoteHash,
  );
  const localDirty = new Set(localDirtyPaths());
  const deleted = untouchedSinceLastPass ? [] : remoteOnlyFiles(host, remoteRoot, deadline);
  // A file the VPS reports as untracked is only remote work if the local tree
  // does not have it. The mirror excludes `.git`, so the remote HEAD never
  // advances and every file added by a merge since its last pull shows up as
  // untracked there — files the mirror itself put on the host.
  const remoteOnlyEdits = untouchedSinceLastPass
    ? []
    : remoteDirtyPaths(host, remoteRoot, deadline)
      .filter((path) => !localDirty.has(path))
      .filter((path) => !existsSync(join(repoRoot, path)));
  const blocking = [...new Set([...deleted, ...remoteOnlyEdits])];

  if (blocking.length && !options.force) {
    return {
      ...base,
      verdict: "conflict",
      detail: `The VPS holds ${blocking.length} path(s) that the local tree does not. Resolve them or rerun with --force.`,
      localDigest: localHash,
      remoteDigest: remoteHash,
      conflicts: blocking.slice(0, 20),
      durationMs: Date.now() - startedAt,
    };
  }

  if (options.dryRun) {
    return {
      ...base,
      verdict: "drift",
      detail: "The trees differ. Rerun without --dry-run to copy.",
      localDigest: localHash,
      remoteDigest: remoteHash,
      conflicts: blocking.slice(0, 20),
      durationMs: Date.now() - startedAt,
    };
  }

  shell("ssh", [host.target!, `mkdir -p ${JSON.stringify(remoteRoot)}`], 30_000, deadline);
  const sync = shell("rsync", [
    "-a", "--delete", "--itemize-changes",
    ...mirrorExcludes.flatMap((value) => ["--exclude", value]),
    `${repoRoot}/`,
    `${host.target!}:${remoteRoot}/`,
  ], 300_000, deadline);
  if (!sync.ok) {
    return {
      ...base,
      verdict: "error",
      detail: sync.output || "rsync failed and printed nothing.",
      localDigest: localHash,
      remoteDigest: remoteHash,
      durationMs: Date.now() - startedAt,
    };
  }
  // rsync itemises an unchanged entry with a leading dot. Counting those made
  // a one-file edit report as the whole tree.
  const changedFiles = sync.output
    .split("\n")
    .filter((line) => /^[<>ch*]/.test(line) && !line.endsWith("/"))
    .length;

  // The worker runs from /opt/mafia, outside the repository. Deploy it in the
  // same step so the running worker can never differ from the mirrored source.
  if (host.workerPath) {
    shell("ssh", [host.target!, `mkdir -p ${JSON.stringify(dirname(host.workerPath))}`], 30_000, deadline);
    const worker = shell("scp", [join(repoRoot, "worker", "worker.mjs"), `${host.target!}:${host.workerPath}`], 60_000, deadline);
    if (!worker.ok) {
      return {
        ...base,
        verdict: "error",
        detail: worker.output || "Cannot copy the worker.",
        localDigest: localHash,
        remoteDigest: remoteHash,
        changedFiles,
        durationMs: Date.now() - startedAt,
      };
    }
    shell("ssh", [host.target!, `chmod 755 ${JSON.stringify(host.workerPath)}`], 30_000, deadline);
  }

  const owner = host.defaultUser;
  if (owner) {
    shell("ssh", [host.target!, `chown -R ${JSON.stringify(owner)} ${JSON.stringify(remoteRoot)}`], 120_000, deadline);
  }
  // Install when the dependency set changed. Excluding the lockfile kept the
  // copy small but meant a new dependency never reached the host: the tree
  // mirrored cleanly and then every command that imported it failed there.
  const manifestChanged = sync.output
    .split("\n")
    .some((line) => /\b(package\.json|bun\.lock)$/.test(line.trim()));
  if (manifestChanged) {
    const install = shell("ssh", [host.target!, asRemoteUser(host,
      `cd ${JSON.stringify(remoteRoot)} && bun install --frozen-lockfile`)], 300_000, deadline);
    if (!install.ok) {
      return {
        ...base,
        verdict: "error",
        detail: `Copied the tree, but installing dependencies failed: ${install.output.slice(0, 120)}`,
        localDigest: localHash,
        remoteDigest: remoteHash,
        changedFiles,
        durationMs: Date.now() - startedAt,
      };
    }
  }
  // Keep the remote refs current without touching the checkout. A fetch is safe
  // because it never moves HEAD or overwrites a file.
  shell("ssh", [host.target!, `git -C ${JSON.stringify(remoteRoot)} fetch --quiet origin 2>/dev/null || true`], 120_000, deadline);

  const verify = remoteManifest(host, remoteRoot, deadline);
  const verified = verify.ok && manifestIsUsable(verify.value) && digest(verify.value) === localHash;
  const verifiedHash = verify.ok && manifestIsUsable(verify.value) ? digest(verify.value) : "";
  return {
    ...base,
    verdict: verified ? "synced" : "error",
    detail: verified
      ? `Copied ${changedFiles} file(s) to ${remoteRoot}.`
      : "The copy finished but the VPS tree still differs from the local tree.",
    localDigest: localHash,
    remoteDigest: verifiedHash,
    changedFiles,
    durationMs: Date.now() - startedAt,
  };
}

export function mirrorAll(options: MirrorOptions = {}): MirrorReport[] {
  const config = loadConfig();
  const hosts = Object.values(config.hosts).filter((host) =>
    host.kind === "ssh" && host.target && (!options.host || host.name === options.host));
  const reports = hosts.map((host) => {
    const release = acquireLock(config.stateRoot, host.name);
    if (!release) {
      // Another pass owns this host. Say so and leave the stored state alone,
      // because the pass that holds the lock will write the real result.
      return {
        host: host.name,
        verdict: "locked" as const,
        detail: "Another mirror pass is already running for this host.",
        localDigest: "",
        remoteDigest: "",
        changedFiles: 0,
        conflicts: [],
        durationMs: 0,
        checkedAt: new Date().toISOString(),
      };
    }
    try {
      return mirrorHost(host, options);
    } finally {
      release();
    }
  });
  for (const report of reports) {
    // A locked pass has no result of its own. Storing it would overwrite the
    // state that the pass holding the lock is about to write.
    if (report.verdict !== "locked") writeMirrorState(config.stateRoot, report);
  }
  return reports;
}

export function mirrorIsHealthy(report: MirrorReport | undefined, maxAgeMs = 30 * 60_000): boolean {
  if (!report) return false;
  if (!["synced", "current"].includes(report.verdict)) return false;
  return Date.now() - new Date(report.checkedAt).getTime() < maxAgeMs;
}

export function formatMirror(reports: MirrorReport[]): string {
  const badge: Record<MirrorVerdict, string> = {
    synced: "synced  ",
    current: "current ",
    drift: "drift   ",
    conflict: "CONFLICT",
    unreachable: "OFFLINE ",
    locked: "locked  ",
    error: "ERROR   ",
  };
  return reports.map((report) => {
    const head = `${badge[report.verdict]} ${report.host}  ${report.detail}`;
    const timing = `         ${report.changedFiles} file(s), ${Math.round(report.durationMs)}ms, local=${report.localDigest || "-"} remote=${report.remoteDigest || "-"}`;
    const conflicts = report.conflicts.length
      ? `\n         remote-only: ${report.conflicts.join(", ")}`
      : "";
    return `${head}\n${timing}${conflicts}`;
  }).join("\n") || "no ssh hosts configured";
}

export function mirroredFileCount(): number {
  return localManifest().split("\n").filter(Boolean).length;
}

export function mirrorRepoRoot(): string {
  return repoRoot;
}

export function mirrorExists(): boolean {
  return existsSync(join(repoRoot, "worker", "worker.mjs"));
}

/**
 * Decide whether a filesystem event is worth a mirror pass.
 *
 * `.git` changes on every command Git runs, and `node_modules` churns on every
 * install. Neither crosses the mirror, so reacting to them would rebuild the
 * manifest constantly and never copy anything.
 */
export function watchTriggersMirror(relativePath: string): boolean {
  if (!relativePath) return false;
  const segments = relativePath.split(/[/\\]/);
  if (segments.some((part) => part === ".git" || part === "node_modules")) return false;
  const name = segments.at(-1) ?? "";
  if (name === ".DS_Store" || name.endsWith(".log")) return false;
  // Editors and Git write through a temporary name and rename. The rename
  // produces its own event, so the intermediate write is noise.
  if (/^\.?#|~$|\.tmp$|\.swp$|^\d+\.tmp$/.test(name)) return false;
  if (/\.\d+\.tmp$/.test(name)) return false;
  return true;
}

export interface WatchOptions extends MirrorOptions {
  /** Quiet period before a burst of edits counts as settled. */
  debounceMs?: number;
  /** Safety sweep, in case an event is ever missed. */
  sweepMs?: number;
  onReport?: (reports: MirrorReport[]) => void;
}

/**
 * Mirror on change instead of on a timer.
 *
 * A five-minute poll means the VPS can hold code five minutes old. Watching
 * costs nothing while idle and copies within a second of a save. The periodic
 * sweep stays as a backstop, because a missed event would otherwise leave the
 * two hosts apart until the next edit.
 */
export function watchMirror(options: WatchOptions = {}): () => void {
  const debounceMs = options.debounceMs ?? 750;
  const sweepMs = options.sweepMs ?? 5 * 60_000;
  const report = options.onReport ?? ((reports) => console.log(formatMirror(reports)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;

  const pass = () => {
    if (running) {
      // Never stack passes. Remember that work arrived and run once more after
      // the current pass finishes.
      queued = true;
      return;
    }
    running = true;
    try {
      report(mirrorAll(options));
    } catch (error) {
      console.error(`mirror: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(pass, debounceMs);
  };

  const watcher = watch(repoRoot, { recursive: true }, (_event, filename) => {
    if (filename && watchTriggersMirror(String(filename))) schedule();
  });
  const sweep = setInterval(pass, sweepMs);
  pass();

  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(sweep);
    watcher.close();
  };
}
