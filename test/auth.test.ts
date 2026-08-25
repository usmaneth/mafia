import { describe, expect, test } from "bun:test";
import { codexOAuthEnvironment } from "../src/process";
import { codexOAuthModelRoles } from "../src/updater";

describe("Codex OAuth enforcement", () => {
  test("removes OpenAI API credentials from Mafia child processes", () => {
    const environment = codexOAuthEnvironment({
      HOME: "/tmp/home",
      OPENAI_API_KEY: "api-key",
      CODEX_API_KEY: "codex-key",
      ANTHROPIC_API_KEY: "keep",
    });

    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.CODEX_API_KEY).toBeUndefined();
    expect(environment.ANTHROPIC_API_KEY).toBe("keep");
    expect(environment.HOME).toBe("/tmp/home");
  });

  test("routes every OMP Codex role through the OAuth provider", () => {
    const roles = codexOAuthModelRoles({
      default: "anthropic/claude-sonnet-5:high",
      smol: "openai/gpt-5.6-luna-pro",
      advisor: "openai/gpt-5.6-sol-pro",
    });

    expect(roles.default).toBe("anthropic/claude-sonnet-5:high");
    expect(roles.smol).toBe("openai-codex/gpt-5.4-mini");
    expect(roles.advisor).toBe("openai-codex/gpt-5.6-sol");
  });
});
