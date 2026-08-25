import { spawn, spawnSync } from "node:child_process";

export function codexOAuthEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  return environment;
}

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
