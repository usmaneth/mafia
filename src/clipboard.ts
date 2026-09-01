import { spawnSync } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";

/**
 * Most terminals cap an OSC 52 payload around 100 KB of base64. Anything a
 * person copies out of a dashboard is a command, an id, or a URL, so the cap
 * is generous; text past it is truncated rather than silently dropped.
 */
const MAX_COPY_BYTES = 64 * 1024;

export interface CopyResult {
  ok: boolean;
  via: string;
  truncated: boolean;
}

/** The OSC 52 sequence that asks the terminal to set the system clipboard. */
export function osc52(text: string): string {
  return `]52;c;${Buffer.from(text, "utf8").toString("base64")}`;
}

/**
 * Put text on the system clipboard from inside a full-screen view.
 *
 * Two paths, both taken. `pbcopy` is certain when Mafia runs on the Mac
 * itself, but does nothing for a hub opened over SSH on the VPS. OSC 52 rides
 * the terminal connection, so it works remotely — tmux forwards it with
 * `set-clipboard external` — but the outer terminal must allow clipboard
 * access, which cannot be detected from here. Sending both means the copy
 * lands wherever it can.
 *
 * The escape sequence goes to /dev/tty, not stdout: a TUI owns stdout
 * mid-frame, and the controlling terminal is where the sequence must arrive
 * even when output is redirected.
 */
export function copyToClipboard(text: string): CopyResult {
  const truncated = Buffer.byteLength(text, "utf8") > MAX_COPY_BYTES;
  const payload = truncated ? Buffer.from(text, "utf8").subarray(0, MAX_COPY_BYTES).toString("utf8") : text;
  const via: string[] = [];

  if (process.platform === "darwin") {
    const result = spawnSync("pbcopy", [], { input: payload, timeout: 5_000 });
    if (!result.error && result.status === 0) via.push("pbcopy");
  }

  try {
    const tty = openSync("/dev/tty", "w");
    try {
      writeSync(tty, osc52(payload));
    } finally {
      closeSync(tty);
    }
    via.push("osc52");
  } catch {
    // No controlling terminal - a cron or piped context. pbcopy may still
    // have landed it.
  }

  return { ok: via.length > 0, via: via.join("+"), truncated };
}

export interface CopyTarget {
  label: string;
  text: string;
}

/** Render up to nine targets as a pick list a digit can address. */
export function formatCopyTargets(targets: CopyTarget[]): string[] {
  if (!targets.length) return ["  nothing here to copy"];
  return targets.slice(0, 9).map((target, index) =>
    `  [${index + 1}] ${target.label.padEnd(26).slice(0, 26)} ${target.text.slice(0, 60)}`);
}
