import { spawn, spawnSync } from "node:child_process";

export function run(command: string, args: string[], options: { cwd?: string; input?: string } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout.trim();
}

export function spawnDetached(command: string, args: string[], cwd?: string): number {
  const child = spawn(command, args, {
    cwd,
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
