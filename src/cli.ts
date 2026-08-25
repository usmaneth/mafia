#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { ensureConfig, loadConfig, resolveHost } from "./config";
import { formatHub, formatJobs, formatMessages, formatPrDashboard, formatTeam, formatTeams } from "./format";
import { isHarnessName } from "./harnesses";
import { buildOmpArgs } from "./launch";
import { installRemote } from "./remote";
import { MafiaService } from "./service";
import { TeamService } from "./team";
import { protocolSpec } from "./protocols";
import { routeTask } from "./router";
import { catalogCandidates, filterCatalog, ModelCatalogService } from "./models";
import { recommendParallelism } from "./scale";
import { installUpdateAutomation, updateMafia } from "./updater";
import { readVpsTelemetry, refreshVpsTelemetry } from "./telemetry";
import { formatVpsTelemetry } from "./format";
import { codexOAuthEnvironment } from "./process";
import { installPrAutomation, readPrTelemetry, refreshPrTelemetry, runPrAutomation } from "./pr";
import { teamProtocolNames, type JobState, type MessageType, type PipelineSpec, type TeamProtocolName } from "./types";

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
  mafia dispatch --prompt TEXT [--model MODEL] [--harness NAME] [--host NAME] [--repo PATH]
  mafia logs JOB [--lines N]
  mafia cancel JOB
  mafia handoff JOB --harness NAME [--host NAME] [--prompt TEXT]
  mafia compare LEFT_JOB RIGHT_JOB
  mafia team start --file TEAM.json
  mafia team list [--json]
  mafia team status TEAM [--json]
  mafia team collect TEAM
  mafia team cancel TEAM
  mafia team pause TEAM
  mafia team resume TEAM
  mafia team add TEAM --file TASK.json
  mafia team update TEAM TASK --file PATCH.json
  mafia team retry TEAM TASK [--file PATCH.json]
  mafia team checkpoint TEAM [--name NAME]
  mafia team restore CHECKPOINT
  mafia hub TEAM
  mafia message TEAM --body TEXT [--to JOB] [--type TYPE]
  mafia decisions TEAM
  mafia decision TEAM --question TEXT --selected TEXT
  mafia events [--team TEAM] [--job JOB]
  mafia route --capability TYPE [--host HOST]
  mafia models [--harness NAME] [--provider NAME] [--find TEXT] [--refresh] [--json]
  mafia scale --tasks N [--ready N] [--risk low|medium|high]
  mafia update [--push] [--deploy]
  mafia install-updater
  mafia vps [--refresh] [--all] [--json]
  mafia prs [--refresh] [--json] [--shepherd|--merge|--install]
  mafia budget TEAM
  mafia protocol start NAME --goal TEXT [--repo PATH]
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
    "help", "-h", "--help", "jobs", "status", "watch", "dispatch", "logs", "cancel", "handoff", "compare",
    "team", "hub", "message", "decisions", "decision", "events", "route", "budget", "protocol",
    "sync", "hosts", "install-remote", "eval", "__team-run", "doctor", "models", "scale", "update", "install-updater",
    "vps", "__vps-refresh", "prs", "__prs-refresh",
  ]);
  if (!command || command === "shell" || command === "run" || !controlCommands.has(command)) {
    const { spawnSync } = await import("node:child_process");
    const extra = command === "shell" || command === "run" ? argv.slice(1) : argv;
    const result = spawnSync("omp", buildOmpArgs(extra), {
      env: codexOAuthEnvironment(),
      stdio: "inherit",
    });
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
    case "compare":
      console.log(mafia.compare(
        required(args[0], "The left job ID is required."),
        required(args[1], "The right job ID is required."),
      ));
      return;
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
      } else if (action === "pause") {
        console.log(formatTeam(teams.pause(required(args[1], "The team ID is required."))));
      } else if (action === "resume") {
        console.log(formatTeam(teams.resume(required(args[1], "The team ID is required."))));
      } else if (action === "add") {
        const file = required(option(args, "--file"), "--file is required.");
        console.log(formatTeam(teams.addTask(
          required(args[1], "The team ID is required."),
          JSON.parse(readFileSync(file, "utf8")),
        )));
      } else if (action === "update") {
        const file = required(option(args, "--file"), "--file is required.");
        console.log(formatTeam(teams.updateTask(
          required(args[1], "The team ID is required."),
          required(args[2], "The task ID is required."),
          JSON.parse(readFileSync(file, "utf8")),
        )));
      } else if (action === "retry") {
        const file = option(args, "--file");
        console.log(formatTeam(teams.retryTask(
          required(args[1], "The team ID is required."),
          required(args[2], "The task ID is required."),
          file ? JSON.parse(readFileSync(file, "utf8")) : undefined,
        )));
      } else if (action === "checkpoint") {
        printJson(teams.checkpoint(required(args[1], "The team ID is required."), option(args, "--name")));
      } else if (action === "restore") {
        console.log(formatTeam(teams.restore(required(args[1], "The checkpoint ID is required."))));
      } else {
        throw new Error("Use team start, list, status, collect, cancel, pause, resume, add, update, retry, checkpoint, or restore.");
      }
      return;
    }
    case "hub": {
      const team = teams.get(required(args[0], "The team ID is required."));
      console.log(formatHub(team, mafia.list(500), mafia.control.messages({ teamId: team.id, limit: 20 })));
      return;
    }
    case "message": {
      const teamId = required(args[0], "The team ID is required.");
      const message = mafia.sendMessage({
        teamId,
        from: option(args, "--from") ?? "lead",
        to: option(args, "--to"),
        type: (option(args, "--type") ?? "message") as MessageType,
        body: required(option(args, "--body"), "--body is required."),
      });
      printJson(message);
      return;
    }
    case "decisions":
      printJson(mafia.control.decisions(required(args[0], "The team ID is required.")));
      return;
    case "decision": {
      const teamId = required(args[0], "The team ID is required.");
      printJson(teams.recordDecision(teamId, {
        question: required(option(args, "--question"), "--question is required."),
        recommendation: option(args, "--recommendation"),
        alternatives: option(args, "--alternatives")?.split("|").filter(Boolean) ?? [],
        selected: required(option(args, "--selected"), "--selected is required."),
        selectedBy: option(args, "--by") ?? "Usman",
        affectedTasks: option(args, "--tasks")?.split(",").filter(Boolean) ?? [],
      }));
      return;
    }
    case "events":
      printJson(mafia.store.listEvents({
        teamId: option(args, "--team"),
        jobId: option(args, "--job"),
        limit: Number(option(args, "--limit") ?? 200),
      }));
      return;
    case "route":
      printJson(routeTask(loadConfig(), {
        capability: (option(args, "--capability") ?? "general") as any,
        host: option(args, "--host"),
        downgrade: has(args, "--cheap"),
      }, new Map(), catalogCandidates(new ModelCatalogService(loadConfig().stateRoot).discover(), Object.keys(loadConfig().hosts))));
      return;
    case "models": {
      const catalog = new ModelCatalogService(mafia.config.stateRoot).discover(has(args, "--refresh"));
      const filtered = filterCatalog(catalog, {
        harness: option(args, "--harness") as any,
        provider: option(args, "--provider"),
        query: option(args, "--find"),
        limit: Number(option(args, "--limit") ?? 50),
      });
      if (has(args, "--json")) printJson(filtered);
      else {
        console.log(`catalog: ${catalog.models.length} models - ${catalog.generatedAt}`);
        console.log(catalog.sources.map((source) => `${source.harness}: ${source.status} (${source.count})${source.error ? ` - ${source.error}` : ""}`).join("\n"));
        console.log("");
        console.log(filtered.models.map((model) => `${model.harness}\t${model.provider}\t${model.selector}\t${model.name}`).join("\n") || "no matching models");
      }
      return;
    }
    case "scale":
      printJson(recommendParallelism({
        taskCount: Number(required(option(args, "--tasks"), "--tasks is required.")),
        readyCount: option(args, "--ready") ? Number(option(args, "--ready")) : undefined,
        completed: option(args, "--completed") ? Number(option(args, "--completed")) : undefined,
        failures: option(args, "--failures") ? Number(option(args, "--failures")) : undefined,
        maxParallel: option(args, "--max") ? Number(option(args, "--max")) : undefined,
        risk: option(args, "--risk") as any,
      }));
      return;
    case "update":
      printJson(updateMafia({ push: has(args, "--push"), deploy: has(args, "--deploy") }));
      return;
    case "install-updater":
      printJson(installUpdateAutomation());
      return;
    case "vps": {
      const value = has(args, "--refresh")
        ? refreshVpsTelemetry(true)
        : readVpsTelemetry() ?? refreshVpsTelemetry(true);
      has(args, "--json") ? printJson(value) : console.log(formatVpsTelemetry(value, { allProcesses: has(args, "--all") }));
      return;
    }
    case "__vps-refresh":
      refreshVpsTelemetry(has(args, "--force"));
      return;
    case "prs": {
      if (has(args, "--install")) installPrAutomation();
      if (has(args, "--shepherd")) runPrAutomation("shepherd");
      if (has(args, "--merge")) runPrAutomation("merge");
      const value = has(args, "--refresh")
        ? refreshPrTelemetry(true)
        : readPrTelemetry() ?? refreshPrTelemetry(true);
      has(args, "--json") ? printJson(value) : console.log(formatPrDashboard(value));
      return;
    }
    case "__prs-refresh":
      refreshPrTelemetry(has(args, "--force"));
      return;
    case "budget": {
      const team = teams.get(required(args[0], "The team ID is required."));
      printJson({
        budget: team.budget,
        usage: mafia.control.usage(team.id),
        byProvider: mafia.store.usageByProvider(team.id),
        byHarness: mafia.store.usageBreakdown(team.id),
      });
      return;
    }
    case "protocol": {
      if (args[0] !== "start") throw new Error("Use protocol start.");
      const name = required(args[1], "The protocol name is required.") as TeamProtocolName;
      if (!teamProtocolNames.includes(name)) throw new Error(`Unknown protocol: ${name}`);
      const goal = required(option(args, "--goal"), "--goal is required.");
      const spec = protocolSpec(name, goal, option(args, "--repo"));
      console.log(formatTeam(teams.create(goal, spec)));
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
