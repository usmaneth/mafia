import type { JobStatus } from "./types";

export interface ResultProblem {
  jobId: string;
  harness: string;
  kind: "empty" | "unparsed";
  detail: string;
}

/**
 * Detect a job that finished without a usable result.
 *
 * Result extraction reads the agent's own message out of a harness's output
 * stream, and each harness shapes that stream differently. When a harness
 * changes shape the extraction does not fail loudly: the job is still marked
 * succeeded, and the result is empty or is whatever raw record happened to be
 * last. That is the failure this looks for, because nothing else reports it.
 *
 * A failed job is exempt. Its result is often the provider's error, which is
 * exactly what a reader wants to see.
 */
export function resultProblems(jobs: readonly JobStatus[]): ResultProblem[] {
  const problems: ResultProblem[] = [];
  for (const job of jobs) {
    if (job.state !== "succeeded") continue;
    const result = job.result?.trim() ?? "";
    if (!result) {
      problems.push({ jobId: job.id, harness: job.harness, kind: "empty", detail: "succeeded with no result" });
      continue;
    }
    if (!result.startsWith("{")) continue;
    // The record is usually truncated, because the extractor keeps only the
    // tail of a long stream, so it will not parse. Requiring a parse here made
    // the check miss every real case. The leading type is enough to tell a
    // transport record from an answer.
    const declaredType = result.match(/^\{\s*"type"\s*:\s*"([a-z_]+)"/)?.[1];
    if (declaredType && ["session", "system", "init", "error", "result"].includes(declaredType)) {
      problems.push({
        jobId: job.id,
        harness: job.harness,
        kind: "unparsed",
        detail: `result is a raw "${declaredType}" record, not the agent's message`,
      });
      continue;
    }
    // Anything else opening with a quoted key and failing to parse is a
    // truncated record. The quote matters: prose can begin with a brace, and
    // flagging that would report a real answer as a failure.
    if (!/^\{\s*"/.test(result)) continue;
    try {
      JSON.parse(result);
    } catch {
      problems.push({
        jobId: job.id,
        harness: job.harness,
        kind: "unparsed",
        detail: "result is a truncated record rather than text",
      });
    }
  }
  return problems;
}

export function formatResultProblems(problems: ResultProblem[]): string {
  if (!problems.length) return "every finished job produced a usable result";
  const byHarness = new Map<string, ResultProblem[]>();
  for (const problem of problems) {
    byHarness.set(problem.harness, [...(byHarness.get(problem.harness) ?? []), problem]);
  }
  const lines = [`${problems.length} job(s) finished without a usable result`];
  for (const [harness, rows] of byHarness) {
    lines.push(`  ${harness.padEnd(9)} ${rows.length}  ${rows[0]!.detail}`);
    for (const row of rows.slice(0, 3)) lines.push(`      ${row.jobId}`);
  }
  return lines.join("\n");
}
