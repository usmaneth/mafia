import { describe, expect, test } from "bun:test";
import { sshControlOptions, withSshMultiplexing } from "../src/ssh";
import { persistedToolPath, run, toolPath } from "../src/process";
import { report } from "../src/updater";

import { decodeSlice, wholeLines } from "../src/remote";
import { mirrorExcludes, mirrorIsHealthy, watchTriggersMirror } from "../src/mirror";
import type { MirrorReport } from "../src/types";

const target = "root@10.0.0.1";

describe("ssh multiplexing", () => {
  test("adds a control socket to an ssh call", () => {
    const args = withSshMultiplexing("ssh", [target, "true"]);
    expect(args).toContain("ControlMaster=auto");
    expect(args.at(-2)).toBe(target);
    expect(args.at(-1)).toBe("true");
  });

  test("adds a control socket to an scp call", () => {
    const args = withSshMultiplexing("scp", ["/tmp/worker.mjs", `${target}:/opt/mafia/worker.mjs`]);
    expect(args).toContain("ControlMaster=auto");
  });

  test("passes the transport to rsync through -e", () => {
    const args = withSshMultiplexing("rsync", ["-a", "/src/", `${target}:/dst/`]);
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain("ControlMaster=auto");
    expect(args[1]!.startsWith("ssh ")).toBe(true);
  });

  test("leaves a non-ssh command alone", () => {
    const args = ["status", "--porcelain"];
    expect(withSshMultiplexing("git", args)).toEqual(args);
  });

  test("does not treat a bare local file name as a host", () => {
    // A relative file name has no "@", so it must never become the control target.
    expect(withSshMultiplexing("scp", ["worker.mjs", "backup.mjs"])).toEqual(["worker.mjs", "backup.mjs"]);
  });

  test("keeps an explicit ControlPath from the caller", () => {
    const args = ["-o", "ControlPath=/tmp/mine.sock", target, "true"];
    expect(withSshMultiplexing("ssh", args)).toEqual(args);
  });

  test("the control socket path stays inside the platform limit", () => {
    const path = sshControlOptions(target).at(3) ?? "";
    expect(path.replace("ControlPath=", "").length).toBeLessThan(104);
  });

  test("bounds the connection attempt so a stalled master cannot hang forever", () => {
    // Without this a degraded link turned a two-second command into an
    // hour-long wait, because every client blocked on the shared socket.
    expect(withSshMultiplexing("ssh", [target, "true"])).toContain("ConnectTimeout=15");
  });

  test("does not override a timeout the caller already set", () => {
    // ssh keeps the first value it sees for an option, so a prepended default
    // would silently replace a caller's shorter timeout.
    const args = withSshMultiplexing("ssh", ["-o", "ConnectTimeout=5", target, "true"]);
    expect(args.filter((value) => value.startsWith("ConnectTimeout="))).toEqual(["ConnectTimeout=5"]);
  });

  test("bounds the rsync transport too", () => {
    const args = withSshMultiplexing("rsync", ["-a", "/src/", `${target}:/dst/`]);
    expect(args[1]).toContain("ConnectTimeout=15");
  });

  test("an operator can switch multiplexing off", () => {
    process.env.MAFIA_SSH_MULTIPLEX = "0";
    try {
      expect(withSshMultiplexing("ssh", [target, "true"])).toEqual([target, "true"]);
    } finally {
      delete process.env.MAFIA_SSH_MULTIPLEX;
    }
  });
});

describe("tool path", () => {
  test("adds the per-user binary directories that launchd omits", () => {
    const path = toolPath({ HOME: "/home/test", PATH: "/usr/bin:/bin" });
    expect(path).toContain("/home/test/.bun/bin");
    expect(path).toContain("/home/test/.local/bin");
    expect(path).toContain("/usr/bin");
  });

  test("keeps each directory once", () => {
    const entries = toolPath({ HOME: "/home/test", PATH: "/usr/bin:/bin:/usr/bin" }).split(":");
    expect(entries.length).toBe(new Set(entries).size);
  });

  test("works when the environment has no PATH at all", () => {
    expect(toolPath({ HOME: "/home/test" })).toContain("/home/test/.bun/bin");
  });
});

describe("update reporting", () => {
  test("never prints the success text for a failed command", () => {
    // The original defect: a failing command that printed nothing reported
    // status "error" next to "The TUI uses every available authenticated model."
    const value = report("omp-model-page", { ok: false, output: "" }, "Every model is available.");
    expect(value.status).toBe("error");
    expect(value.detail).not.toContain("Every model is available.");
    expect(value.detail).toContain("failed");
  });

  test("prefers real command output over the success text", () => {
    expect(report("t", { ok: true, output: "wrote 3 keys" }, "done").detail).toBe("wrote 3 keys");
  });

  test("falls back to the success text only when the command succeeded", () => {
    expect(report("t", { ok: true, output: "" }, "done")).toEqual({ target: "t", status: "ok", detail: "done" });
  });

  test("keeps the error output when the command printed one", () => {
    expect(report("t", { ok: false, output: "command not found" }, "done").detail).toBe("command not found");
  });
});

describe("event stream cursor", () => {
  test("reads the offset header and decodes the payload", () => {
    const payload = Buffer.from('{"id":"a"}\n').toString("base64");
    expect(decodeSlice(`OFFSET 10 21\n${payload}`)).toEqual({ from: 10, to: 21, text: '{"id":"a"}\n' });
  });

  test("returns nothing for a block without a header", () => {
    expect(decodeSlice("garbage")).toEqual({ from: 0, to: 0, text: "" });
  });

  test("handles an empty slice", () => {
    expect(decodeSlice("OFFSET 40 40\n")).toEqual({ from: 40, to: 40, text: "" });
  });

  test("advances the cursor by the whole lines it consumed", () => {
    const value = wholeLines(100, '{"a":1}\n{"b":2}\n');
    expect(value.consumed).toBe(100 + 16);
    expect(value.text).toBe('{"a":1}\n{"b":2}\n');
  });

  test("holds back a trailing partial line so the next read gets it whole", () => {
    // A writer caught mid-append leaves a line with no newline. Consuming it
    // would split one event across two reads and lose both halves.
    const value = wholeLines(0, '{"a":1}\n{"b":2');
    expect(value.consumed).toBe(8);
    expect(value.text).toBe('{"a":1}\n');
  });

  test("does not advance when no line is complete", () => {
    expect(wholeLines(500, '{"partial"')).toEqual({ consumed: 500, text: "" });
  });

  test("counts multi-byte characters as bytes, not characters", () => {
    const line = '{"t":"café"}\n';
    expect(wholeLines(0, line).consumed).toBe(Buffer.byteLength(line, "utf8"));
    expect(wholeLines(0, line).consumed).toBeGreaterThan(line.length);
  });
});

describe("watch filtering", () => {
  test("ignores git's internal churn", () => {
    // .git changes on every git command. Reacting would rebuild the manifest
    // constantly and copy nothing.
    expect(watchTriggersMirror(".git/index")).toBe(false);
    expect(watchTriggersMirror("src/.git/HEAD")).toBe(false);
  });

  test("ignores node_modules and build noise", () => {
    expect(watchTriggersMirror("node_modules/foo/index.js")).toBe(false);
    expect(watchTriggersMirror("src/.DS_Store")).toBe(false);
    expect(watchTriggersMirror("update.log")).toBe(false);
  });

  test("ignores the temporary names editors write before renaming", () => {
    expect(watchTriggersMirror("src/.#models.ts")).toBe(false);
    expect(watchTriggersMirror("src/models.ts~")).toBe(false);
    expect(watchTriggersMirror("src/models.ts.swp")).toBe(false);
    expect(watchTriggersMirror("src/status.json.4821.tmp")).toBe(false);
  });

  test("reacts to real source edits", () => {
    expect(watchTriggersMirror("src/models.ts")).toBe(true);
    expect(watchTriggersMirror("worker/worker.mjs")).toBe(true);
    expect(watchTriggersMirror("README.md")).toBe(true);
  });

  test("ignores an empty path", () => {
    expect(watchTriggersMirror("")).toBe(false);
  });

  test("does not mistake a file merely containing the word git", () => {
    expect(watchTriggersMirror("src/gitignore-parser.ts")).toBe(true);
  });
});

describe("mirror health", () => {
  const base: MirrorReport = {
    host: "vps",
    verdict: "synced",
    detail: "",
    localDigest: "a",
    remoteDigest: "a",
    changedFiles: 0,
    conflicts: [],
    durationMs: 1,
    checkedAt: new Date().toISOString(),
  };

  test("a fresh synced report is healthy", () => {
    expect(mirrorIsHealthy(base)).toBe(true);
  });

  test("a fresh current report is healthy", () => {
    expect(mirrorIsHealthy({ ...base, verdict: "current" })).toBe(true);
  });

  test("a conflict is never healthy", () => {
    expect(mirrorIsHealthy({ ...base, verdict: "conflict" })).toBe(false);
  });

  test("an unreachable host is never healthy", () => {
    expect(mirrorIsHealthy({ ...base, verdict: "unreachable" })).toBe(false);
  });

  test("a stale success is not healthy", () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(mirrorIsHealthy({ ...base, checkedAt: old })).toBe(false);
  });

  test("a missing report is not healthy", () => {
    expect(mirrorIsHealthy(undefined)).toBe(false);
  });

  test("the mirror never copies git or node_modules", () => {
    expect(mirrorExcludes).toContain(".git");
    expect(mirrorExcludes).toContain("node_modules");
  });
});

describe("child process output limits", () => {
  test("returns large output instead of raising it as an error", () => {
    // The defect: spawnSync defaults to a one megabyte output limit. Remote job
    // discovery passes that at about eighty jobs. On overflow spawnSync
    // truncates stdout and reports a null exit status, so `run` raised the
    // truncated job JSON as if the command had failed.
    const value = run("sh", ["-c", "yes abcdefghij | head -c 3000000"]);
    expect(value.length).toBeGreaterThan(2_000_000);
  });

  test("names the failing command when the binary does not exist", () => {
    expect(() => run("mafia-no-such-binary", [])).toThrow(/mafia-no-such-binary failed/);
  });

  test("raises the command's own error output when it exits non-zero", () => {
    expect(() => run("sh", ["-c", "echo boom >&2; exit 1"])).toThrow(/boom/);
  });
});

describe("persisted unit path", () => {
  test("carries only stable directories, not the current session's PATH", () => {
    // A unit file outlives the shell that wrote it. Baking in a plugin cache
    // directory leaves the timer pointing at a version that later disappears.
    const value = persistedToolPath({ HOME: "/home/test", PATH: "/tmp/plugin-cache/v1/bin:/usr/bin" });
    expect(value).not.toContain("plugin-cache");
    expect(value).toContain("/home/test/.bun/bin");
    expect(value).toContain("/usr/bin");
  });

  test("still finds the harness binaries the minimal system PATH omits", () => {
    expect(persistedToolPath({ HOME: "/home/test" })).toContain("/home/test/.bun/bin");
  });
});

