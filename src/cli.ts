#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureConfig, loadConfig, repoRoot, resolveHost } from "./config";
import { formatHub, formatJobs, formatMessages, formatModels, formatPrDashboard, formatTeam, formatTeams } from "./format";
import { isHarnessName } from "./harnesses";
import { buildOmpArgs } from "./launch";
import { installRemote } from "./remote";
import { MafiaService } from "./service";
import { TeamService } from "./team";
import { protocolSpec } from "./protocols";
import { routeTask } from "./router";
import { catalogCandidates, routingSignals, filterCatalog, ModelCatalogService, parseModelSelector } from "./models";
import { recommendParallelism } from "./scale";
import { installUpdateAutomation, updateMafia } from "./updater";
import { formatMirror, mirrorAll, mirrorIsHealthy, readMirrorState, watchMirror } from "./mirror";
import { collectAll, formatGc } from "./gc";
import { formatRoleChanges, formatRoleSuggestions, healthyRoleModels, readConfiguredRoles, suggestFasterRoles } from "./roles";
import { formatMetrics, readMetrics, runBench, usableMetrics } from "./bench";
import { applyFixes, formatDoctor, formatFixes, runDoctor } from "./doctor";
import { formatSubagents } from "./format";
import { formatIngest, ingestTelemetry } from "./telemetry-ingest";
import { TelemetryStore } from "./telemetry-store";
import { formatRemoteIngest, ingestRemoteTelemetry } from "./telemetry-remote";
import { buildInsights, formatInsights } from "./insights";
import { renderDashboard } from "./dashboard";
import { acpHarnesses, runOverAcp, speaksAcp } from "./acp";
import { explainJob, formatExplanation } from "./why";
import { buildAttribution, formatAttribution } from "./pr-attribution";
import { formatResultProblems, resultProblems } from "./result-quality";
import { applyProposal, defaultApplyDeps, formatProposals, ProposalStore, refreshProposals } from "./proposals";
import { readActivity } from "../hooks/subagent-activity";
import {
  exhaustedProviders,
  accountBalance,
  formatAccountBalance,
  formatProviderUsage,
  providerHeadroom,
  ProviderUsageService,
  readPenalties,
  unavailableProviders,
} from "./provider-usage";
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

/**
 * Attach an effort level to a model selector.
 *
 * `--effort high` is easier to remember than the `:high` suffix, and both reach
 * the same selector. An explicit suffix on the model wins.
 */
function withEffort(model: string | undefined, effort: string | undefined): string | undefined {
  if (!model || !effort) return model;
  return parseModelSelector(model).effort ? model : `${model}:${effort}`;
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
  mafia dispatch --prompt TEXT [--model MODEL] [--effort LEVEL] [--prewalk] [--session] [--harness NAME] [--host NAME] [--repo PATH]
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
  mafia models [--harness NAME] [--provider NAME] [--find TEXT] [--effort LEVEL] [--refresh] [--json]
  mafia scale --tasks N [--ready N] [--risk low|medium|high]
  mafia update [--push] [--deploy] [--gc DAYS] [--telemetry]
  mafia mirror [--watch] [--dry-run] [--force] [--host NAME] [--json]
  mafia gc [--dry-run] [--days N] [--host NAME] [--force] [--json]
  mafia quota [--refresh] [--model SELECTOR] [--json]
  mafia roles [--json] [--suggest]
  mafia subagents [--json]   what each OMP subagent is running and doing
  mafia history [--ingest] [--remote] [--models] [--tools] [--prs] [--json]
  mafia dash [--watch]       one screen for the whole fleet
  mafia why JOB              why this job got the model and host it ran on
  mafia ask --prompt TEXT [--harness omp|cline] [--model M]   one turn over ACP
  mafia landed [--json]      which models produce work that actually merges
  mafia results [--json]     jobs that finished without a usable result
  mafia proposals [approve N|dismiss N --why TEXT] [--json]   decidable changes with evidence
  mafia insights [--json]    what the telemetry says to change next
  mafia bench [--models a,b] [--runs N] [--json]   measure real TTFT; spends quota
  mafia cleanse [--repo PATH] [--host NAME] [--agents N] [--all] [--tests] [REQUEST]
  mafia install-updater
  mafia vps [--refresh] [--all] [--json]
  mafia prs [--refresh] [--json] [--shepherd|--merge|--install]
  mafia budget TEAM
  mafia protocol start NAME --goal TEXT [--repo PATH]
  mafia sync [--discover]
  mafia hosts
  mafia install-remote HOST
  mafia eval [--live]
  mafia doctor [--json] [--fix]

Mafia supports 128 tasks in one team. OMP remains the main interface.`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  ensureConfig();
  const command = argv[0];
  const controlCommands = new Set([
    "help", "-h", "--help", "jobs", "status", "watch", "dispatch", "logs", "cancel", "handoff", "compare",
    "team", "hub", "message", "decisions", "decision", "events", "route", "budget", "protocol",
    "sync", "hosts", "install-remote", "eval", "__team-run", "doctor", "models", "scale", "update", "install-updater",
    "vps", "__vps-refresh", "prs", "__prs-refresh", "mirror", "gc", "quota", "roles", "bench", "cleanse", "subagents", "history", "insights", "dash", "why", "ask", "landed", "results", "proposals",
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
    case "status": {
      const mirror = readMirrorState(mafia.config.stateRoot);
      const quota = new ProviderUsageService(mafia.config.stateRoot).cached();
      const benched = readPenalties(mafia.config.stateRoot);
      const spent = [...exhaustedProviders(quota)];
      if (benched.length) {
        console.log(`benched: ${benched.map((entry) => `${entry.provider} until ${entry.until.slice(11, 16)}Z`).join(", ")}`);
        console.log("");
      }
      if (spent.length) {
        console.log(`quota: ${spent.join(", ")} at the limit - routing will avoid ${spent.length > 1 ? "them" : "it"}. mafia quota --refresh for detail.`);
        console.log("");
      }
      if (!mirrorIsHealthy(mirror)) {
        console.log(mirror
          ? `mirror: ${mirror.verdict.toUpperCase()} - ${mirror.detail} (checked ${mirror.checkedAt})`
          : "mirror: NEVER RUN - run `mafia mirror` to match the VPS to this machine.");
        console.log("");
      }
      console.log(formatTeams(teams.list(30)));
      console.log("");
      console.log(formatJobs(mafia.list(100)));
      return;
    }
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
        model: withEffort(option(args, "--model"), option(args, "--effort")),
        baseRef: option(args, "--base"),
        isolate: has(args, "--no-isolate") ? false : undefined,
        prewalk: has(args, "--prewalk"),
        session: has(args, "--session") ? true : undefined,
        prewalkInto: option(args, "--prewalk-into"),
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
    case "route": {
      const config = loadConfig();
      const quotaNow = new ProviderUsageService(config.stateRoot).discover();
      printJson(routeTask(config, {
        capability: (option(args, "--capability") ?? "general") as any,
        host: option(args, "--host"),
        downgrade: has(args, "--cheap"),
        exhaustedProviders: unavailableProviders(quotaNow, config.stateRoot),
        headroom: (provider) => providerHeadroom(quotaNow, provider),
      }, new Map(), catalogCandidates(new ModelCatalogService(config.stateRoot).discover(), Object.keys(config.hosts), usableMetrics(config.stateRoot), routingSignals(config.stateRoot))));
      return;
    }
    case "models": {
      const catalog = new ModelCatalogService(mafia.config.stateRoot).discover(has(args, "--refresh"));
      const filtered = filterCatalog(catalog, {
        harness: option(args, "--harness") as any,
        provider: option(args, "--provider"),
        query: option(args, "--find"),
        effort: option(args, "--effort"),
        limit: Number(option(args, "--limit") ?? 50),
      });
      if (has(args, "--json")) printJson(filtered);
      else console.log(formatModels(catalog, filtered.models));
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
      printJson(updateMafia({
        push: has(args, "--push"),
        deploy: has(args, "--deploy"),
        gcDays: has(args, "--gc") ? Number(option(args, "--gc") ?? 7) : undefined,
        telemetry: has(args, "--telemetry"),
      }));
      return;
    case "mirror": {
      if (has(args, "--watch")) {
        const stop = watchMirror({
          host: option(args, "--host"),
          debounceMs: option(args, "--debounce") ? Number(option(args, "--debounce")) : undefined,
        });
        console.log("watching for changes - press Ctrl-C to stop");
        process.on("SIGINT", () => {
          stop();
          process.exit(0);
        });
        await new Promise(() => {});
        return;
      }
      const reports = mirrorAll({
        dryRun: has(args, "--dry-run"),
        force: has(args, "--force"),
        host: option(args, "--host"),
      });
      has(args, "--json") ? printJson(reports) : console.log(formatMirror(reports));
      if (reports.some((report) => !["synced", "current", "locked"].includes(report.verdict))) process.exitCode = 1;
      return;
    }
    case "gc": {
      const reports = collectAll({
        dryRun: has(args, "--dry-run"),
        force: has(args, "--force"),
        host: option(args, "--host"),
        olderThanDays: option(args, "--days") ? Number(option(args, "--days")) : undefined,
      });
      has(args, "--json") ? printJson(reports) : console.log(formatGc(reports));
      return;
    }
    case "quota": {
      const model = option(args, "--model");
      if (model) {
        const balance = accountBalance(model, Number(option(args, "--samples") ?? 20));
        if (!balance) throw new Error(`Cannot resolve credentials for ${model}.`);
        has(args, "--json") ? printJson(balance) : console.log(formatAccountBalance(balance));
        return;
      }
      const usage = new ProviderUsageService(mafia.config.stateRoot).discover(has(args, "--refresh"));
      has(args, "--json") ? printJson(usage) : console.log(formatProviderUsage(usage));
      return;
    }
    case "roles": {
      const configured = readConfiguredRoles();
      const usage = new ProviderUsageService(mafia.config.stateRoot).discover();
      const result = healthyRoleModels(configured, mafia.models.cached(), usage, mafia.config.stateRoot);
      if (has(args, "--json")) printJson({ configured, ...result });
      else {
        console.log("configured OMP roles");
        for (const [role, model] of Object.entries(configured)) console.log(`  ${role.padEnd(9)} ${model}`);
        console.log("");
        console.log(formatRoleChanges(result.changes, result.unfixable));
        if (has(args, "--suggest")) {
          console.log("");
          console.log(formatRoleSuggestions(suggestFasterRoles(
            configured,
            usableMetrics(mafia.config.stateRoot),
            mafia.models.cached(),
            unavailableProviders(usage, mafia.config.stateRoot),
          )));
        }
      }
      return;
    }
    case "bench": {
      const models = option(args, "--models")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
      if (!models.length) {
        const stored = readMetrics(mafia.config.stateRoot);
        has(args, "--json") ? printJson(stored) : console.log(formatMetrics(stored.models));
        return;
      }
      console.log(`measuring ${models.length} model(s) - this sends real requests and spends quota`);
      const { measured } = runBench({
        models,
        runs: option(args, "--runs") ? Number(option(args, "--runs")) : undefined,
        maxTokens: option(args, "--max-tokens") ? Number(option(args, "--max-tokens")) : undefined,
        stateRoot: mafia.config.stateRoot,
      });
      has(args, "--json") ? printJson(measured) : console.log(formatMetrics(measured));
      return;
    }
    case "cleanse": {
      // OMP already fans out file-disjoint subagents to fix project
      // diagnostics. Mafia's contribution is running it as a supervised job,
      // on the VPS if asked, rather than reimplementing the fan-out.
      const request = args.find((value) => !value.startsWith("--") && args[args.indexOf(value) - 1]?.startsWith("--") !== true);
      const flags = [
        ...(option(args, "--agents") ? ["--agents", option(args, "--agents")!] : []),
        ...(has(args, "--all") ? ["--all"] : []),
        ...(has(args, "--tests") ? ["--tests"] : []),
      ].join(" ");
      const job = mafia.dispatch({
        title: `cleanse: ${request ?? "project diagnostics"}`,
        prompt: `Run \`omp cleanse ${flags} ${request ? JSON.stringify(request) : ""}\`.trim() in this repository and report every diagnostic it fixed and every one it could not.`,
        harness: "omp",
        host: option(args, "--host"),
        repo: option(args, "--repo") ?? process.cwd(),
      });
      console.log(`${job.id} ${job.harness}@${job.host} ${job.state}`);
      return;
    }
    case "subagents": {
      const rows = readActivity();
      has(args, "--json") ? printJson(rows) : console.log(formatSubagents(rows));
      return;
    }
    case "history": {
      const store = new TelemetryStore(mafia.config.stateRoot);
      if (has(args, "--remote")) {
        const hosts = Object.values(mafia.config.hosts).filter((entry) => entry.kind === "ssh" && entry.target);
        console.log(formatRemoteIngest(hosts.map((entry) => ingestRemoteTelemetry(entry, {
          maxBytes: option(args, "--max-bytes") ? Number(option(args, "--max-bytes")) : undefined,
        }))));
        console.log("");
      }
      if (has(args, "--ingest")) {
        const reports = ingestTelemetry(mafia.config.stateRoot, {
          maxBytes: option(args, "--max-bytes") ? Number(option(args, "--max-bytes")) : undefined,
        });
        if (has(args, "--json")) printJson(reports);
        else {
          console.log(formatIngest(reports));
          console.log("");
        }
        if (has(args, "--json")) return;
      }
      if (has(args, "--tools")) {
        const rows = store.toolUsage(Number(option(args, "--limit") ?? 15));
        has(args, "--json") ? printJson(rows) : console.log(rows.length
          ? ["tool use across every harness", ...rows.map((row) =>
            `  ${String(row.calls).padStart(8)} calls  ${row.harness.padEnd(8)} ${row.tool}`)].join("\n")
          : "no tool calls recorded yet - run `mafia history --ingest`");
        return;
      }
      if (has(args, "--prs")) {
        const rows = store.prStates(Number(option(args, "--days") ?? 14));
        has(args, "--json") ? printJson(rows) : console.log(rows.length
          ? ["pull-request states observed by the merge watcher", ...rows.map((row) =>
            `  ${String(row.observations).padStart(6)} observations  peak ${String(row.peak).padStart(3)}  ${row.state}`)].join("\n")
          : "no pull-request observations yet");
        return;
      }
      if (has(args, "--models")) {
        const rows = store.modelLatency(Number(option(args, "--min") ?? 5));
        has(args, "--json") ? printJson(rows) : console.log(rows.length
          ? ["model latency across every harness", ...rows.map((row) =>
            `  ${String(Math.round(row.medianMs)).padStart(7)}ms  ${row.model} (${row.harness}, ${row.turns} turns)`)].join("\n")
          : "no latency recorded yet");
        return;
      }
      const coverage = store.coverage();
      const incomplete = coverage.filter((row) => row.total > 0 && row.bytesRead < row.total);
      if (incomplete.length && !has(args, "--json")) {
        // Say when the picture is partial. A summary that looks complete while
        // a third of the history is unread is worse than no summary.
        console.log(incomplete.map((row) =>
          `  partial: ${row.harness} ${Math.round(100 * row.bytesRead / row.total)}% read - run \`mafia history --ingest\` again`).join("\n"));
        console.log("");
      }
      const summary = store.summary();
      if (has(args, "--json")) printJson(summary);
      else console.log(summary.length
        ? (() => {
          // Lead with the total. Split across three columns, no single figure
          // carried the magnitude, so a 56-billion-token corpus read as a
          // 1.4-million-token one.
          const big = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(1)}B`
            : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M`
            : value.toLocaleString();
          const totals = summary.reduce((sum, row) => ({
            turns: sum.turns + row.turns,
            total: sum.total + row.totalTokens,
            cached: sum.cached + row.cacheReadTokens,
          }), { turns: 0, total: 0, cached: 0 });
          return [
            `${totals.turns.toLocaleString()} turns   ${big(totals.total)} tokens   ` +
            `${Math.round(100 * totals.cached / Math.max(totals.total, 1))}% of input served from cache`,
            "",
            `${"HARNESS".padEnd(9)} ${"HOST".padEnd(6)} ${"TURNS".padStart(8)} ${"TOTAL".padStart(8)} ${"FRESH".padStart(8)} ${"CACHED".padStart(8)} ${"OUT".padStart(8)}  SPAN`,
            ...summary.map((row) =>
              `${row.harness.padEnd(9)} ${(row.host ?? "local").padEnd(6)} ${String(row.turns).padStart(8)} ` +
              `${big(row.totalTokens).padStart(8)} ${big(row.inputTokens).padStart(8)} ${big(row.cacheReadTokens).padStart(8)} ${big(row.outputTokens).padStart(8)}  ` +
              `${row.first.slice(0, 10)} to ${row.last.slice(0, 10)}`),
          ].join("\n");
        })()
        : "no telemetry yet - run `mafia history --ingest`");
      return;
    }
    case "insights": {
      const found = buildInsights(mafia.config.stateRoot);
      has(args, "--json") ? printJson(found) : console.log(formatInsights(found));
      return;
    }
    case "dash": {
      if (has(args, "--watch")) {
        const interval = Math.max(1, Number(option(args, "--interval") ?? 3));
        while (true) {
          process.stdout.write("\x1b[2J\x1b[H");
          console.log(renderDashboard(mafia.config.stateRoot));
          console.log(`\n  refresh ${interval}s - Ctrl-C to stop`);
          await Bun.sleep(interval * 1000);
        }
      }
      console.log(renderDashboard(mafia.config.stateRoot));
      return;
    }
    case "why": {
      const value = explainJob(mafia.config.stateRoot, required(args[0], "The job ID is required."));
      has(args, "--json") ? printJson(value) : console.log(formatExplanation(value));
      return;
    }
    case "ask": {
      // ACP returns a typed result and a stop reason, so nothing has to be
      // guessed out of a stream. Only the harnesses that speak it are offered.
      const harness = option(args, "--harness") ?? "omp";
      if (!speaksAcp(harness)) throw new Error(`${harness} does not speak ACP. Use omp or cline.`);
      const cwd = option(args, "--cwd") ?? process.cwd();
      const spec = acpHarnesses[harness]!(cwd, option(args, "--model"));
      const result = await runOverAcp({
        ...spec,
        cwd,
        prompt: required(option(args, "--prompt"), "--prompt is required."),
        timeoutMs: option(args, "--timeout") ? Number(option(args, "--timeout")) * 1000 : undefined,
        onTool: has(args, "--quiet") ? undefined : (tool) => console.error(`  ${tool}`),
      });
      has(args, "--json") ? printJson(result) : console.log(result.text);
      if (result.stopReason !== "end_turn") process.exitCode = 1;
      return;
    }
    case "landed": {
      const value = buildAttribution(mafia.config.stateRoot, Number(option(args, "--limit") ?? 500));
      has(args, "--json") ? printJson(value) : console.log(formatAttribution(value));
      return;
    }
    case "results": {
      const problems = resultProblems(mafia.listCached(Number(option(args, "--limit") ?? 300)));
      has(args, "--json") ? printJson(problems) : console.log(formatResultProblems(problems));
      return;
    }
    case "proposals": {
      const store = new ProposalStore(mafia.config.stateRoot);
      const verb = args[0];
      if (verb === "approve" || verb === "dismiss") {
        const ref = required(args[1], "Name a proposal by number or id.");
        const proposal = store.get(ref);
        if (!proposal) throw new Error(`No proposal matches "${ref}". Run mafia proposals.`);
        if (proposal.state !== "pending") throw new Error(`Proposal ${proposal.id} is already ${proposal.state}.`);
        if (verb === "dismiss") {
          store.setState(proposal.id, "dismissed", { dismissReason: option(args, "--why") ?? "dismissed by the operator" });
          console.log(`dismissed: ${proposal.title}`);
          console.log("  it will not be proposed again");
          return;
        }
        const outcome = applyProposal(store, proposal, defaultApplyDeps(mafia.config.stateRoot));
        console.log(`${outcome.ok ? (proposal.auto ? "applied" : "approved") : "FAILED"}: ${proposal.title}`);
        console.log(`  ${outcome.detail}`);
        return;
      }
      refreshProposals(mafia.config.stateRoot);
      const pending = store.list();
      has(args, "--json")
        ? printJson({ pending, recent: store.list(["applied", "failed", "approved"]) })
        : console.log(formatProposals(pending, store.list(["applied", "failed"])));
      return;
    }
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
      const checks = runDoctor();
      has(args, "--json") ? printJson(checks) : console.log(formatDoctor(checks));
      if (has(args, "--fix")) {
        const { spawnSync } = await import("node:child_process");
        console.log("");
        console.log(formatFixes(applyFixes(checks, (fixArgs) => {
          const result = spawnSync("bun", [join(repoRoot, "src", "cli.ts"), ...fixArgs], { encoding: "utf8", timeout: 300_000 });
          return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
        })));
        return;
      }
      if (checks.some((check) => check.state === "fail")) process.exitCode = 1;
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
