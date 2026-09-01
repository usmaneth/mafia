import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config";
import { toolEnvironment } from "./process";

/**
 * Repositories the fleet's pull requests land in.
 *
 * The same set the attribution module infers from workspace paths; a queue
 * cannot infer, it has to ask, so the list is explicit here.
 */
export const REVIEW_REPOS = [
  "zeta-chain/ai-memoryless-client",
  "zeta-chain/ai-portal",
  "anuma-ai/nearby",
  "anuma-ai/sdk",
  "usmaneth/mafia",
];

export interface ReviewItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** One word a reader can act on. */
  status: "awaiting-review" | "changes-requested" | "approved-unmerged" | "conflicting";
  conflicting: boolean;
}

export interface ReviewQueue {
  generatedAt: string;
  items: ReviewItem[];
  /** Repositories that could not be asked; their pull requests may be missing. */
  errors: string[];
}

export function reviewQueuePath(stateRoot: string): string {
  return join(stateRoot, "review-queue.json");
}

export function readReviewQueue(stateRoot: string): ReviewQueue | undefined {
  try {
    return JSON.parse(readFileSync(reviewQueuePath(stateRoot), "utf8")) as ReviewQueue;
  } catch {
    return undefined;
  }
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  reviewDecision: string;
  mergeStateStatus: string;
}

export function classify(pr: RawPr): ReviewItem["status"] {
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (pr.reviewDecision === "APPROVED") return "approved-unmerged";
  if (pr.mergeStateStatus === "DIRTY") return "conflicting";
  return "awaiting-review";
}

/**
 * Ask GitHub for every open pull request the fleet is waiting on.
 *
 * The outcome data already says review is where work sits: pull requests were
 * observed awaiting approval four times more often than any other state. This
 * turns that aggregate into the actual list, oldest first, because the oldest
 * item is the one the constraint is currently made of.
 *
 * Only this function talks to the network. Everything that displays the queue
 * reads the cached file, so a dashboard refreshing every few seconds costs
 * nothing.
 */
export function fetchReviewQueue(stateRoot = loadConfig().stateRoot, repos: string[] = REVIEW_REPOS): ReviewQueue {
  const items: ReviewItem[] = [];
  const errors: string[] = [];
  for (const repo of repos) {
    const result = spawnSync("gh", [
      "pr", "list", "--repo", repo, "--author", "usmaneth", "--state", "open",
      "--json", "number,title,url,createdAt,updatedAt,isDraft,reviewDecision,mergeStateStatus",
    ], { encoding: "utf8", env: toolEnvironment(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      errors.push(`${repo}: ${(result.stderr || "gh failed").trim().slice(0, 80)}`);
      continue;
    }
    try {
      for (const pr of JSON.parse(result.stdout) as RawPr[]) {
        if (pr.isDraft) continue;
        items.push({
          repo,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          status: classify(pr),
          conflicting: pr.mergeStateStatus === "DIRTY",
        });
      }
    } catch {
      errors.push(`${repo}: unreadable response`);
    }
  }
  items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const queue: ReviewQueue = { generatedAt: new Date().toISOString(), items, errors };
  if (shouldPersistQueue(items.length, errors.length, repos.length)) {
    const path = reviewQueuePath(stateRoot);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }
  return queue;
}

/**
 * Whether a fetch result deserves to replace the cache.
 *
 * A pass where every repository failed is an outage, not an empty queue, and
 * writing it would erase a good cache with nothing. The guard has to sit here,
 * on the write itself: a caller deciding after the fact is too late, because
 * the file is already gone.
 */
export function shouldPersistQueue(items: number, errors: number, repos: number): boolean {
  return items > 0 || errors < repos;
}

/** Refresh unless the cache is younger than the given age. Failures keep the cache. */
export function refreshReviewQueue(stateRoot = loadConfig().stateRoot, maxAgeMs = 10 * 60_000): ReviewQueue | undefined {
  const cached = readReviewQueue(stateRoot);
  if (cached && Date.now() - new Date(cached.generatedAt).getTime() < maxAgeMs) return cached;
  try {
    const fresh = fetchReviewQueue(stateRoot);
    // The write guard already kept the file; return the better of the two.
    if (!shouldPersistQueue(fresh.items.length, fresh.errors.length, REVIEW_REPOS.length) && cached) return cached;
    return fresh;
  } catch {
    return cached;
  }
}

export function ageHours(iso: string, now = Date.now()): number {
  return Math.max(0, (now - new Date(iso).getTime()) / 3_600_000);
}

export function formatReviewQueue(queue: ReviewQueue | undefined, now = Date.now()): string {
  if (!queue) return "no review data yet - run mafia review --refresh";
  if (!queue.items.length) return "nothing is waiting on review";
  const age = (iso: string) => {
    const hours = ageHours(iso, now);
    return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
  };
  const lines = queue.items.map((item) =>
    `  ${age(item.createdAt).padStart(4)}  ${item.status.padEnd(17)} ${item.repo.split("/")[1]}#${item.number}  ${item.title.slice(0, 46)}\n        ${item.url}`);
  if (queue.errors.length) lines.push(`  (unreachable: ${queue.errors.map((error) => error.split(":")[0]).join(", ")})`);
  return lines.join("\n");
}
