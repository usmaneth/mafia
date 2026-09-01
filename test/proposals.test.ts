import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProposal,
  canonicalRoleSelector,
  generateProposals,
  isFreeModel,
  measureOutcomes,
  ProposalStore,
  type ApplyDeps,
  type GenerationInputs,
  type Proposal,
} from "../src/proposals";
import { TelemetryStore } from "../src/telemetry-store";
import type { ModelCatalog, ModelRecord } from "../src/types";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "mafia-prop-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const model = (selector: string, provider: string, cost?: { input: number; output: number }): ModelRecord =>
  ({ harness: "omp", provider, id: selector.split("/").at(-1)!, selector, name: selector, source: "omp", available: true, cost }) as ModelRecord;

const catalog: ModelCatalog = {
  generatedAt: new Date().toISOString(),
  sources: [],
  models: [
    model("openai-codex/gpt-5.4-mini", "openai-codex", { input: 1, output: 4 }),
    // Bare observed name: cost unknown, matched by exact selector.
    { ...model("gpt-5.4", "openai-codex"), harness: "codex" } as ModelRecord,
    model("openai/gpt-5.4", "openai", { input: 2, output: 8 }),
    model("openrouter/nvidia/nemo:free", "openrouter", { input: 0, output: 0 }),
    model("google/gemini-flash", "google", { input: 0.1, output: 0.4 }),
  ],
};

const metrics = {
  "openai-codex/gpt-5.4-mini": { selector: "openai-codex/gpt-5.4-mini", ttftMs: 920, samples: 4 },
  "gpt-5.4": { selector: "gpt-5.4", ttftMs: 379, samples: 6 },
  "openrouter/nvidia/nemo:free": { selector: "openrouter/nvidia/nemo:free", ttftMs: 1067, samples: 5 },
  "google/gemini-flash": { selector: "google/gemini-flash", ttftMs: 3677, samples: 3 },
};

function inputs(over: Partial<GenerationInputs> = {}): GenerationInputs {
  return {
    configured: { smol: "openai-codex/gpt-5.4-mini", task: "openrouter/nvidia/nemo:free", designer: "google/gemini-flash" },
    catalog,
    usage: undefined,
    metrics,
    blocked: new Set(),
    prStates: [],
    stateRoot: root(),
    ...over,
  };
}

describe("what counts as free", () => {
  test("a :free tier is free", () => {
    expect(isFreeModel(model("a/b:free", "a", { input: 0, output: 0 }))).toBe(true);
  });

  test("explicit zero cost is free", () => {
    expect(isFreeModel(model("a/b", "a", { input: 0, output: 0 }))).toBe(true);
  });

  test("unknown cost is NOT free", () => {
    // The catalog has no pricing for detected models. Reading that absence as
    // free is how paid traffic quietly lands on a metered window.
    expect(isFreeModel(model("a/b", "a"))).toBe(false);
  });
});

describe("proposal generation", () => {
  test("a same-provider repin is automatic", () => {
    const smol = generateProposals(inputs()).find((p) => p.kind === "repin-role" && (p.payload as { role: string }).role === "smol");
    expect(smol?.auto).toBe(true);
    expect(smol?.tradeoff).toBeUndefined();
  });

  test("moving free work onto a metered provider asks first, and says why", () => {
    const task = generateProposals(inputs()).find((p) => (p.payload as { role?: string }).role === "task");
    expect(task?.auto).toBe(false);
    expect(task?.tradeoff).toContain("free work onto");
  });

  test("the written selector is provider-qualified, never a bare name", () => {
    // A bare name once resolved to a provider with a dead key. Every role
    // selector must name its provider so resolution cannot wander.
    for (const p of generateProposals(inputs()).filter((entry) => entry.kind === "repin-role")) {
      expect((p.payload as { to: string }).to).toContain("/");
    }
  });

  test("the id hashes the canonical target, so a fixed generator replaces stale rows", () => {
    const first = generateProposals(inputs()).find((p) => (p.payload as { role?: string }).role === "smol");
    expect(first!.id).toBe(generateProposals(inputs()).find((p) => (p.payload as { role?: string }).role === "smol")!.id);
  });

  test("proposes measuring heavy unmeasured models", () => {
    const state = root();
    const telemetry = new TelemetryStore(state);
    telemetry.ingest("f", "codex", 1, 1, 1, Array.from({ length: 501 }, (_, index) => ({
      id: `t${index}`, harness: "codex", sessionId: "s", startedAt: "2026-08-01T00:00:00.000Z",
      model: "mystery-model", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ok: 1,
    })) as never);
    const bench = generateProposals(inputs({ telemetry, stateRoot: state })).find((p) => p.kind === "bench-model");
    expect(bench?.evidence).toContain("mystery-model");
    expect(bench?.tradeoff).toContain("quota");
  });

  test("proposes the shepherd only for recent actionable states", () => {
    const fresh = generateProposals(inputs({
      prStates: [{ state: "ci-failing", observations: 3, last: new Date().toISOString() }],
    })).find((p) => p.kind === "run-shepherd");
    expect(fresh).toBeDefined();
    const stale = generateProposals(inputs({
      prStates: [{ state: "ci-failing", observations: 3, last: "2026-08-01T00:00:00.000Z" }],
    })).find((p) => p.kind === "run-shepherd");
    expect(stale).toBeUndefined();
  });
});

describe("canonical selectors", () => {
  test("qualifies a bare observed name with its provider", () => {
    expect(canonicalRoleSelector(catalog, "gpt-5.4")).toBe("openai-codex/gpt-5.4");
  });

  test("leaves an already-qualified selector alone", () => {
    expect(canonicalRoleSelector(catalog, "google/gemini-flash")).toBe("google/gemini-flash");
  });

  test("passes through a name the catalog does not know", () => {
    expect(canonicalRoleSelector(catalog, "unknown-model")).toBe("unknown-model");
  });
});

describe("the proposal store", () => {
  const proposal = (pid: string, over: Partial<Proposal> = {}): Proposal => ({
    id: pid, kind: "repin-role", title: "t", evidence: "e", effect: "f", action: "a",
    auto: true, payload: {}, state: "pending",
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...over,
  });

  test("a dismissed proposal is never re-created", () => {
    const store = new ProposalStore(root());
    store.upsertNew([proposal("aaa")]);
    store.setState("aaa", "dismissed", { dismissReason: "not worth it" });
    expect(store.upsertNew([proposal("aaa")])).toBe(0);
    expect(store.list()).toHaveLength(0);
    expect(store.get("aaa")?.state).toBe("dismissed");
  });

  test("a pending proposal absent from regeneration expires", () => {
    const store = new ProposalStore(root());
    store.upsertNew([proposal("aaa"), proposal("bbb")]);
    store.expireMissing(new Set(["bbb"]));
    expect(store.list().map((p) => p.id)).toEqual(["bbb"]);
    expect(store.get("aaa")?.state).toBe("expired");
  });

  test("a pending proposal keeps its identity but shows today's evidence", () => {
    // Measurements move. Advice displayed with last week's numbers reads as
    // broken even when the recommendation is still right.
    const store = new ProposalStore(root());
    store.upsertNew([proposal("aaa", { evidence: "old numbers" })]);
    store.upsertNew([proposal("aaa", { evidence: "new numbers" })]);
    const row = store.get("aaa")!;
    expect(row.evidence).toBe("new numbers");
    expect(row.createdAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("resolves a reference by pending position or by id prefix", () => {
    const store = new ProposalStore(root());
    store.upsertNew([proposal("abc123"), proposal("def456")]);
    expect(store.get("2")?.id).toBe("def456");
    expect(store.get("abc")?.id).toBe("abc123");
  });
});

describe("applying", () => {
  const deps = (over: Partial<ApplyDeps> = {}): ApplyDeps & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      setRoles: (_roles, changed) => { calls.push(`roles:${changed}`); return { ok: true, detail: "set" }; },
      bench: (models) => { calls.push(`bench:${models.join(",")}`); return { ok: true, detail: "measured" }; },
      shepherd: () => { calls.push("shepherd"); return { ok: true, detail: "started" }; },
      ...over,
    };
  };

  const stored = (store: ProposalStore, p: Proposal): Proposal => {
    store.upsertNew([p]);
    return store.get(p.id)!;
  };

  test("a manual proposal is approved, and nothing runs", () => {
    // Approval of a tradeoff is consent to the decision; the command stays the
    // operator's to run.
    const store = new ProposalStore(root());
    const d = deps();
    const p = stored(store, { id: "m1", kind: "repin-role", title: "t", evidence: "e", effect: "f", action: "a", auto: false, payload: { roles: {}, role: "task", from: "x" }, state: "pending", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
    const result = applyProposal(store, p, d);
    expect(result.detail).toContain("run it yourself");
    expect(d.calls).toHaveLength(0);
    expect(store.get("m1")?.state).toBe("approved");
  });

  test("an auto repin names the changed role to the gate", () => {
    const store = new ProposalStore(root());
    const d = deps();
    const p = stored(store, { id: "a1", kind: "repin-role", title: "t", evidence: "e", effect: "f", action: "a", auto: true, payload: { roles: { smol: "x/y" }, role: "smol", from: "old", fromMs: 900 }, state: "pending", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
    applyProposal(store, p, d);
    expect(d.calls).toEqual(["roles:smol"]);
    expect(store.get("a1")?.state).toBe("applied");
    expect(store.get("a1")?.before).toContain("900ms");
  });

  test("a failed apply is recorded as failed, with the reason", () => {
    const store = new ProposalStore(root());
    const d = deps({ setRoles: () => ({ ok: false, detail: "dead provider" }) });
    const p = stored(store, { id: "f1", kind: "repin-role", title: "t", evidence: "e", effect: "f", action: "a", auto: true, payload: { roles: {}, role: "smol", from: "old" }, state: "pending", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
    const result = applyProposal(store, p, d);
    expect(result.ok).toBe(false);
    expect(store.get("f1")?.state).toBe("failed");
    expect(store.get("f1")?.outcome).toContain("dead provider");
  });
});

describe("outcomes", () => {
  test("an applied repin records what it now measures", () => {
    const store = new ProposalStore(root());
    store.upsertNew([{ id: "o1", kind: "repin-role", title: "t", evidence: "e", effect: "f", action: "a", auto: true, payload: { to: "x/y", fromMs: 900 }, state: "pending", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }]);
    store.setState("o1", "applied");
    expect(measureOutcomes(store, { "x/y": { selector: "x/y", ttftMs: 300, samples: 4 } })).toBe(1);
    expect(store.get("o1")?.outcome).toContain("300ms");
    expect(store.get("o1")?.outcome).toContain("3.0x");
  });

  test("waits rather than inventing an outcome without data", () => {
    const store = new ProposalStore(root());
    store.upsertNew([{ id: "o2", kind: "repin-role", title: "t", evidence: "e", effect: "f", action: "a", auto: true, payload: { to: "x/y" }, state: "pending", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }]);
    store.setState("o2", "applied");
    expect(measureOutcomes(store, {})).toBe(0);
    expect(store.get("o2")?.outcome).toBeUndefined();
  });
});
