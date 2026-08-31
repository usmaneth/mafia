import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";
import { loadConfig, repoRoot } from "./config";
import { ModelCatalogService } from "./models";
import { installPrAutomation } from "./pr";
import { mirrorAll } from "./mirror";
import { collectAll } from "./gc";
import { persistedToolPath, shellQuote, toolEnvironment } from "./process";
import { withSshMultiplexing } from "./ssh";

interface UpdateResult {
  target: string;
  status: "ok" | "skipped" | "error";
  detail: string;
}

const disabledMcpServers = [
  "higgsfield",
  "figma:figma",
  "Notion:notion",
  "vercel:vercel",
  "telegram:telegram",
  "slack:slack",
];

export function codexOAuthModelRoles(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    smol: "openai-codex/gpt-5.4-mini",
    advisor: "openai-codex/gpt-5.6-sol",
  };
}

function exec(command: string, args: string[], cwd = repoRoot): { ok: boolean; output: string } {
  const result = spawnSync(command, withSshMultiplexing(command, args), {
    cwd,
    encoding: "utf8",
    env: toolEnvironment(),
    timeout: 180_000,
  });
  if (result.error) return { ok: false, output: result.error.message };
  return { ok: result.status === 0, output: (result.stdout || result.stderr || "").trim() };
}

/**
 * Report a command result without inventing a success message for a failure.
 *
 * The previous form was `detail: output || "<success text>"`. A command that
 * failed and printed nothing then reported the success text next to an error
 * status, which made a broken update read like a working one.
 */
export function report(target: string, result: { ok: boolean; output: string }, success: string): UpdateResult {
  return {
    target,
    status: result.ok ? "ok" : "error",
    detail: result.ok ? result.output || success : result.output || `${target} failed and printed nothing.`,
  };
}

function optimizeMafiaProfile(): UpdateResult {
  const config = exec("omp", ["--profile", "mafia", "config", "path"]);
  if (!config.ok || !config.output) {
    return { target: "omp-performance", status: "error", detail: config.output || "Cannot find the Mafia profile." };
  }
  const path = join(config.output, "mcp.json");
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  const current = Array.isArray(input.disabledServers) ? input.disabledServers.filter((item): item is string => typeof item === "string") : [];
  const value = { ...input, disabledServers: [...new Set([...current, ...disabledMcpServers])] };
  mkdirSync(config.output, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return {
    target: "omp-performance",
    status: "ok",
    detail: `Disabled ${disabledMcpServers.length} unauthenticated Mafia-only MCP connections.`,
  };
}

function configureCodexOAuthRoles(): UpdateResult {
  const current = exec("omp", ["--profile", "mafia", "config", "get", "modelRoles", "--json"]);
  if (!current.ok || !current.output) {
    return { target: "codex-oauth-routing", status: "error", detail: current.output || "Cannot read the model roles." };
  }
  try {
    const response = JSON.parse(current.output) as { value?: Record<string, unknown> };
    const roles = codexOAuthModelRoles(response.value ?? {});
    const update = exec("omp", [
      "--profile",
      "mafia",
      "config",
      "set",
      "modelRoles",
      JSON.stringify(roles),
    ]);
    return {
      target: "codex-oauth-routing",
      status: update.ok ? "ok" : "error",
      detail: update.ok
        ? "Mafia Codex roles use ChatGPT OAuth only."
        : update.output || "Cannot update the model roles.",
    };
  } catch (error) {
    return {
      target: "codex-oauth-routing",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function configureVpsFirst(): UpdateResult {
  const path = join(homedir(), ".config", "mafia", "config.json");
  try {
    const input = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const value = { ...input, version: Math.max(3, Number(input.version ?? 0)), defaultHost: "vps" };
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return { target: "execution-policy", status: "ok", detail: "Spawned Mafia workers default to the VPS." };
  } catch (error) {
    return {
      target: "execution-policy",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function updateMafia(options: { push?: boolean; deploy?: boolean; gcDays?: number } = {}): UpdateResult[] {
  const results: UpdateResult[] = [];
  results.push(configureVpsFirst());
  const remote = exec("git", ["remote"]);
  const dirty = exec("git", ["status", "--porcelain"]);
  if (!remote.output) {
    results.push({ target: "github", status: "skipped", detail: "No Git remote is configured." });
  } else if (dirty.output) {
    results.push({ target: "local-code", status: "skipped", detail: "The worktree has local changes." });
  } else {
    const pull = exec("git", ["pull", "--ff-only"]);
    results.push({ target: "local-code", status: pull.ok ? "ok" : "error", detail: pull.output || "Already current." });
    if (options.push) {
      const push = exec("git", ["push"]);
      results.push({ target: "github", status: push.ok ? "ok" : "error", detail: push.output });
    }
  }
  try {
    const catalog = new ModelCatalogService(loadConfig().stateRoot).discover(true);
    results.push({ target: "model-catalog", status: "ok", detail: `${catalog.models.length} models from ${catalog.sources.length} harnesses.` });
    results.push(report(
      "omp-model-page",
      exec("omp", ["--profile", "mafia", "config", "reset", "enabledModels"]),
      "The TUI uses every available authenticated model.",
    ));
    results.push(optimizeMafiaProfile());
    results.push(configureCodexOAuthRoles());
  } catch (error) {
    results.push({ target: "model-catalog", status: "error", detail: error instanceof Error ? error.message : String(error) });
  }
  if (options.deploy) {
    // The mirror copies the working tree, so a dirty checkout no longer stops
    // the deployment. It refuses only when the VPS holds work that the copy
    // would destroy.
    for (const mirror of mirrorAll()) {
      results.push({
        target: `${mirror.host}-mirror`,
        status: ["synced", "current"].includes(mirror.verdict)
          ? "ok"
          : mirror.verdict === "locked" ? "skipped" : "error",
        detail: mirror.conflicts.length
          ? `${mirror.detail} Remote-only: ${mirror.conflicts.join(", ")}`
          : mirror.detail,
      });
      if (["synced", "current"].includes(mirror.verdict) && mirror.host === "vps") {
        try {
          installPrAutomation();
          results.push({ target: "pr-automation", status: "ok", detail: "Installed the PR shepherd and safe merge timers." });
        } catch (error) {
          results.push({
            target: "pr-automation",
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  if (typeof options.gcDays === "number") {
    // Reclaim after the mirror, so a worktree removal can never race a copy.
    for (const collected of collectAll({ olderThanDays: options.gcDays })) {
      const megabytes = (collected.reclaimedBytes / 1_048_576).toFixed(1);
      results.push({
        target: `${collected.host}-gc`,
        status: collected.errors.length ? "error" : "ok",
        detail: collected.errors.length
          ? collected.errors.slice(0, 3).join("; ")
          : `Reclaimed ${megabytes} MB from finished jobs older than ${options.gcDays} day(s).`,
      });
    }
  }
  return results;
}

export function installUpdateAutomation(): UpdateResult[] {
  const results: UpdateResult[] = [];
  if (platform() === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", "dev.mafia.update.plist");
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    // launchd starts a job with a minimal environment: no PATH to the harness
    // binaries and none of the provider API keys the login profile exports.
    // Without the PATH key the update reported three errors on every run. A
    // login shell adds the provider keys, without which the model catalog
    // refresh silently drops every provider that authenticates by key. The
    // shell must be interactive as well as login, because zsh reads .zshrc
    // only for an interactive shell and three provider keys live there.
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.mafia.update</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>-ilc</string><string>${shellQuote(process.execPath)} ${shellQuote(join(repoRoot, "src", "cli.ts"))} update --deploy --gc 7</string></array>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>${persistedToolPath()}</string>
<key>HOME</key><string>${homedir()}</string>
</dict>
<key>StartInterval</key><integer>300</integer>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${join(homedir(), ".local", "share", "mafia", "update.log")}</string>
<key>StandardErrorPath</key><string>${join(homedir(), ".local", "share", "mafia", "update.err.log")}</string>
</dict></plist>
`);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    exec("launchctl", ["bootout", `gui/${uid}`, path]);
    const load = exec("launchctl", ["bootstrap", `gui/${uid}`, path]);
    results.push({ target: "local-timer", status: load.ok ? "ok" : "error", detail: load.ok ? path : load.output || "launchctl refused the job." });
  }
  for (const host of Object.values(loadConfig().hosts).filter((host) => host.kind === "ssh")) {
    const service = `[Unit]\nDescription=Refresh Mafia and its model catalog\n[Service]\nType=oneshot\nUser=usman\nEnvironment=HOME=/home/usman\nEnvironment=PATH=/home/usman/.bun/bin:/home/usman/.local/bin:/home/usman/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\nWorkingDirectory=/home/usman/mafia\nExecStart=/home/usman/.bun/bin/bun /home/usman/mafia/src/cli.ts update\n`;
    const timer = `[Unit]\nDescription=Refresh Mafia every 30 minutes\n[Timer]\nOnBootSec=5m\nOnUnitActiveSec=30m\nPersistent=true\n[Install]\nWantedBy=timers.target\n`;
    const encodedService = Buffer.from(service).toString("base64");
    const encodedTimer = Buffer.from(timer).toString("base64");
    const command = `printf %s ${encodedService} | base64 -d > /etc/systemd/system/mafia-update.service && ` +
      `printf %s ${encodedTimer} | base64 -d > /etc/systemd/system/mafia-update.timer && ` +
      `systemctl daemon-reload && systemctl enable --now mafia-update.timer`;
    const install = exec("ssh", [host.target!, command]);
    results.push({ target: `${host.name}-timer`, status: install.ok ? "ok" : "error", detail: install.output || "Installed." });
  }
  return results;
}
