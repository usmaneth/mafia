import { describe, expect, test } from "bun:test";
import { buildOmpArgs } from "../src/launch";

describe("Mafia OMP launch", () => {
  test("always enables yolo approval and keeps the design prompt", () => {
    const args = buildOmpArgs(["--model", "openai-codex/gpt-5.4"]);
    expect(args).toContain("--approval-mode");
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("yolo");
    expect(args).toContain("--auto-approve");
    expect(args).toContain("--append-system-prompt");
    expect(args.at(-2)).toBe("--model");
    expect(args.at(-1)).toBe("openai-codex/gpt-5.4");
  });
});
