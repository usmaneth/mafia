import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";
import { loadConfig, repoRoot } from "./config";
import { ModelCatalogService } from "./models";
import { installRemote } from "./remote";
import { installPrAutomation } from "./pr";

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
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });
  return { ok: result.status === 0, output: (result.stdout || result.stderr || "").trim() };
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

export function updateMafia(options: { push?: boolean; deploy?: boolean } = {}): UpdateResult[] {
  const results: UpdateResult[] = [];
  const remote = exec("git", ["remote"]);
  const dirty = exec("git", ["status", "--porcelain"]);
  const clean = dirty.ok && !dirty.output;
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
    const ompScope = exec("omp", ["--profile", "mafia", "config", "reset", "enabledModels"]);
    results.push({
      target: "omp-model-page",
      status: ompScope.ok ? "ok" : "error",
      detail: ompScope.output || "The TUI uses every available authenticated model.",
    });
    results.push(optimizeMafiaProfile());
    results.push(configureCodexOAuthRoles());
  } catch (error) {
    results.push({ target: "model-catalog", status: "error", detail: error instanceof Error ? error.message : String(error) });
  }
  if (options.deploy && !clean) {
    results.push({ target: "vps", status: "skipped", detail: "The local worktree has changes. Commit them before deployment." });
  } else if (options.deploy) {
    for (const host of Object.values(loadConfig().hosts).filter((host) => host.kind === "ssh")) {
      try {
        installRemote(host);
        exec("ssh", [host.target!, "mkdir -p /home/usman/mafia"]);
        const sync = exec("rsync", [
          "-a", "--delete", "--exclude", ".git", "--exclude", "node_modules",
          `${repoRoot}/`, `${host.target!}:/home/usman/mafia/`,
        ]);
        results.push({ target: host.name, status: sync.ok ? "ok" : "error", detail: sync.output || "Worker and source deployed." });
        if (sync.ok && host.name === "vps") {
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
      } catch (error) {
        results.push({ target: host.name, status: "error", detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return results;
}

export function installUpdateAutomation(): UpdateResult[] {
  const results: UpdateResult[] = [];
  if (platform() === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", "dev.mafia.update.plist");
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.mafia.update</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${join(repoRoot, "src", "cli.ts")}</string><string>update</string><string>--deploy</string></array>
<key>StartInterval</key><integer>1800</integer>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${join(homedir(), ".local", "share", "mafia", "update.log")}</string>
<key>StandardErrorPath</key><string>${join(homedir(), ".local", "share", "mafia", "update.err.log")}</string>
</dict></plist>
`);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    exec("launchctl", ["bootout", `gui/${uid}`, path]);
    const load = exec("launchctl", ["bootstrap", `gui/${uid}`, path]);
    results.push({ target: "local-timer", status: load.ok ? "ok" : "error", detail: path });
  }
  for (const host of Object.values(loadConfig().hosts).filter((host) => host.kind === "ssh")) {
    const service = `[Unit]\nDescription=Refresh Mafia and its model catalog\n[Service]\nType=oneshot\nUser=usman\nEnvironment=HOME=/home/usman\nEnvironment=PATH=/home/usman/.local/bin:/home/usman/.bun/bin:/usr/local/bin:/usr/bin:/bin\nWorkingDirectory=/home/usman/mafia\nExecStart=/home/usman/.bun/bin/bun /home/usman/mafia/src/cli.ts update\n`;
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
