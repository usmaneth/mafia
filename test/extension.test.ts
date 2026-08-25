import { describe, expect, test } from "bun:test";
import { sessionUsesVibeMode } from "../extension";

describe("Mafia extension mode policy", () => {
  test("blocks entry into Vibe mode from a normal session", () => {
    expect(sessionUsesVibeMode([])).toBe(false);
    expect(sessionUsesVibeMode([{ type: "mode_change", mode: "none" }])).toBe(false);
  });

  test("allows the native toggle to exit an already resumed Vibe session", () => {
    expect(sessionUsesVibeMode([
      { type: "mode_change", mode: "none" },
      { type: "mode_change", mode: "vibe" },
    ])).toBe(true);
    expect(sessionUsesVibeMode([
      { type: "mode_change", mode: "vibe" },
      { type: "mode_change", mode: "none" },
    ])).toBe(false);
  });
});
