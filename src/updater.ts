import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";
import { loadConfig, repoRoot } from "./config";
import { ModelCatalogService } from "./models";
import { installRemote } from "./remote";

interface UpdateResult {
  target: string;
  status: "ok" | "skipped" | "error";
  detail: string;
}

function exec(command: string, args: string[], cwd = repoRoot): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });
  return { ok: result.status === 0, output: (result.stdout || result.stderr || "").trim() };
}

export function updateMafia(options: { push?: boolean; deploy?: boolean } = {}): UpdateResult[] {
  const results: UpdateResult[] = [];
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
  } catch (error) {
    results.push({ target: "model-catalog", status: "error", detail: error instanceof Error ? error.message : String(error) });
  }
  if (options.deploy) {
    for (const host of Object.values(loadConfig().hosts).filter((host) => host.kind === "ssh")) {
      try {
        installRemote(host);
        exec("ssh", [host.target!, "mkdir -p /home/usman/mafia"]);
        const sync = exec("rsync", [
          "-a", "--delete", "--exclude", ".git", "--exclude", "node_modules",
          `${repoRoot}/`, `${host.target!}:/home/usman/mafia/`,
        ]);
        results.push({ target: host.name, status: sync.ok ? "ok" : "error", detail: sync.output || "Worker and source deployed." });
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
    const service = `[Unit]\nDescription=Refresh Mafia and its model catalog\n[Service]\nType=oneshot\nUser=usman\nWorkingDirectory=/home/usman/mafia\nExecStart=/home/usman/.bun/bin/bun /home/usman/mafia/src/cli.ts update\n`;
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
