import type { PipelineSpec, TeamProtocolName } from "./types";

export function protocolSpec(name: TeamProtocolName, goal: string, repo?: string): PipelineSpec {
  const task = (id: string, title: string, prompt: string, dependsOn: string[] = []) => ({
    id,
    title,
    prompt,
    dependsOn,
    repo,
    isolate: true,
  });
  const specs: Record<TeamProtocolName, PipelineSpec> = {
    "builder-reviewer": {
      name,
      protocol: name,
      tasks: [
        { ...task("builder", "Build the change", `${goal}\nImplement the complete change and run focused tests.`), capability: "implementation" },
        { ...task("reviewer", "Attack the implementation", `${goal}\nReview the builder result. Find defects and missing tests.`, ["builder"]), capability: "review" },
        { ...task("final", "Resolve review findings", `${goal}\nResolve valid findings and verify the final result.`, ["reviewer"]), capability: "implementation" },
      ],
    },
    "three-way-implementation": {
      name,
      protocol: name,
      tasks: [
        { ...task("solution-a", "Independent solution A", goal), capability: "implementation" },
        { ...task("solution-b", "Independent solution B", goal), capability: "implementation" },
        { ...task("solution-c", "Independent solution C", goal), capability: "implementation" },
        { ...task("judge", "Select the best solution", `${goal}\nCompare all solutions. Select one and explain the evidence.`, ["solution-a", "solution-b", "solution-c"]), capability: "synthesis" },
      ],
    },
    "research-council": {
      name,
      protocol: name,
      tasks: [
        { ...task("research-a", "Primary research", goal), capability: "research" },
        { ...task("research-b", "Independent research", goal), capability: "research" },
        { ...task("evidence", "Verify evidence", `${goal}\nVerify claims and reject unsupported conclusions.`, ["research-a", "research-b"]), capability: "review" },
        { ...task("synthesis", "Synthesize research", goal, ["evidence"]), capability: "synthesis" },
      ],
    },
    "pr-council": {
      name,
      protocol: name,
      tasks: [
        { ...task("correctness", "Correctness review", goal), capability: "review" },
        { ...task("security", "Security review", goal), capability: "security" },
        { ...task("tests", "Test review", goal), capability: "testing" },
        { ...task("architecture", "Architecture review", goal), capability: "architecture" },
        { ...task("final", "Final review", goal, ["correctness", "security", "tests", "architecture"]), capability: "synthesis" },
      ],
    },
    "migration-factory": {
      name,
      protocol: name,
      tasks: [
        { ...task("inventory", "Inventory migration surface", goal), capability: "research" },
        { ...task("batch-a", "Migration batch A", goal, ["inventory"]), capability: "implementation" },
        { ...task("batch-b", "Migration batch B", goal, ["inventory"]), capability: "implementation" },
        { ...task("integration", "Integrate migration batches", goal, ["batch-a", "batch-b"]), capability: "implementation" },
        { ...task("verification", "Verify migration", goal, ["integration"]), capability: "testing" },
      ],
    },
    "incident-room": {
      name,
      protocol: name,
      tasks: [
        { ...task("investigator", "Investigate the incident", goal), capability: "research" },
        { ...task("reproducer", "Reproduce the incident", goal), capability: "testing" },
        { ...task("log-analyst", "Analyze logs", goal), capability: "research" },
        { ...task("fix-owner", "Implement the fix", goal, ["investigator", "reproducer", "log-analyst"]), capability: "implementation" },
        { ...task("verifier", "Verify the fix", goal, ["fix-owner"]), capability: "testing" },
      ],
    },
    "design-council": {
      name,
      protocol: name,
      tasks: [
        { ...task("design-a", "Design option A", goal), capability: "architecture" },
        { ...task("design-b", "Design option B", goal), capability: "architecture" },
        { ...task("critic", "Challenge both designs", goal, ["design-a", "design-b"]), capability: "review" },
        { ...task("decision", "Prepare user decision", `${goal}\nPresent two or three options. Put the recommendation first.`, ["critic"]), capability: "synthesis" },
      ],
    },
  };
  return specs[name];
}
