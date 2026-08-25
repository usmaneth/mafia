import type { ScaleDecision, ScaleInput } from "./types";

export function recommendParallelism(input: ScaleInput): ScaleDecision {
  const ceiling = Math.max(1, Math.min(
    128,
    input.maxParallel ?? 128,
    input.hostCapacity ?? 128,
    input.budgetWorkers ?? 128,
  ));
  const ready = Math.max(0, input.readyCount ?? input.taskCount);
  const running = Math.max(0, input.running ?? 0);
  const activeWork = Math.min(input.taskCount, ready + running);
  const failureRate = input.completed
    ? (input.failures ?? 0) / Math.max(1, input.completed)
    : 0;
  let target = activeWork;
  if (input.taskCount > 64 && !input.completed) target = Math.min(target, 64);
  if (input.taskCount > 64 && (input.completed ?? 0) >= 8 && failureRate < 0.1) target = activeWork;
  if (input.risk === "high") target = Math.min(target, 16);
  else if (input.risk === "medium") target = Math.min(target, 64);
  if (failureRate >= 0.25) target = Math.max(1, Math.ceil(target / 2));
  const recommendedParallel = Math.max(
    Math.min(ceiling, input.minParallel ?? 1),
    Math.min(ceiling, target),
  );
  return {
    recommendedParallel,
    ceiling,
    reasons: [
      `${ready} tasks are ready and ${running} tasks run`,
      `the host and budget ceiling is ${ceiling}`,
      input.taskCount > 64 && !input.completed ? "the first wave ramps at 64 workers" : "the team can use the full justified capacity",
      failureRate ? `the observed failure rate is ${(failureRate * 100).toFixed(1)}%` : "no failure penalty applies",
    ],
  };
}
