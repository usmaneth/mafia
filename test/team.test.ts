import { describe, expect, test } from "bun:test";
import { validatePipeline } from "../src/team";

describe("team validation", () => {
  test("accepts 128 independent tasks", () => {
    expect(() => validatePipeline({
      name: "large-team",
      maxParallel: 128,
      tasks: Array.from({ length: 128 }, (_, index) => ({
        id: `worker-${index + 1}`,
        prompt: `Task ${index + 1}`,
      })),
    })).not.toThrow();
  });

  test("rejects cycles and teams above the limit", () => {
    expect(() => validatePipeline({
      name: "cycle",
      tasks: [
        { id: "a", prompt: "a", dependsOn: ["b"] },
        { id: "b", prompt: "b", dependsOn: ["a"] },
      ],
    })).toThrow("cycle");

    expect(() => validatePipeline({
      name: "too-large",
      tasks: Array.from({ length: 129 }, (_, index) => ({
        id: `worker-${index + 1}`,
        prompt: "task",
      })),
    })).toThrow("1 to 128");
  });
});
