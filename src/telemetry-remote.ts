import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadConfig } from "./config";
import { run, shellQuote } from "./process";
import { TelemetryStore } from "./telemetry-store";
import type { HostConfig } from "./types";

export interface RemoteIngestReport {
  host: string;
  remoteTurns: number;
  merged: number;
  bytesTransferred: number;
  ms: number;
  detail: string;
}

/**
 * Ingest a host's telemetry where the telemetry is, then bring back the result.
 *
 * The VPS holds about 1.6 GB of session history. Copying that to read it would
 * move a thousand times more bytes than the answer is worth, so the ingester
 * runs there — Mafia is already mirrored to the host and Bun is installed — and
 * only the compact database comes back.
 */
export function ingestRemoteTelemetry(host: HostConfig, options: { maxBytes?: number } = {}): RemoteIngestReport {
  const started = Date.now();
  const empty: RemoteIngestReport = {
    host: host.name, remoteTurns: 0, merged: 0, bytesTransferred: 0, ms: 0, detail: "",
  };
  if (host.kind !== "ssh" || !host.target) {
    return { ...empty, detail: `${host.name} is not a reachable SSH host.` };
  }
  const user = host.defaultUser ?? "usman";
  const remoteRepo = `/home/${user}/mafia`;
  const budget = options.maxBytes ?? 512 * 1024 * 1024;
  const inner = [
    `cd ${shellQuote(remoteRepo)}`,
    `bun src/cli.ts history --ingest --max-bytes ${budget} --json`,
  ].join(" && ");

  let output: string;
  try {
    output = run("ssh", [host.target, `sudo -iu ${shellQuote(user)} bash -lc ${shellQuote(inner)}`]);
  } catch (error) {
    return { ...empty, ms: Date.now() - started, detail: error instanceof Error ? error.message.slice(0, 160) : String(error) };
  }

  // Pull the database rather than the sessions. It is two orders of magnitude
  // smaller and already carries only the fields that matter.
  const remoteDb = `/home/${user}/.local/share/mafia/telemetry.db`;
  const temp = mkdtempSync(join(tmpdir(), "mafia-tel-"));
  const localCopy = join(temp, "remote.db");
  try {
    // A live WAL database cannot be copied file by file and stay consistent.
    // `VACUUM INTO` writes a settled snapshot.
    const snapshot = `/tmp/mafia-telemetry-snapshot.db`;
    run("ssh", [host.target, `sudo -iu ${shellQuote(user)} bash -lc ${shellQuote(
      `rm -f ${snapshot} && sqlite3 ${remoteDb} "VACUUM INTO '${snapshot}'"`,
    )}`]);
    run("scp", [`${host.target}:${snapshot}`, localCopy]);
    run("ssh", [host.target, `rm -f ${snapshot}`]);
    if (!existsSync(localCopy)) return { ...empty, ms: Date.now() - started, detail: "No database came back." };

    const store = new TelemetryStore(loadConfig().stateRoot);
    const bytes = Bun.file(localCopy).size;
    // Turn ids are content hashes, so a repeated merge cannot double count.
    store.db.exec(`ATTACH DATABASE '${localCopy.replaceAll("'", "''")}' AS remote`);
    let merged = 0;
    let remoteTurns = 0;
    try {
      remoteTurns = (store.db.query("SELECT COUNT(*) c FROM remote.turns").get() as { c: number }).c;
      merged = store.db.query(`
        INSERT OR IGNORE INTO turns (
          id,harness,host,session_id,started_at,model,provider,cwd,input_tokens,output_tokens,
          cache_read_tokens,cache_write_tokens,reasoning_tokens,ttft_ms,duration_ms,tool_name,ok
        )
        SELECT id,harness,?,session_id,started_at,model,provider,cwd,input_tokens,output_tokens,
          cache_read_tokens,cache_write_tokens,reasoning_tokens,ttft_ms,duration_ms,tool_name,ok
        FROM remote.turns
      `).run(host.name).changes;
    } finally {
      store.db.exec("DETACH DATABASE remote");
    }
    return {
      host: host.name,
      remoteTurns,
      merged,
      bytesTransferred: bytes,
      ms: Date.now() - started,
      detail: output.split("\n").at(-1)?.slice(0, 120) ?? "",
    };
  } catch (error) {
    return { ...empty, ms: Date.now() - started, detail: error instanceof Error ? error.message.slice(0, 160) : String(error) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function formatRemoteIngest(reports: RemoteIngestReport[]): string {
  return reports.map((report) =>
    `  ${report.host.padEnd(8)} ${String(report.merged).padStart(7)} new of ${String(report.remoteTurns).padStart(7)} remote turns  ` +
    `${(report.bytesTransferred / 1_048_576).toFixed(1)} MB moved  ${report.ms}ms` +
    (report.detail && !report.merged ? `\n           ${report.detail}` : "")).join("\n");
}
