import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { HostConfig, JobSpec, JobStatus, MafiaEvent, MafiaMessage } from "./types";
import { loadConfig, repoRoot } from "./config";
import { run, shellQuote, toolEnvironment } from "./process";
import { withSshMultiplexing } from "./ssh";

const installedWorkers = new Map<string, string>();

/**
 * How long a recorded worker install is trusted without re-checking.
 *
 * The digest alone would be enough if nothing else could touch the remote file.
 * A bounded window means an out-of-band deletion repairs itself on the next
 * dispatch rather than waiting for someone to notice.
 */
const INSTALL_TRUST_MS = 30 * 60_000;

function installMarkerPath(host: HostConfig): string {
  return join(loadConfig().stateRoot, "cursors", `${host.name}-worker.json`);
}

function readInstallMarker(host: HostConfig): string | undefined {
  try {
    const value = JSON.parse(readFileSync(installMarkerPath(host), "utf8")) as { digest?: string; at?: number };
    if (!value.digest || !value.at) return undefined;
    return Date.now() - value.at < INSTALL_TRUST_MS ? value.digest : undefined;
  } catch {
    return undefined;
  }
}

function writeInstallMarker(host: HostConfig, digest: string): void {
  const path = installMarkerPath(host);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ digest, at: Date.now() })}\n`, { mode: 0o600 });
}

function localWorkerDigest(): string {
  try {
    return createHash("sha256").update(readFileSync(join(repoRoot, "worker", "worker.mjs"))).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Copy the worker to the host, at most once per worker version per process.
 *
 * `dispatchRemote` calls this for every job. A team of sixty-four tasks paid
 * for sixty-four identical copies, each of which cost three SSH round trips.
 * The digest check makes every call after the first free.
 */
export function installRemote(host: HostConfig, options: { force?: boolean } = {}): void {
  if (host.kind !== "ssh" || !host.target || !host.workerPath) return;
  const digest = localWorkerDigest();
  if (!options.force && digest && installedWorkers.get(host.name) === digest) return;
  // Each CLI invocation is a fresh process, so an in-memory record only helps a
  // team run. Copying the worker costs three round trips, which every single
  // dispatch was paying.
  if (!options.force && digest && readInstallMarker(host) === digest) {
    installedWorkers.set(host.name, digest);
    return;
  }
  run("ssh", [host.target, `mkdir -p ${shellQuote(dirname(host.workerPath))} ${shellQuote(host.stateRoot)}`]);
  run("scp", [join(repoRoot, "worker", "worker.mjs"), `${host.target}:${host.workerPath}`]);
  const ownership = host.defaultUser
    ? ` && chown -R ${shellQuote(host.defaultUser)} ${shellQuote(host.stateRoot)}`
    : "";
  run("ssh", [host.target, `chmod 755 ${shellQuote(host.workerPath)}${ownership}`]);
  if (digest) {
    installedWorkers.set(host.name, digest);
    writeInstallMarker(host, digest);
  }
}

/**
 * Start a job on a remote host in one round trip.
 *
 * The previous form made five: a directory, an scp for the spec, another scp
 * for the context pack, a chown, and the launch. Each costs about 70 ms on a
 * shared connection, and scp costs 288 ms because it negotiates its own
 * protocol even when the SSH channel is already open. Sending the files as one
 * base64 tar on stdin removes both problems, and a team dispatching sixty-four
 * tasks pays the difference sixty-four times.
 */
function planRemoteDispatch(host: HostConfig, spec: JobSpec): { target: string; script: string; payload: string } {
  if (host.kind !== "ssh" || !host.target || !host.workerPath) {
    throw new Error(`Host ${host.name} is not a complete SSH host.`);
  }
  installRemote(host);
  const remoteDir = join(host.stateRoot, "jobs", spec.id);
  const remoteSpec = join(remoteDir, "spec.json");
  const remoteValue = { ...spec };
  const snapshot = spec.repo && existsSync(spec.repo)
    ? prepareRemoteWorkspace(host, spec)
    : undefined;
  if (snapshot) Object.assign(remoteValue, snapshot);
  const carriesContext = Boolean(spec.contextPackPath && existsSync(spec.contextPackPath));
  if (carriesContext) remoteValue.contextPackPath = join(remoteDir, "context.md");

  // Stage both files in one temporary directory and ship them as a single
  // archive, so the payload stays one stdin stream whatever it contains.
  const stage = mkdtempSync(join(tmpdir(), `${spec.id}-out-`));
  let payload: string;
  try {
    writeFileSync(join(stage, "spec.json"), `${JSON.stringify(remoteValue, null, 2)}\n`, { mode: 0o600 });
    const members = ["spec.json"];
    if (carriesContext) {
      writeFileSync(join(stage, "context.md"), readFileSync(spec.contextPackPath!));
      members.push("context.md");
    }
    const archive = spawnSync("tar", ["-cf", "-", ...members], { cwd: stage, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error("Cannot package the job spec.");
    payload = archive.stdout.toString("base64");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  const user = host.harnessUsers?.[spec.harness] ?? host.defaultUser;
  const launch = [
    `nohup env -u OPENAI_API_KEY -u CODEX_API_KEY node ${shellQuote(host.workerPath)} ${shellQuote(remoteSpec)}`,
    `> ${shellQuote(join(remoteDir, "launcher.log"))} 2>&1 < /dev/null & echo $!`,
  ].join(" ");
  const script = [
    `mkdir -p ${shellQuote(remoteDir)}`,
    `base64 -d | tar -xf - -C ${shellQuote(remoteDir)}`,
    user ? `chown -R ${shellQuote(user)} ${shellQuote(remoteDir)}` : "true",
    user ? `sudo -iu ${shellQuote(user)} bash -lc ${shellQuote(launch)}` : launch,
  ].join(" && ");
  return { target: host.target, script, payload };
}

export function dispatchRemote(host: HostConfig, spec: JobSpec): number {
  const plan = planRemoteDispatch(host, spec);
  return Number(run("ssh", [plan.target, plan.script], { input: plan.payload }));
}

/**
 * The same dispatch, with the remote launch awaited instead of blocked on.
 *
 * `spawnSync` holds the event loop, so a scheduler starting a wave of tasks
 * could only ever launch them one after another. Everything before the launch
 * is local and fast; only this last step is worth overlapping.
 */
export async function dispatchRemoteAsync(host: HostConfig, spec: JobSpec): Promise<number> {
  const plan = planRemoteDispatch(host, spec);
  const child = Bun.spawn(["ssh", ...withSshMultiplexing("ssh", [plan.target, plan.script])], {
    stdin: new TextEncoder().encode(plan.payload),
    stdout: "pipe",
    stderr: "pipe",
    env: toolEnvironment(),
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error((err || out || "ssh failed").trim());
  return Number(out.trim());
}

export function repoSlugFromOrigin(origin: string): string | undefined {
  const normalized = origin.trim().replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * Build the workspace snapshot once per distinct repository state.
 *
 * The previous form keyed the snapshot by job id, so a team of sixty-four tasks
 * on one repository created sixty-four byte-identical bundles. On
 * ai-memoryless-client that is 2.7 GB transferred and 82 seconds of
 * `git bundle create` to send the same commits over and over.
 *
 * The key is derived from the commit and the working-tree changes, which are
 * all cheap to compute. The expensive bundle is built only when the remote
 * cannot already reach the commit, and only when no earlier dispatch has
 * already staged that exact state.
 */
function prepareRemoteWorkspace(host: HostConfig, spec: JobSpec): Partial<JobSpec> | undefined {
  if (!host.target || !spec.repo) return undefined;
  const root = run("git", ["-C", spec.repo, "rev-parse", "--show-toplevel"]);
  const origin = run("git", ["-C", root, "remote", "get-url", "origin"]);
  const slug = repoSlugFromOrigin(origin);
  if (!slug) throw new Error(`Cannot map the Git remote for ${root} to the VPS.`);
  const user = host.defaultUser;
  const remoteRepo = `/home/${user ?? "usman"}/mafia-workspaces/${slug}`;
  const head = run("git", ["-C", root, "rev-parse", "HEAD"]);

  const temp = mkdtempSync(join(tmpdir(), `mafia-snap-`));
  const bundle = join(temp, "workspace.bundle");
  const patch = join(temp, "workspace.patch");
  const archive = join(temp, "untracked.tar");
  try {
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

    const key = createHash("sha256")
      .update(head)
      .update(createHash("sha256").update(diff.stdout).digest())
      .update(createHash("sha256").update(readFileSync(archive)).digest())
      .digest("hex")
      .slice(0, 16);
    const remoteSnapshot = join(host.stateRoot, "snapshots", key);
    const ref = `refs/mafia/snapshots/${key}`;
    const asUser = (inner: string) => (user ? `sudo -iu ${shellQuote(user)} bash -lc ${shellQuote(inner)}` : inner);

    // One probe answers both questions: is this exact state already staged, and
    // can the clone reach the commit without a bundle?
    const probe = run("ssh", [host.target, [
      `mkdir -p ${shellQuote(remoteSnapshot)} ${shellQuote(dirname(remoteRepo))} 2>/dev/null`,
      user ? `chown -R ${shellQuote(user)} ${shellQuote(remoteSnapshot)} ${shellQuote(dirname(remoteRepo))} 2>/dev/null` : "true",
      `if [ -f ${shellQuote(join(remoteSnapshot, ".done"))} ]; then printf 'STAGED\n'; else printf 'MISSING\n'; fi`,
      `if git -C ${shellQuote(remoteRepo)} cat-file -e ${shellQuote(head)}^{commit} 2>/dev/null; then printf 'HASCOMMIT\n'; else printf 'NOCOMMIT\n'; fi`,
    ].join("; ")]);
    const staged = probe.includes("STAGED");
    const hasCommit = probe.includes("HASCOMMIT");

    if (!staged) {
      const files = [patch, archive];
      if (!hasCommit) {
        // Only pay for history the remote does not already have.
        run("git", ["-C", root, "bundle", "create", bundle, "HEAD"]);
        files.unshift(bundle);
      }
      run("scp", [...files, `${host.target}:${remoteSnapshot}/`]);
      const steps = [
        `if ! git -C ${shellQuote(remoteRepo)} rev-parse --git-dir >/dev/null 2>&1; then gh repo clone ${shellQuote(slug)} ${shellQuote(remoteRepo)}; fi`,
        `git -C ${shellQuote(remoteRepo)} fetch origin --prune`,
        hasCommit
          ? `git -C ${shellQuote(remoteRepo)} update-ref ${shellQuote(ref)} ${shellQuote(head)}`
          : `git -C ${shellQuote(remoteRepo)} fetch ${shellQuote(join(remoteSnapshot, "workspace.bundle"))} HEAD:${shellQuote(ref)}`,
        // The marker is written last, so an interrupted stage is retried rather
        // than reused as if it were complete.
        `touch ${shellQuote(join(remoteSnapshot, ".done"))}`,
      ].join(" && ");
      run("ssh", [host.target, asUser(steps)]);
    }

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

function jobCursorPath(host: HostConfig): string {
  return join(loadConfig().stateRoot, "cursors", `${host.name}-jobs.json`);
}

function readJobCursor(host: HostConfig): number {
  try {
    return Number(JSON.parse(readFileSync(jobCursorPath(host), "utf8")).seconds) || 0;
  } catch {
    return 0;
  }
}

function writeJobCursor(host: HostConfig, seconds: number): void {
  const path = jobCursorPath(host);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ seconds })}\n`, { mode: 0o600 });
}

interface StreamCursor {
  events: number;
  messages: number;
}

function cursorPath(host: HostConfig): string {
  return join(loadConfig().stateRoot, "cursors", `${host.name}.json`);
}

function readCursor(host: HostConfig): StreamCursor {
  try {
    const value = JSON.parse(readFileSync(cursorPath(host), "utf8")) as Partial<StreamCursor>;
    return { events: Number(value.events) || 0, messages: Number(value.messages) || 0 };
  } catch {
    return { events: 0, messages: 0 };
  }
}

function writeCursor(host: HostConfig, cursor: StreamCursor): void {
  const path = cursorPath(host);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
}

/**
 * Read the audit and message streams from the byte offset of the last read.
 *
 * The previous form sent `tail -n 10000` on every call. The audit file grows
 * without limit, so a single status refresh moved 2.27 MB and re-inserted more
 * than twelve thousand rows that the database already held. A byte cursor sends
 * only the lines written since the last call.
 *
 * The remote size is read first. A size below the cursor means the file was
 * rotated or truncated, so the cursor resets to zero and the next read starts
 * from the beginning of the new file.
 */
/**
 * Read one stream slice as base64.
 *
 * The remote measures the file, clamps the cursor, and sends exactly the bytes
 * between the cursor and that measured size. base64 keeps the payload free of
 * newlines, so the transport cannot change the byte count that the caller uses
 * to advance the cursor.
 */
function sliceCommand(path: string, from: number, sizeVar: string): string {
  return [
    `${sizeVar}=$(wc -c < ${shellQuote(path)} 2>/dev/null || echo 0)`,
    `F=${from}`,
    `[ "$${sizeVar}" -lt "$F" ] && F=0`,
    `printf '%s %s %s\\n' OFFSET "$F" "$${sizeVar}"`,
    `if [ "$${sizeVar}" -gt "$F" ]; then tail -c +$((F + 1)) ${shellQuote(path)} 2>/dev/null | head -c $(($${sizeVar} - F)) | base64 -w0; fi`,
    `printf '\\n'`,
  ].join("; ");
}

export function decodeSlice(block: string): { from: number; to: number; text: string } {
  const [header = "", payload = ""] = block.split("\n", 2);
  const match = header.match(/^OFFSET (\d+) (\d+)$/);
  if (!match) return { from: 0, to: 0, text: "" };
  return {
    from: Number(match[1]),
    to: Number(match[2]),
    text: payload ? Buffer.from(payload, "base64").toString("utf8") : "",
  };
}

/**
 * Advance a cursor past whole lines only.
 *
 * A measured file size can land inside a line that the writer had not finished
 * appending. Stopping at the last newline makes that line arrive whole on the
 * next read instead of being split and dropped.
 */
export function wholeLines(from: number, text: string): { consumed: number; text: string } {
  const end = text.lastIndexOf("\n");
  if (end < 0) return { consumed: from, text: "" };
  const complete = text.slice(0, end + 1);
  return { consumed: from + Buffer.byteLength(complete, "utf8"), text: complete };
}

/**
 * Read the audit and message streams from the byte offset of the last read.
 *
 * The previous form sent `tail -n 10000` on every call. The audit file grows
 * without limit, so a single status refresh moved 2.27 MB and re-inserted more
 * than twelve thousand rows that the database already held. A byte cursor sends
 * only the lines written since the last call.
 */
export function discoverRemoteEvents(host: HostConfig): { events: MafiaEvent[]; messages: MafiaMessage[] } {
  if (host.kind !== "ssh" || !host.target) return { events: [], messages: [] };
  const audit = join(host.stateRoot, "events", "audit.jsonl");
  const messages = join(host.stateRoot, "events", "messages.jsonl");
  const cursor = readCursor(host);
  const raw = run("ssh", [
    host.target,
    [
      `{ ${sliceCommand(audit, cursor.events, "A")}; }`,
      `printf '%s\\n' __MAFIA_SPLIT__`,
      `{ ${sliceCommand(messages, cursor.messages, "M")}; }`,
    ].join("; "),
  ]);
  const [eventBlock = "", messageBlock = ""] = raw.split("__MAFIA_SPLIT__\n");
  const eventSlice = decodeSlice(eventBlock);
  const messageSlice = decodeSlice(messageBlock);
  const eventLines = wholeLines(eventSlice.from, eventSlice.text);
  const messageLines = wholeLines(messageSlice.from, messageSlice.text);
  writeCursor(host, { events: eventLines.consumed, messages: messageLines.consumed });
  return {
    events: parseJsonLines<MafiaEvent>(eventLines.text),
    messages: parseJsonLines<MafiaMessage>(messageLines.text),
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

/**
 * Fetch remote job status, skipping files that have not been written since the
 * last read.
 *
 * Concatenating every `status.json` moved 1.33 MB per poll on a host with a
 * hundred finished jobs, none of which can change again. A finished job's file
 * is never rewritten, so its modification time is a reliable filter.
 *
 * The cutoff comes from the remote's own clock, read before the search, so a
 * write that lands mid-read is picked up next time instead of being skipped by
 * clock skew between the two hosts.
 */
export function discoverRemote(host: HostConfig, options: { full?: boolean } = {}): JobStatus[] {
  if (host.kind !== "ssh" || !host.target) return [];
  const jobs = join(host.stateRoot, "jobs");
  const cursor = options.full ? 0 : readJobCursor(host);
  const find = cursor
    ? `find ${shellQuote(jobs)} -mindepth 2 -maxdepth 2 -name status.json -type f -newermt @${cursor} -print0 2>/dev/null`
    : `find ${shellQuote(jobs)} -mindepth 2 -maxdepth 2 -name status.json -type f -print0 2>/dev/null`;
  const raw = run("ssh", [
    host.target,
    `printf 'CURSOR %s\n' "$(date +%s)"; ${find} | xargs -0 -r cat`,
  ]);
  const stamp = raw.match(/^CURSOR (\d+)/);
  // Overlap by two seconds so a file written during this read is not missed.
  if (stamp) writeJobCursor(host, Math.max(0, Number(stamp[1]) - 2));
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
