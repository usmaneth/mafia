import { spawnSync } from "node:child_process";
import { loadConfig } from "./config";
import { toolEnvironment } from "./process";
import { JobStore } from "./store";
import { TelemetryStore } from "./telemetry-store";
import type { JobStatus } from "./types";

export interface PrLink {
  jobId: string;
  pr: number;
  repo: string;
  harness: string;
  model?: string;
  jobState: string;
}

export interface PrResult {
  pr: number;
  repo: string;
  state: string;
  merged: boolean;
  reviews: number;
  additions: number;
  deletions: number;
}

/**
 * Pull request numbers a job worked on.
 *
 * The fleet names them in the task title or the prompt, which is the only link
 * between a job and whether its work landed. A number under a hundred is
 * ignored: those are far more often a count or a version than a pull request.
 */
export function prNumbersIn(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/#(\d{3,6})\b/g)) {
    const value = Number(match[1]);
    if (value >= 100) found.add(value);
  }
  return [...found];
}

/**
 * Guess which repository a job's pull requests belong to.
 *
 * Jobs record the workspace they ran in, and the fleet's remote path carries
 * the slug. Without a repository a number is meaningless, so a job that gives
 * no hint is skipped rather than attributed to a default.
 */
export function repoOfJob(job: JobStatus, fallback?: string): string | undefined {
  const source = `${job.repo ?? ""} ${job.workspaceSource ?? ""} ${job.cwd ?? ""}`;
  const slug = source.match(/mafia-workspaces\/([^/\s]+\/[^/\s]+)/);
  if (slug) return slug[1];
  const known: Array<[RegExp, string]> = [
    [/ai-memoryless-client/, "zeta-chain/ai-memoryless-client"],
    [/ai-portal/, "zeta-chain/ai-portal"],
    [/\bnearby\b/, "anuma-ai/nearby"],
    [/\bsdk\b/, "anuma-ai/sdk"],
    [/\bmafia\b/, "usmaneth/mafia"],
  ];
  for (const [pattern, repo] of known) if (pattern.test(source)) return repo;
  return fallback;
}

export function linkJobsToPrs(jobs: JobStatus[], fallbackRepo?: string): PrLink[] {
  const links: PrLink[] = [];
  for (const job of jobs) {
    const repo = repoOfJob(job, fallbackRepo);
    if (!repo) continue;
    for (const pr of prNumbersIn(`${job.title ?? ""} ${job.prompt ?? ""}`)) {
      links.push({ jobId: job.id, pr, repo, harness: job.harness, model: job.model, jobState: job.state });
    }
  }
  return links;
}

/** Ask GitHub what became of each pull request. One call per repository. */
export function fetchPrResults(links: PrLink[]): PrResult[] {
  const byRepo = new Map<string, Set<number>>();
  for (const link of links) {
    byRepo.set(link.repo, (byRepo.get(link.repo) ?? new Set()).add(link.pr));
  }
  const results: PrResult[] = [];
  for (const [repo, numbers] of byRepo) {
    for (const pr of numbers) {
      const result = spawnSync("gh", [
        "pr", "view", String(pr), "--repo", repo,
        "--json", "number,state,mergedAt,reviews,additions,deletions",
      ], { encoding: "utf8", env: toolEnvironment(), timeout: 30_000 });
      if (result.status !== 0) continue;
      try {
        const value = JSON.parse(result.stdout) as {
          state?: string; mergedAt?: string | null; reviews?: unknown[];
          additions?: number; deletions?: number;
        };
        results.push({
          pr,
          repo,
          state: String(value.state ?? "UNKNOWN"),
          merged: Boolean(value.mergedAt),
          reviews: (value.reviews ?? []).length,
          additions: Number(value.additions ?? 0),
          deletions: Number(value.deletions ?? 0),
        });
      } catch {}
    }
  }
  return results;
}

/**
 * What each model's work actually did once it left the fleet.
 *
 * Every other measure here is effort. This is the only one that says whether
 * the work was accepted, and it is the number a routing decision should
 * eventually answer to.
 */
export function outcomesByModel(links: PrLink[], results: PrResult[]): Array<{
  model: string; harness: string; prs: number; merged: number; reviews: number; mergeRate: number;
}> {
  const byPr = new Map(results.map((result) => [`${result.repo}#${result.pr}`, result]));
  const tally = new Map<string, { model: string; harness: string; prs: Set<string>; merged: Set<string>; reviews: number }>();
  for (const link of links) {
    const result = byPr.get(`${link.repo}#${link.pr}`);
    if (!result) continue;
    const key = `${link.harness}:${link.model ?? "unknown"}`;
    const row = tally.get(key) ?? { model: link.model ?? "unknown", harness: link.harness, prs: new Set(), merged: new Set(), reviews: 0 };
    const id = `${link.repo}#${link.pr}`;
    if (!row.prs.has(id)) row.reviews += result.reviews;
    row.prs.add(id);
    if (result.merged) row.merged.add(id);
    tally.set(key, row);
  }
  return [...tally.values()]
    .map((row) => ({
      model: row.model,
      harness: row.harness,
      prs: row.prs.size,
      merged: row.merged.size,
      reviews: row.reviews,
      mergeRate: row.prs.size ? row.merged.size / row.prs.size : 0,
    }))
    .sort((left, right) => right.prs - left.prs);
}

export function recordOutcomes(stateRoot: string, results: PrResult[]): number {
  const store = new TelemetryStore(stateRoot);
  return store.recordPrStates(results.map((result) => ({
    // One row per pull request per terminal state, so a re-read cannot inflate.
    id: `pr:${result.repo}#${result.pr}:${result.merged ? "merged" : result.state.toLowerCase()}`,
    observedAt: new Date().toISOString(),
    state: result.merged ? "merged" : result.state.toLowerCase(),
    count: 1,
  })));
}

export function buildAttribution(stateRoot = loadConfig().stateRoot, limit = 500): {
  links: PrLink[]; results: PrResult[]; byModel: ReturnType<typeof outcomesByModel>;
} {
  const links = linkJobsToPrs(new JobStore(stateRoot).list(limit));
  const results = fetchPrResults(links);
  recordOutcomes(stateRoot, results);
  return { links, results, byModel: outcomesByModel(links, results) };
}

export function formatAttribution(value: ReturnType<typeof buildAttribution>): string {
  if (!value.byModel.length) return "no job could be linked to a pull request yet";
  const lines = [
    `${value.links.length} job-to-pull-request link(s) across ${value.results.length} pull request(s)`,
    "",
    `${"MODEL".padEnd(26)} ${"HARNESS".padEnd(8)} ${"PRS".padStart(4)} ${"MERGED".padStart(7)} ${"RATE".padStart(6)} ${"REVIEWS".padStart(8)}`,
  ];
  for (const row of value.byModel) {
    lines.push(
      `${row.model.slice(0, 26).padEnd(26)} ${row.harness.padEnd(8)} ${String(row.prs).padStart(4)} ` +
      `${String(row.merged).padStart(7)} ${`${Math.round(row.mergeRate * 100)}%`.padStart(6)} ${String(row.reviews).padStart(8)}`,
    );
  }
  return lines.join("\n");
}
