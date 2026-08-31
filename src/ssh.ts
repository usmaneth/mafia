import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const controlDirectory = join(tmpdir(), "mafia-ssh");

// A Unix socket path must stay below the platform limit of about 104 bytes, so
// the control path uses a short digest instead of the host name.
export function controlPath(target: string): string {
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  return join(controlDirectory, `${createHash("sha256").update(target).digest("hex").slice(0, 12)}.sock`);
}

/**
 * Connection-reuse options.
 *
 * `ConnectTimeout` is not optional here. A shared master that stalls makes
 * every later client wait on the same socket, so without a bound one degraded
 * link turns a two-second command into an hour-long hang. ssh keeps the first
 * value it is given for an option, so a caller that already set its own
 * timeout must not be overridden.
 */
export function sshControlOptions(target: string, hasOwnTimeout = false): string[] {
  if (process.env.MAFIA_SSH_MULTIPLEX === "0") return [];
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath(target)}`,
    "-o", "ControlPersist=300",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    ...(hasOwnTimeout ? [] : ["-o", "ConnectTimeout=15"]),
  ];
}

/**
 * Find the remote endpoint in an argument list.
 *
 * Only a `user@host` value counts. A bare word can be a local file name, and a
 * wrong guess would point the control socket at the wrong endpoint.
 */
function targetOf(args: string[]): string | undefined {
  for (const value of args) {
    if (value.startsWith("-")) continue;
    const remote = value.includes(":") ? value.slice(0, value.indexOf(":")) : value;
    if (remote.includes("@") && !remote.includes("/")) return remote;
  }
  return undefined;
}

/**
 * Add connection reuse to an ssh, scp, or rsync invocation.
 *
 * Every SSH connection to the VPS costs about 580 ms of handshake. A single job
 * dispatch opens ten of them. One shared master connection removes that cost
 * from every call after the first.
 */
export function withSshMultiplexing(command: string, args: string[]): string[] {
  if (process.env.MAFIA_SSH_MULTIPLEX === "0") return args;
  const target = targetOf(args);
  if (!target) return args;
  const hasOwnTimeout = args.some((value) => value.startsWith("ConnectTimeout="));
  if (command === "ssh" || command === "scp") {
    if (args.some((value) => value.startsWith("ControlPath=") || value === "ControlPath")) return args;
    return [...sshControlOptions(target, hasOwnTimeout), ...args];
  }
  if (command === "rsync") {
    if (args.includes("-e")) return args;
    const transport = ["ssh", ...sshControlOptions(target, hasOwnTimeout)].join(" ");
    return ["-e", transport, ...args];
  }
  return args;
}
