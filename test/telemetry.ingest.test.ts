import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestTelemetry, parseClaude, parseCodex } from "../src/telemetry-ingest";
import { TelemetryStore } from "../src/telemetry-store";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "mafia-tel-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const claudeLine = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant",
  sessionId: "s1",
  uuid: "u1",
  timestamp: "2026-08-01T00:00:00.000Z",
  message: {
    model: "claude-opus-5",
    usage: { input_tokens: 6, output_tokens: 100, cache_read_input_tokens: 34000, cache_creation_input_tokens: 12 },
  },
  ...over,
});

describe("claude sessions", () => {
  test("reads usage off assistant lines", () => {
    const [turn] = parseClaude([claudeLine()], "p");
    expect(turn!.model).toBe("claude-opus-5");
    expect(turn!.cacheReadTokens).toBe(34000);
    expect(turn!.outputTokens).toBe(100);
  });

  test("ignores line types that carry no usage", () => {
    // A session file is mostly user turns, attachments, and queue operations.
    const noise = [JSON.stringify({ type: "user", sessionId: "s1" }), JSON.stringify({ type: "attachment" })];
    expect(parseClaude(noise, "p")).toHaveLength(0);
  });

  test("survives a truncated line", () => {
    expect(parseClaude(['{"type":"assistant","messa'], "p")).toHaveLength(0);
  });

  test("gives a turn the same id every time, so re-reading cannot double count", () => {
    expect(parseClaude([claudeLine()], "p")[0]!.id).toBe(parseClaude([claudeLine()], "p")[0]!.id);
  });
});

const codexLines = (totals: Array<[number, number]>) => [
  JSON.stringify({ type: "session_meta", payload: { id: "c1", cwd: "/r" } }),
  JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
  ...totals.map(([input, output], index) => JSON.stringify({
    type: "event_msg",
    timestamp: `2026-04-0${index + 1}T00:00:00.000Z`,
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
  })),
];

describe("codex rollouts", () => {
  test("turns running totals into per-turn figures", () => {
    // Codex reports cumulative usage, so the naive read counts every earlier
    // turn again on every later one.
    const turns = parseCodex(codexLines([[100, 10], [250, 30]]), "p");
    expect(turns.map((turn) => turn.inputTokens)).toEqual([100, 150]);
    expect(turns.map((turn) => turn.outputTokens)).toEqual([10, 20]);
  });

  test("handles a total that fell after a compaction", () => {
    // The count restarts, so the rise would be negative. The new figure is the
    // turn.
    const turns = parseCodex(codexLines([[500, 50], [40, 4]]), "p");
    expect(turns[1]!.inputTokens).toBe(40);
  });

  test("carries the model from turn context onto each turn", () => {
    expect(parseCodex(codexLines([[10, 1]]), "p")[0]!.model).toBe("gpt-5.5");
  });
});

describe("incremental ingestion", () => {
  function corpus(): { state: string; sessions: string; file: string } {
    const state = root();
    const sessions = join(state, "sessions");
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "a.jsonl");
    writeFileSync(file, `${claudeLine()}\n`);
    return { state, sessions, file };
  }
  const source = (sessions: string) => [{ harness: "claude", roots: [sessions], parse: parseClaude }];

  test("reads a file once, then leaves it alone", () => {
    // Re-reading gigabytes on every pass is the thing this exists to avoid.
    const { state, sessions } = corpus();
    expect(ingestTelemetry(state, { sources: source(sessions) })[0]!.turns).toBe(1);
    const second = ingestTelemetry(state, { sources: source(sessions) })[0]!;
    expect(second.filesRead).toBe(0);
    expect(second.bytesRead).toBe(0);
  });

  test("picks up only what was appended", () => {
    const { state, sessions, file } = corpus();
    ingestTelemetry(state, { sources: source(sessions) });
    appendFileSync(file, `${claudeLine({ uuid: "u2", timestamp: "2026-08-02T00:00:00.000Z" })}\n`);
    const second = ingestTelemetry(state, { sources: source(sessions) })[0]!;
    expect(second.turns).toBe(1);
    expect(second.bytesRead).toBeLessThan(600);
  });

  test("never counts the same turn twice", () => {
    const { state, sessions, file } = corpus();
    ingestTelemetry(state, { sources: source(sessions) });
    // A rewrite from the top replays lines that were already recorded.
    writeFileSync(file, `${claudeLine()}\n${claudeLine({ uuid: "u2" })}\n`);
    ingestTelemetry(state, { sources: source(sessions) });
    const rows = new TelemetryStore(state).db.query("SELECT COUNT(*) c FROM turns").get() as { c: number };
    expect(rows.c).toBe(2);
  });

  test("leaves a half-written trailing line for the next pass", () => {
    // A session being written right now must not be split across two reads.
    const { state, sessions, file } = corpus();
    appendFileSync(file, '{"type":"assistant","mess');
    expect(ingestTelemetry(state, { sources: source(sessions) })[0]!.turns).toBe(1);
    appendFileSync(file, `age":{"model":"m","usage":{"output_tokens":1}},"sessionId":"s1","uuid":"u9","timestamp":"2026-08-03T00:00:00.000Z"}\n`);
    expect(ingestTelemetry(state, { sources: source(sessions) })[0]!.turns).toBe(1);
  });

  test("stops at the byte budget so one pass cannot run away", () => {
    const { state, sessions } = corpus();
    const report = ingestTelemetry(state, { sources: source(sessions), maxBytes: 0 })[0]!;
    expect(report.bytesRead).toBe(0);
  });

  test("starts over when a file shrinks", () => {
    const { state, sessions, file } = corpus();
    ingestTelemetry(state, { sources: source(sessions) });
    writeFileSync(file, `${claudeLine({ uuid: "fresh" })}\n`);
    expect(ingestTelemetry(state, { sources: source(sessions) })[0]!.turns).toBe(1);
  });
});
