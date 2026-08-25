import type { ArtifactRef, HandoffPacket, JobStatus } from "./types";

function linesFor(text: string, heading: RegExp): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return [];
  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line.trim())) break;
    const value = line.replace(/^\s*[-*]\s*/, "").trim();
    if (value) result.push(value);
  }
  return result.slice(0, 30);
}

export function buildHandoffPacket(job: JobStatus): HandoffPacket {
  const result = job.result ?? "";
  const evidence: ArtifactRef[] = [
    { path: job.logPath, kind: "log", description: "Full harness output" },
  ];
  if (job.worktree) evidence.push({ path: job.worktree, kind: "worktree", description: "Worker worktree" });
  return {
    outcome: result.slice(0, 8000),
    changedFiles: linesFor(result, /^#{1,4}\s*(changed files|files changed)/i),
    commits: linesFor(result, /^#{1,4}\s*commits?/i),
    tests: linesFor(result, /^#{1,4}\s*(tests?|verification)/i),
    unresolvedRisks: linesFor(result, /^#{1,4}\s*(unresolved risks?|risks?|blockers?)/i),
    evidence,
    recommendedNextWorker: linesFor(result, /^#{1,4}\s*(next worker|next handoff|next steps?)/i)[0],
    artifacts: linesFor(result, /^#{1,4}\s*artifacts?/i).map((path) => ({ path })),
    decisions: linesFor(result, /^#{1,4}\s*decisions?/i),
  };
}

export function formatPacket(job: JobStatus): string {
  const packet = job.packet ?? buildHandoffPacket(job);
  const section = (name: string, values: string[]) =>
    values.length ? `## ${name}\n${values.map((value) => `- ${value}`).join("\n")}` : "";
  return [
    `# Worker Packet: ${job.title}`,
    `job: ${job.id}`,
    `state: ${job.state}`,
    `worker: ${job.harness}@${job.host}${job.model ? ` (${job.model})` : ""}`,
    job.branch ? `branch: ${job.branch}` : "",
    "",
    "## Outcome",
    packet.outcome,
    section("Changed Files", packet.changedFiles),
    section("Commits", packet.commits),
    section("Tests", packet.tests),
    section("Unresolved Risks", packet.unresolvedRisks),
    section("Decisions", packet.decisions),
    packet.recommendedNextWorker ? `## Recommended Next Worker\n${packet.recommendedNextWorker}` : "",
    packet.evidence.length
      ? `## Evidence\n${packet.evidence.map((value) => `- ${value.kind ?? "artifact"}: ${value.path}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");
}
