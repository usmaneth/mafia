import { describe, expect, test } from "bun:test";
import { recommendParallelism } from "../src/scale";

describe("adaptive scale", () => {
  test("uses one worker for one task", () => {
    expect(recommendParallelism({ taskCount: 1 }).recommendedParallel).toBe(1);
  });

  test("ramps a 120 task first wave and reaches 100 plus after success", () => {
    expect(recommendParallelism({ taskCount: 120 }).recommendedParallel).toBe(64);
    expect(recommendParallelism({ taskCount: 120, completed: 16, failures: 0 }).recommendedParallel).toBe(120);
  });

  test("respects budget and failure pressure", () => {
    expect(recommendParallelism({ taskCount: 120, completed: 20, failures: 8, budgetWorkers: 40 }).recommendedParallel).toBe(40);
  });
});
