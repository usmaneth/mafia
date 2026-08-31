import { describe, expect, test } from "bun:test";
import { acpHarnesses, speaksAcp } from "../src/acp";

describe("acp harnesses", () => {
  test("knows which harnesses speak the protocol", () => {
    expect(speaksAcp("omp")).toBe(true);
    expect(speaksAcp("cline")).toBe(true);
    // The rest still need their own argv and output parsing.
    expect(speaksAcp("codex")).toBe(false);
    expect(speaksAcp("kimi")).toBe(false);
  });

  test("omp is started as a stdio server on the mafia profile", () => {
    const spec = acpHarnesses.omp!("/repo");
    expect(spec.command).toBe("omp");
    expect(spec.args).toContain("acp");
    expect(spec.args.join(" ")).toContain("--profile mafia");
  });

  test("passes a model through when one is chosen", () => {
    expect(acpHarnesses.omp!("/repo", "anthropic/claude-opus-5").args).toContain("anthropic/claude-opus-5");
  });

  test("omits the model flag when none is chosen", () => {
    expect(acpHarnesses.omp!("/repo").args).not.toContain("--model");
  });
});
