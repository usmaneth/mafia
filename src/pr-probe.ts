#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { toolEnvironment } from "./process";
import { classifyPr } from "./pr";
import type { PrAutomationUnit, PrOperationalState, PrStatus, PrTelemetry } from "./types";

const repos = [
  "zeta-chain/ai-memoryless-client",
  "zeta-chain/ai-portal",
  "anuma-ai/nearby",
  "anuma-ai/sdk",
];

interface ShepherdState {
  status?: string;
  sweeps?: number;
  automerge?: number;
}

function command(name: string, args: string[], timeout = 20_000): string {
  const result = spawnSync(name, args, { encoding: "utf8", env: toolEnvironment(), timeout });
  return result.status === 0 ? result.stdout.trim() : "";
}

function shepherdState(): Record<string, ShepherdState> {
  try {
    return JSON.parse(readFileSync("/home/usman/.config/pr-shepherd/state.json", "utf8"));
  } catch {
    return {};
  }
}

function unit(name: string): PrAutomationUnit {
  const raw = command("systemctl", [
    "show", name, "--property=ActiveState,SubState,Result,ExecMainExitTimestamp",
  ]);
  const fields = Object.fromEntries(raw.split("\n").map((line) => line.split("=", 2)));
  return {
    name,
    active: fields.ActiveState ?? "unknown",
    sub: fields.SubState ?? "unknown",
    result: fields.Result || undefined,
    lastRun: fields.ExecMainExitTimestamp || undefined,
  };
}

function repoPrs(repo: string, state: Record<string, ShepherdState>): PrStatus[] {
  const [owner, name] = repo.split("/");
  const query = `
    query($owner:String!,$name:String!){
      repository(owner:$owner,name:$name){
        pullRequests(first:60,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){
          nodes {
            number title url updatedAt headRefOid isDraft mergeable mergeStateStatus reviewDecision
            author { login }
            autoMergeRequest { enabledAt }
            commits(last:1){ nodes { commit { statusCheckRollup { state } } } }
            reviewThreads(first:100){ nodes {
              isResolved isOutdated
              comments(first:1){ nodes { author { login } } }
            } }
          }
        }
      }
    }`;
  const raw = command("gh", [
    "api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`,
  ], 30_000);
  if (!raw) return [];
  const data = JSON.parse(raw);
  const nodes = data?.data?.repository?.pullRequests?.nodes ?? [];
  return nodes.filter((pr: any) => pr.author?.login === "usmaneth" && !pr.isDraft).map((pr: any) => {
    const key = `${repo}#${pr.number}`;
    const saved = state[key] ?? {};
    const openThreads = (pr.reviewThreads?.nodes ?? []).filter((thread: any) =>
      !thread.isResolved && !thread.isOutdated);
    const botThreads = openThreads.filter((thread: any) =>
      thread.comments?.nodes?.[0]?.author?.login?.endsWith("[bot]")).length;
    const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? "NONE";
    const facts = {
      mergeable: pr.mergeable ?? "UNKNOWN",
      mergeStateStatus: pr.mergeStateStatus ?? "UNKNOWN",
      reviewDecision: pr.reviewDecision ?? "NONE",
      checks,
      unresolvedThreads: openThreads.length,
      sweeps: saved.sweeps ?? 0,
      autoMerge: Boolean(pr.autoMergeRequest),
    };
    return {
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      updatedAt: pr.updatedAt,
      headSha: pr.headRefOid?.slice(0, 12) ?? "",
      mergeable: facts.mergeable,
      mergeStateStatus: facts.mergeStateStatus,
      reviewDecision: facts.reviewDecision,
      checks,
      unresolvedThreads: facts.unresolvedThreads,
      botThreads,
      sweeps: facts.sweeps,
      autoMerge: facts.autoMerge,
      state: classifyPr(facts),
    } satisfies PrStatus;
  });
}

function main(): void {
  const saved = shepherdState();
  const prs = repos.flatMap((repo) => repoPrs(repo, saved));
  const states: PrOperationalState[] = [
    "needs-you", "fixing", "conflict", "ci-failing", "ci-pending",
    "ready", "queued", "awaiting-review", "watching",
  ];
  const totals = Object.fromEntries([
    ["open", prs.length],
    ...states.map((state) => [state, prs.filter((pr) => pr.state === state).length]),
  ]) as PrTelemetry["totals"];
  const value: PrTelemetry = {
    generatedAt: new Date().toISOString(),
    reachable: true,
    latencyMs: 0,
    totals,
    units: [
      unit("pr-watch.service"),
      unit("pr-shepherd.timer"),
      unit("pr-shepherd.service"),
      unit("pr-automerge.timer"),
      unit("pr-automerge.service"),
    ],
    prs: prs.sort((left, right) => {
      const rank = states.indexOf(left.state) - states.indexOf(right.state);
      return rank || right.updatedAt.localeCompare(left.updatedAt);
    }),
  };
  console.log(JSON.stringify(value));
}

main();
