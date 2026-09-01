import { describe, expect, test } from "bun:test";
import { formatResultProblems, resultProblems } from "../src/result-quality";
import type { JobStatus } from "../src/types";

const job = (over: Partial<JobStatus> = {}): JobStatus => ({
  id: "j1", title: "", prompt: "", harness: "omp", host: "vps", state: "succeeded",
  isolate: false, labels: [], createdAt: "", stateRoot: "/s", timeoutSeconds: 60,
  updatedAt: "", logPath: "", ...over,
}) as JobStatus;

describe("silent extraction failures", () => {
  test("flags a succeeded job with no result at all", () => {
    expect(resultProblems([job({ result: "   " })])[0]!.kind).toBe("empty");
  });

  test("flags a raw transport record left in place of the answer", () => {
    // This is the real observed failure: OMP's session header ends up as the
    // result, and the job still reports success.
    const value = resultProblems([job({ result: '{"type":"session","version":3,"id":"01a0"' })]);
    expect(value[0]!.kind).toBe("unparsed");
    expect(value[0]!.detail).toContain("session");
  });

  test("catches a truncated record even though it cannot be parsed", () => {
    // The extractor keeps only the tail of a long stream, so these never parse.
    // Requiring a successful parse made the check miss every real case.
    expect(resultProblems([job({ result: '{"foo":"bar","baz":' })])).toHaveLength(1);
  });

  test("leaves a failed job alone", () => {
    // Its result is usually the provider's error, which is what a reader wants.
    expect(resultProblems([job({ state: "failed", result: '{"type":"error","msg":"quota"}' })])).toHaveLength(0);
  });

  test("accepts a short but real answer", () => {
    // Short is not broken. "ready. what's the task?" is a valid reply.
    expect(resultProblems([job({ result: "ack. what do you need?" })])).toHaveLength(0);
  });

  test("accepts prose that happens to start with a brace", () => {
    expect(resultProblems([job({ result: '{ this is not json } and here is the answer' })])).toHaveLength(0);
  });

  test("accepts a well-formed JSON answer the agent meant to return", () => {
    // A structured reply is a real result when it is not a transport record.
    expect(resultProblems([job({ result: '{"findings":[],"verdict":"clean"}' })])).toHaveLength(0);
  });

  test("groups by harness so a changed output shape is obvious", () => {
    const value = formatResultProblems(resultProblems([
      job({ id: "a", harness: "omp", result: '{"type":"session"' }),
      job({ id: "b", harness: "omp", result: "" }),
    ]));
    expect(value).toContain("omp");
    expect(value).toContain("2");
  });

  test("says so plainly when everything is fine", () => {
    expect(formatResultProblems([])).toContain("every finished job produced a usable result");
  });
});
