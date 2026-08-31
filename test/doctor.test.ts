import { describe, expect, test } from "bun:test";
import { formatDoctor } from "../src/doctor";
import type { Check } from "../src/doctor";

const check = (state: Check["state"], name = "thing", fix?: string): Check =>
  ({ name, state, detail: "detail", fix });

describe("doctor reporting", () => {
  test("every failing check names a fix", () => {
    // A health check that reports a problem without saying what to do about it
    // is a slower way of reading a log.
    const value = formatDoctor([check("fail", "disk", "mafia gc")]);
    expect(value).toContain("FAIL");
    expect(value).toContain("-> mafia gc");
  });

  test("summarises failures and warnings separately", () => {
    const value = formatDoctor([check("fail", "a", "x"), check("warn", "b", "y"), check("ok", "c")]);
    expect(value).toContain("1 failing, 1 warning");
  });

  test("says so plainly when nothing is wrong", () => {
    expect(formatDoctor([check("ok"), check("ok")])).toContain("everything healthy");
  });

  test("a healthy check prints no fix line", () => {
    expect(formatDoctor([check("ok")])).not.toContain("->");
  });

  test("counts only warnings when there are no failures", () => {
    expect(formatDoctor([check("warn", "a", "x"), check("ok")])).toContain("1 warning");
  });
});
