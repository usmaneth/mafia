import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { withSshMultiplexing } from "./ssh";

/**
 * Directories that hold the harness binaries.
 *
 * launchd and systemd start a process with a minimal PATH. `omp`, `bun`, and
 * the other harnesses live in per-user directories that the minimal PATH omits,
 * so a timer-started run cannot find them. Every scheduled Mafia command must
 * use this PATH.
 */
function stableToolDirectories(home: string): string[] {
  return [
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

export function toolPath(source: NodeJS.ProcessEnv = process.env): string {
  const home = source.HOME ?? homedir();
  const current = (source.PATH ?? "").split(":").filter(Boolean);
  return [...new Set([...current, ...stableToolDirectories(home)])].join(":");
}

/**
 * The PATH to write into a timer unit.
 *
 * A unit file outlives the shell that created it. Writing the current PATH into
 * it would bake in session-specific directories that later point at removed
 * plugin versions, so this uses only the stable directories.
 */
export function persistedToolPath(source: NodeJS.ProcessEnv = process.env): string {
  return stableToolDirectories(source.HOME ?? homedir()).join(":");
}

export function toolEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...source, PATH: toolPath(source) };
}

export function codexOAuthEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  return environment;
}

/**
 * The output limit for one child process.
 *
 * The default is one megabyte. `discoverRemote` concatenates every remote job
 * status, which passes that limit at about eighty jobs. On overflow spawnSync
 * truncates the output and reports a null exit status, so the caller raised the
 * truncated output as if it were an error message.
 */
const maxOutputBytes = 64 * 1024 * 1024;

export function run(command: string, args: string[], options: { cwd?: string; input?: string } = {}) {
  const result = spawnSync(command, withSshMultiplexing(command, args), {
    cwd: options.cwd,
    input: options.input,
    env: toolEnvironment(),
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Report a spawn failure as itself. Without this an overflow or a missing
  // binary is reported as whatever partial text the child had produced.
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout.trim();
}

export function spawnDetached(
  command: string,
  args: string[],
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error(`Failed to start ${command}.`);
  return child.pid;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
