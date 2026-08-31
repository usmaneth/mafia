import { describe, expect, test } from "bun:test";
import { linkJobsToPrs, outcomesByModel, prNumbersIn, repoOfJob } from "../src/pr-attribution";
import type { PrLink, PrResult } from "../src/pr-attribution";
import type { JobStatus } from "../src/types";

const job = (over: Partial<JobStatus> = {}): JobStatus => ({
  id: "j1", title: "", prompt: "", harness: "codex", host: "vps", state: "succeeded",
  isolate: false, labels: [], createdAt: "", stateRoot: "/s", timeoutSeconds: 60,
  updatedAt: "", logPath: "", ...over,
}) as JobStatus;

describe("finding pull request numbers", () => {
  test("reads them from a title", () => {
    expect(prNumbersIn("Resume fleet b6 #6657 #6659 #6621").sort()).toEqual([6621, 6657, 6659]);
  });

  test("ignores a number too small to be a pull request", () => {
    // "#3 of 5" is a count far more often than a pull request.
    expect(prNumbersIn("step #3 of #5")).toEqual([]);
  });

  test("does not repeat a number mentioned twice", () => {
    expect(prNumbersIn("fix #6677 then re-check #6677")).toEqual([6677]);
  });
});

describe("working out the repository", () => {
  test("reads the slug out of a remote workspace path", () => {
    expect(repoOfJob(job({ repo: "/home/usman/mafia-workspaces/zeta-chain/ai-memoryless-client" })))
      .toBe("zeta-chain/ai-memoryless-client");
  });

  test("falls back to a known project name", () => {
    expect(repoOfJob(job({ cwd: "/srv/dev/nearby" }))).toBe("anuma-ai/nearby");
  });

  test("skips a job that gives no hint rather than guessing a default", () => {
    // Attributing a pull request to the wrong repository is worse than not
    // attributing it at all.
    expect(repoOfJob(job({ cwd: "/tmp/scratch" }))).toBeUndefined();
  });

  test("links nothing when the repository is unknown", () => {
    expect(linkJobsToPrs([job({ title: "fix #6677", cwd: "/tmp/scratch" })])).toHaveLength(0);
  });
});

describe("outcomes by model", () => {
  const links: PrLink[] = [
    { jobId: "a", pr: 1, repo: "r", harness: "codex", model: "m1", jobState: "succeeded" },
    { jobId: "b", pr: 1, repo: "r", harness: "codex", model: "m1", jobState: "succeeded" },
    { jobId: "c", pr: 2, repo: "r", harness: "codex", model: "m1", jobState: "succeeded" },
    { jobId: "d", pr: 3, repo: "r", harness: "claude", model: "m2", jobState: "succeeded" },
  ];
  const results: PrResult[] = [
    { pr: 1, repo: "r", state: "MERGED", merged: true, reviews: 2, additions: 0, deletions: 0 },
    { pr: 2, repo: "r", state: "OPEN", merged: false, reviews: 1, additions: 0, deletions: 0 },
    { pr: 3, repo: "r", state: "CLOSED", merged: false, reviews: 5, additions: 0, deletions: 0 },
  ];

  test("counts a pull request once even when several jobs touched it", () => {
    // Two jobs on one pull request is one outcome, not two.
    const [first] = outcomesByModel(links, results);
    expect(first!.prs).toBe(2);
    expect(first!.merged).toBe(1);
    expect(first!.mergeRate).toBe(0.5);
  });

  test("does not double count reviews for a repeated pull request", () => {
    expect(outcomesByModel(links, results)[0]!.reviews).toBe(3);
  });

  test("keeps models apart", () => {
    expect(outcomesByModel(links, results).map((row) => row.model).sort()).toEqual(["m1", "m2"]);
  });

  test("ignores a link whose pull request was never fetched", () => {
    const orphan: PrLink[] = [{ jobId: "x", pr: 99, repo: "r", harness: "codex", model: "m3", jobState: "succeeded" }];
    expect(outcomesByModel(orphan, results)).toHaveLength(0);
  });
});
