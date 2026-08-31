import { createHash } from "node:crypto";
import { loadConfig } from "./config";
import { run, shellQuote } from "./process";
import { TelemetryStore } from "./telemetry-store";
import type { HostConfig } from "./types";

export interface PrObservation {
  id: string;
  observedAt: string;
  state: string;
  count: number;
}

/**
 * Read the automerge watcher's log into pull-request state observations.
 *
 * Everything else recorded here measures effort: tokens, latency, tool calls.
 * None of it says whether the work landed. The watcher writes a line each time
 * it checks, naming how many pull requests sat in each state, which is the only
 * record of outcome the fleet keeps.
 *
 * A line looks like:
 *   2026-08-31 22:33:28Z  pass: awaiting-approval=1  checks-pending=1
 */
export function parseAutomergeLog(text: string): PrObservation[] {
  const out: PrObservation[] = [];
  for (const line of text.split("\n")) {
    const stamp = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})Z/);
    if (!stamp) continue;
    const observedAt = `${stamp[1]}T${stamp[2]}.000Z`;
    for (const pair of line.matchAll(/([a-z][a-z-]+)=(\d+)/g)) {
      const state = pair[1]!;
      const count = Number(pair[2]);
      if (!Number.isFinite(count)) continue;
      // The timestamp and state together identify one observation, so a log
      // read twice cannot inflate the counts.
      out.push({
        id: createHash("sha1").update(`${observedAt} ${state}`).digest("hex").slice(0, 20),
        observedAt,
        state,
        count,
      });
    }
  }
  return out;
}

export function ingestPrOutcomes(host: HostConfig, stateRoot = loadConfig().stateRoot): { observations: number; added: number; detail: string } {
  if (host.kind !== "ssh" || !host.target) return { observations: 0, added: 0, detail: `${host.name} is not reachable.` };
  const user = host.defaultUser ?? "usman";
  const log = `/home/${user}/pr-watch/automerge.log`;
  let text: string;
  try {
    // Only the recent tail matters; the log grows without bound.
    text = run("ssh", [host.target, `tail -n 20000 ${shellQuote(log)} 2>/dev/null || true`]);
  } catch (error) {
    return { observations: 0, added: 0, detail: error instanceof Error ? error.message.slice(0, 140) : String(error) };
  }
  const observations = parseAutomergeLog(text);
  const added = new TelemetryStore(stateRoot).recordPrStates(observations);
  return { observations: observations.length, added, detail: observations.length ? "" : "The watcher log had no readable lines." };
}
