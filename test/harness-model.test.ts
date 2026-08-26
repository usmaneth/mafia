import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectHarnessModel } from "../src/harness-model";
import type { ModelCatalog } from "../src/types";

const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "mafia-harness-model-"));
  homes.push(path);
  return path;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("harness model detection", () => {
  test("reads the Codex default model", () => {
    const root = home();
    write(join(root, ".codex", "config.toml"), 'model = "gpt-5.6-sol"\n');
    expect(detectHarnessModel("codex", { home: root })).toBe("gpt-5.6-sol");
  });

  test("reads the Claude model and removes the context suffix", () => {
    const root = home();
    write(join(root, ".claude", "settings.json"), JSON.stringify({ model: "opus[1m]" }));
    expect(detectHarnessModel("claude", { home: root })).toBe("opus");
  });

  test("reads the Cline provider model", () => {
    const root = home();
    write(
      join(root, ".cline", "data", "settings", "providers.json"),
      JSON.stringify({ providers: { cline: { settings: { model: "moonshotai/kimi-k3" } } } }),
    );
    expect(detectHarnessModel("cline", { home: root })).toBe("moonshotai/kimi-k3");
  });

  test("reads the OMP Mafia profile model", () => {
    const root = home();
    write(
      join(root, ".omp", "profiles", "mafia", "agent", "config.yml"),
      "modelRoles:\n  default: google/gemini-3.7-flash:high\n",
    );
    expect(detectHarnessModel("omp", { home: root })).toBe("google/gemini-3.7-flash:high");
  });

  test("uses the Kimi K3 catalog entry when no config exists", () => {
    const catalog = {
      generatedAt: new Date().toISOString(),
      models: [{
        harness: "kimi",
        selector: "kimi-code/k3",
        provider: "kimi-code",
        id: "k3",
        name: "Kimi K3",
        source: "kimi",
        available: true,
      }],
      sources: [{ harness: "kimi", status: "ok", count: 1 }],
    } satisfies ModelCatalog;
    expect(detectHarnessModel("kimi", { home: home(), catalog })).toBe("kimi-code/k3");
  });
});
