import { describe, expect, test } from "bun:test";
import { bar, barChart, gauge, histogram, sparkline } from "../src/chart";
import { applyFixes, formatFixes, type Check } from "../src/doctor";

describe("charts", () => {
  test("draws a flat line for constant input rather than nothing", () => {
    // A flat series is a real answer; an empty string reads as missing data.
    expect(sparkline([5, 5, 5, 5]).length).toBe(4);
  });

  test("buckets by average so a spike cannot fall between samples", () => {
    // Sampling every nth point drops a one-off spike entirely.
    const values = new Array(100).fill(1);
    values[50] = 1000;
    expect(sparkline(values, 10)).not.toBe("▁".repeat(10));
  });

  test("returns nothing for no data", () => {
    expect(sparkline([])).toBe("");
  });

  test("bar clamps out-of-range fractions", () => {
    expect(bar(2, 10)).toBe("█".repeat(10));
    expect(bar(-1, 10)).toBe("·".repeat(10));
    expect(bar(Number.NaN, 10)).toBe("·".repeat(10));
  });

  test("bar chart scales to its largest row, not a fixed ceiling", () => {
    // Scaling to a ceiling makes every small value look identical.
    const value = barChart([{ label: "a", value: 2 }, { label: "b", value: 1 }], 10, 4);
    expect(value.split("\n")[0]).toContain("█".repeat(10));
    expect(value.split("\n")[1]).toContain("█".repeat(5));
  });

  test("bar chart survives every row being zero", () => {
    expect(() => barChart([{ label: "a", value: 0 }], 8, 4)).not.toThrow();
  });

  test("gauge marks a nearly full window differently from a quiet one", () => {
    // Colour does not survive every terminal, so fullness has to read from
    // the glyph itself.
    expect(gauge(0.99)).toContain("▓");
    expect(gauge(0.10)).toContain("░");
  });

  test("histogram places events in the right bucket and ignores old ones", () => {
    const now = Date.UTC(2026, 7, 31, 12, 0, 0);
    const counts = histogram([
      new Date(now - 1000).toISOString(),
      new Date(now - 40 * 3600_000).toISOString(),
    ], 24, now);
    expect(counts.at(-1)).toBe(1);
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(1);
  });
});

describe("doctor --fix", () => {
  const check = (name: string, state: Check["state"]): Check => ({ name, state, detail: "d", fix: "f" });

  test("runs a remedy that is safe to repeat", () => {
    const ran: string[][] = [];
    const results = applyFixes([check("mirror", "warn")], (args) => {
      ran.push(args);
      return { ok: true, out: "synced" };
    });
    expect(ran).toEqual([["mirror"]]);
    expect(results[0]!.ok).toBe(true);
  });

  test("never runs a remedy that would delete data", () => {
    // Reclaiming disk is a choice about how much history to keep, not a repair.
    const results = applyFixes([check("disk:vps", "fail")], () => ({ ok: true, out: "" }));
    expect(results[0]!.ran).toBe("");
    expect(formatFixes(results)).toContain("manual");
  });

  test("leaves healthy checks alone", () => {
    expect(applyFixes([check("mirror", "ok")], () => ({ ok: true, out: "" }))).toHaveLength(0);
  });

  test("reports a remedy that failed rather than claiming success", () => {
    const results = applyFixes([check("mirror", "fail")], () => ({ ok: false, out: "conflict" }));
    expect(results[0]!.ok).toBe(false);
    expect(formatFixes(results)).toContain("FAILED");
  });

  test("says so when nothing needed doing", () => {
    expect(formatFixes([])).toContain("nothing needed fixing");
  });
});

import { copyToClipboard, formatCopyTargets, osc52 } from "../src/clipboard";

describe("clipboard", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);

  test("osc52 wraps base64 in the escape frame terminals expect", () => {
    const value = osc52("job-123");
    expect(value.startsWith(ESC + "]52;c;")).toBe(true);
    expect(value.endsWith(BEL)).toBe(true);
    expect(Buffer.from(value.slice(7, -1), "base64").toString()).toBe("job-123");
  });

  // The round trip needs pbcopy and a controlling terminal, so it runs only
  // where those exist. CI is a Linux runner with neither, and asserting a
  // clipboard there tests the runner, not the code.
  test.if(process.platform === "darwin")("a copy actually lands on this machine's clipboard", () => {
    const result = copyToClipboard("mafia-clipboard-test-value");
    expect(result.ok).toBe(true);
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const paste = spawnSync("pbpaste", [], { encoding: "utf8" });
    expect(paste.stdout).toBe("mafia-clipboard-test-value");
  });

  test("oversized text is truncated, and says so", () => {
    // Terminals cap OSC 52 payloads; silent dropping would look like a broken
    // clipboard rather than a size limit. Whether a clipboard path exists is
    // the environment's business; the truncation flag is ours.
    const result = copyToClipboard("x".repeat(100_000));
    expect(result.truncated).toBe(true);
  });

  test("targets render as a digit-addressable list", () => {
    const lines = formatCopyTargets([{ label: "job noop", text: "job-123" }]);
    expect(lines[0]).toContain("[1]");
    expect(lines[0]).toContain("job-123");
  });

  test("an empty list says so instead of showing nothing", () => {
    expect(formatCopyTargets([])[0]).toContain("nothing here to copy");
  });
});
