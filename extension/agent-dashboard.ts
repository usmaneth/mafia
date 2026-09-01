import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth } from "@oh-my-pi/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../src/config";
import {
  agentDashboardJobs,
  formatAgentDashboard,
  formatAgentDetail,
  type AgentDashboardFilter,
} from "../src/format";
import { MafiaService } from "../src/service";
import { copyToClipboard } from "../src/clipboard";
import type { JobStatus } from "../src/types";

const filters: AgentDashboardFilter[] = ["active", "all", "failed", "vps", "local"];
const MAX_LOG_BYTES = 128 * 1024;

export async function showAgentDashboard(ctx: ExtensionCommandContext): Promise<void> {
  const mafia = new MafiaService();
  let jobs = mafia.listCached(500);
  let filterIndex = 0;
  let scrollOffset = 0;
  let selectedIndex = 0;
  let detailOpen = false;
  let detailScrollOffset = 0;
  let detailLogs = "";
  let operation = "";
  let refreshProcess: ChildProcess | undefined;
  let logProcess: ChildProcess | undefined;
  let actionProcess: ChildProcess | undefined;
  let closed = false;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const requestRender = (): void => tui.requestRender();
      const filteredJobs = (): JobStatus[] => agentDashboardJobs(jobs, filters[filterIndex]);
      const selectedJob = (): JobStatus | undefined => filteredJobs()[selectedIndex];
      const keepSelectionValid = (selectedId?: string): void => {
        const selected = filteredJobs();
        if (!selected.length) {
          selectedIndex = 0;
          detailOpen = false;
          return;
        }
        const retained = selectedId ? selected.findIndex((job) => job.id === selectedId) : -1;
        selectedIndex = retained >= 0 ? retained : Math.min(selectedIndex, selected.length - 1);
      };
      const loadCache = (): void => {
        const selectedId = selectedJob()?.id;
        jobs = mafia.listCached(500);
        keepSelectionValid(selectedId);
        requestRender();
      };
      const runCli = (
        args: string[],
        onOutput: (output: string) => void,
        setProcess: (process: ChildProcess | undefined) => void,
      ): void => {
        const child = spawn(process.execPath, [join(repoRoot, "src", "cli.ts"), ...args], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        setProcess(child);
        let output = "";
        const collect = (chunk: Buffer): void => {
          output = `${output}${chunk.toString()}`.slice(-MAX_LOG_BYTES);
        };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        let completed = false;
        const complete = (): void => {
          if (completed) return;
          completed = true;
          setProcess(undefined);
          onOutput(output.trim());
          loadCache();
        };
        child.once("exit", complete);
        child.once("error", complete);
      };
      const loadLogs = (): void => {
        const job = selectedJob();
        if (!job || logProcess) return;
        detailLogs = "";
        operation = "loading logs";
        runCli(
          ["logs", job.id, "--lines", "40"],
          (output) => {
            detailLogs = output;
            operation = "";
          },
          (process) => {
            logProcess = process;
          },
        );
      };
      const cancelSelected = (): void => {
        const job = selectedJob();
        if (!job || actionProcess || !["queued", "starting", "running"].includes(job.state)) return;
        operation = `cancelling ${job.id}`;
        runCli(
          ["cancel", job.id],
          (output) => {
            operation = output || "cancel signal sent";
          },
          (process) => {
            actionProcess = process;
          },
        );
      };
      const refresh = (): void => {
        if (refreshProcess) return;
        refreshProcess = spawn(process.execPath, [
          join(repoRoot, "src", "cli.ts"), "sync", "--discover",
        ], { cwd: repoRoot, stdio: "ignore" });
        requestRender();
        const complete = (): void => {
          refreshProcess = undefined;
          loadCache();
          if (!closed) requestRender();
        };
        refreshProcess.once("exit", complete);
        refreshProcess.once("error", complete);
      };
      const cacheTimer = ctx.setInterval(loadCache, 2000);
      const refreshTimer = ctx.setInterval(refresh, 10_000);
      refresh();

      return {
        render(width: number): readonly string[] {
          const terminalRows = process.stdout.rows ?? 40;
          const filter = filters[filterIndex];
          const selected = selectedJob();
          const text = detailOpen && selected
            ? formatAgentDetail(selected, detailLogs)
            : formatAgentDashboard(jobs, filter, { selectedId: selected?.id });
          const body = text.split("\n").map((line) => {
            const text = /^== .* ==$/.test(line)
              ? theme.fg("accent", theme.bold(line))
              : line.startsWith("> ")
                ? theme.fg("accent", theme.bold(line))
              : line.includes(" failed") || line.startsWith("failed")
                ? theme.fg("error", line)
                : line;
            return truncateToWidth(text, width);
          });
          const viewportRows = Math.max(6, terminalRows - 4);
          const maxScroll = Math.max(0, body.length - viewportRows);
          const currentScroll = detailOpen ? detailScrollOffset : scrollOffset;
          const boundedScroll = Math.min(currentScroll, maxScroll);
          if (detailOpen) detailScrollOffset = boundedScroll;
          else scrollOffset = boundedScroll;
          const scrollView = new ScrollView(body.slice(boundedScroll, boundedScroll + viewportRows), {
            height: viewportRows,
            scrollbar: "auto",
            totalRows: body.length,
            theme: {
              track: (text) => theme.fg("dim", text),
              thumb: (text) => theme.fg("accent", text),
            },
          });
          scrollView.setScrollOffset(boundedScroll);
          const footer = detailOpen
            ? ` Esc back | r refresh | y copy id | l logs | x cancel | arrows/page scroll | ${operation || selected?.state || ""} `
            : ` q close | Enter details | y copy id | f view | r refresh | j/k select | ` +
              `${refreshProcess ? "syncing VPS" : filter} `;
          return [
            truncateToWidth(theme.fg("accent", theme.bold(detailOpen ? " Mafia Agent Detail " : " Mafia Agent Hub ")), width),
            ...scrollView.render(width),
            truncateToWidth(theme.fg("dim", footer), width),
          ];
        },
        handleInput(data: string): void {
          const viewportRows = Math.max(6, (process.stdout.rows ?? 40) - 4);
          const selected = filteredJobs();
          if (detailOpen) {
            const lineCount = selectedJob() ? formatAgentDetail(selectedJob()!, detailLogs).split("\n").length : 0;
            const maxScroll = Math.max(0, lineCount - viewportRows);
            if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
              detailOpen = false;
              detailScrollOffset = 0;
            } else if (data === "q") {
              done(undefined);
              return;
            } else if (data === "r") {
              refresh();
              loadLogs();
            } else if (data === "l") {
              loadLogs();
            } else if (data === "x") {
              cancelSelected();
            } else if (matchesKey(data, "up") || data === "k") {
              detailScrollOffset = Math.max(0, detailScrollOffset - 1);
            } else if (matchesKey(data, "down") || data === "j") {
              detailScrollOffset = Math.min(maxScroll, detailScrollOffset + 1);
            } else if (matchesKey(data, "pageUp")) {
              detailScrollOffset = Math.max(0, detailScrollOffset - viewportRows);
            } else if (matchesKey(data, "pageDown")) {
              detailScrollOffset = Math.min(maxScroll, detailScrollOffset + viewportRows);
            } else if (data === "g") {
              detailScrollOffset = 0;
            } else if (data === "G") {
              detailScrollOffset = maxScroll;
            } else if (data === "y" && selectedJob()) {
              // Mouse selection cannot reach this text - the TUI owns the
              // mouse - so the id is yanked straight to the clipboard, where
              // `mafia why` and `mafia logs` want it.
              const yank = copyToClipboard(selectedJob()!.id);
              operation = yank.ok ? `copied ${selectedJob()!.id}` : "copy failed";
            }
            requestRender();
            return;
          }
          if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
            done(undefined);
            return;
          }
          if (data === "r") {
            refresh();
          } else if (data === "y" && selectedJob()) {
            const yank = copyToClipboard(selectedJob()!.id);
            operation = yank.ok ? `copied ${selectedJob()!.id}` : "copy failed";
          } else if (data === "f" || matchesKey(data, "tab")) {
            filterIndex = (filterIndex + 1) % filters.length;
            scrollOffset = 0;
            selectedIndex = 0;
          } else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || data === "\r") {
            if (selected.length) {
              detailOpen = true;
              detailScrollOffset = 0;
              loadLogs();
            }
          } else if (matchesKey(data, "up") || data === "k") {
            selectedIndex = Math.max(0, selectedIndex - 1);
          } else if (matchesKey(data, "down") || data === "j") {
            selectedIndex = Math.min(Math.max(0, selected.length - 1), selectedIndex + 1);
          } else if (matchesKey(data, "pageUp")) {
            selectedIndex = Math.max(0, selectedIndex - viewportRows);
          } else if (matchesKey(data, "pageDown")) {
            selectedIndex = Math.min(Math.max(0, selected.length - 1), selectedIndex + viewportRows);
          } else if (data === "g") {
            selectedIndex = 0;
          } else if (data === "G") {
            selectedIndex = Math.max(0, selected.length - 1);
          }
          const activeRows = jobs.filter((job) => ["queued", "starting", "running"].includes(job.state)).length;
          const rowOffset = 8 + (activeRows ? Math.min(activeRows, 12) : 1) + selectedIndex;
          if (rowOffset < scrollOffset) scrollOffset = rowOffset;
          if (rowOffset >= scrollOffset + viewportRows) scrollOffset = rowOffset - viewportRows + 1;
          requestRender();
        },
        invalidate(): void {},
        dispose(): void {
          closed = true;
          ctx.clearTimer(cacheTimer);
          ctx.clearTimer(refreshTimer);
          refreshProcess?.kill();
          logProcess?.kill();
          actionProcess?.kill();
        },
      };
    },
    { overlay: true },
  );
}
