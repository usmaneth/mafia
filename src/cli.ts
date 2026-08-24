#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { ensureConfig, loadConfig, resolveHost } from "./config";
import { formatJobs, formatTeam, formatTeams } from "./format";
import { isHarnessName } from "./harnesses";
import { buildOmpArgs } from "./launch";
import { installRemote } from "./remote";
import { MafiaService } from "./service";
import { TeamService } from "./team";
import type { JobState, PipelineSpec } from "./types";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.log(`mafia - OMP team orchestration

usage:
  mafia                         start OMP with the Mafia profile
  mafia jobs [--json] [--state STATE]
  mafia status
  mafia watch [--interval SECONDS]
  mafia dispatch --harness NAME --prompt TEXT [--host NAME] [--repo PATH]
  mafia logs JOB [--lines N]
  mafia cancel JOB
  mafia handoff JOB --harness NAME [--host NAME] [--prompt TEXT]
  mafia team start --file TEAM.json
  mafia team list [--json]
  mafia team status TEAM [--json]
  mafia team collect TEAM
  mafia team cancel TEAM
  mafia sync [--discover]
  mafia hosts
  mafia install-remote HOST
  mafia eval [--live]
  mafia doctor

Mafia supports 128 tasks in one team. OMP remains the main interface.`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  ensureConfig();
  const command = argv[0];
  const controlCommands = new Set([
    "help", "-h", "--help", "jobs", "status", "watch", "dispatch", "logs", "cancel", "handoff",
    "team", "sync", "hosts", "install-remote", "eval", "__team-run", "doctor",
  ]);
  if (!command || command === "shell" || command === "run" || !controlCommands.has(command)) {
    const { spawnSync } = await import("node:child_process");
    const extra = command === "shell" || command === "run" ? argv.slice(1) : argv;
    const result = spawnSync("omp", buildOmpArgs(extra), { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
    return;
  }
  if (["help", "-h", "--help"].includes(command)) return usage();

  const mafia = new MafiaService();
  const teams = new TeamService();
  const args = argv.slice(1);

  switch (command) {
    case "jobs": {
      const jobs = mafia.list(Number(option(args, "--limit") ?? 50), option(args, "--state") as JobState | undefined);
      has(args, "--json") ? printJson(jobs) : console.log(formatJobs(jobs));
      return;
    }
    case "status":
      console.log(formatTeams(teams.list(30)));
      console.log("");
      console.log(formatJobs(mafia.list(100)));
      return;
    case "watch": {
      const interval = Math.max(1, Number(option(args, "--interval") ?? 2));
      while (true) {
        process.stdout.write("\x1b[2J\x1b[H");
        console.log(formatTeams(teams.list(30)));
        console.log("");
        console.log(formatJobs(mafia.list(100)));
        console.log(`\nrefresh: ${interval}s - press Ctrl-C to stop`);
        await Bun.sleep(interval * 1000);
      }
    }
    case "dispatch": {
      const prompt = required(option(args, "--prompt"), "--prompt is required.");
      const job = mafia.dispatch({
        title: option(args, "--title"),
        prompt,
        harness: option(args, "--harness"),
        host: option(args, "--host"),
        repo: option(args, "--repo"),
        cwd: option(args, "--cwd"),
        model: option(args, "--model"),
        baseRef: option(args, "--base"),
        isolate: has(args, "--no-isolate") ? false : undefined,
        labels: option(args, "--labels")?.split(",").filter(Boolean),
        timeoutSeconds: option(args, "--timeout") ? Number(option(args, "--timeout")) : undefined,
      });
      has(args, "--json") ? printJson(job) : console.log(`${job.id} ${job.harness}@${job.host} ${job.state}`);
      return;
    }
    case "logs": {
      const id = required(args[0], "The job ID is required.");
      console.log(mafia.logs(id, Number(option(args, "--lines") ?? 100)));
      return;
    }
    case "cancel":
      mafia.cancel(required(args[0], "The job ID is required."));
      console.log("cancel signal sent");
      return;
    case "handoff": {
      const id = required(args[0], "The job ID is required.");
      const harness = required(option(args, "--harness"), "--harness is required.");
      if (!isHarnessName(harness)) throw new Error(`Unknown harness: ${harness}`);
      const job = mafia.handoff(id, harness, option(args, "--host"), option(args, "--prompt"));
      has(args, "--json") ? printJson(job) : console.log(`${job.id} ${job.harness}@${job.host} ${job.state}`);
      return;
    }
    case "team": {
      const action = args[0];
      if (action === "start") {
        const file = required(option(args, "--file"), "--file is required.");
        const input = JSON.parse(readFileSync(file, "utf8")) as PipelineSpec & { goal?: string };
        const team = teams.create(input.goal ?? input.name, input);
        has(args, "--json") ? printJson(team) : console.log(formatTeam(team));
      } else if (action === "list") {
        const list = teams.list();
        has(args, "--json") ? printJson(list) : console.log(formatTeams(list));
      } else if (action === "status") {
        const team = teams.get(required(args[1], "The team ID is required."));
        has(args, "--json") ? printJson(team) : console.log(formatTeam(team));
      } else if (action === "collect") {
        console.log(teams.collect(required(args[1], "The team ID is required.")));
      } else if (action === "cancel") {
        console.log(formatTeam(teams.cancel(required(args[1], "The team ID is required."))));
      } else {
        throw new Error("Use team start, list, status, collect, or cancel.");
      }
      return;
    }
    case "sync": {
      const jobs = mafia.reconcile(undefined, has(args, "--discover"));
      has(args, "--json") ? printJson(jobs) : console.log(formatJobs(jobs));
      return;
    }
    case "hosts": {
      const config = loadConfig();
      for (const host of Object.values(config.hosts)) {
        console.log(`${host.name}\t${host.kind}\t${host.target ?? "this machine"}\t${host.stateRoot}`);
      }
      return;
    }
    case "install-remote": {
      const host = resolveHost(loadConfig(), required(args[0], "The host name is required."));
      installRemote(host);
      console.log(`installed the Mafia worker on ${host.name}`);
      return;
    }
    case "eval": {
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("bun", [new URL("../scripts/eval.ts", import.meta.url).pathname, ...args], {
        cwd: new URL("..", import.meta.url).pathname,
        stdio: "inherit",
      });
      process.exitCode = result.status ?? 1;
      return;
    }
    case "__team-run":
      await teams.run(required(args[0], "The team ID is required."));
      return;
    case "doctor": {
      const config = loadConfig();
      for (const binary of ["git", "node", "bun", "omp", "claude", "codex", "kimi", "cline", "opencode"]) {
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync("sh", ["-c", `command -v ${binary}`], { encoding: "utf8" });
        console.log(`${result.status === 0 ? "ok     " : "missing"} ${binary}${result.stdout ? `: ${result.stdout.trim()}` : ""}`);
      }
      console.log(`config: ${JSON.stringify(config.hosts, null, 2)}`);
      return;
    }
    default:
      throw new Error(`Unknown Mafia command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`mafia: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
