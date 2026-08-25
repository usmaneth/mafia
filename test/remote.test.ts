import { describe, expect, test } from "bun:test";
import { repoSlugFromOrigin } from "../src/remote";

describe("remote workspaces", () => {
  test("maps HTTPS and SSH GitHub origins", () => {
    expect(repoSlugFromOrigin("https://github.com/zeta-chain/ai-portal.git")).toBe("zeta-chain/ai-portal");
    expect(repoSlugFromOrigin("git@github.com:anuma-ai/nearby.git")).toBe("anuma-ai/nearby");
    expect(repoSlugFromOrigin("https://gitlab.com/example/repo.git")).toBeUndefined();
  });
});
