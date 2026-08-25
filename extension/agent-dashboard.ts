import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth } from "@oh-my-pi/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../src/config";
import { formatAgentDashboard, type AgentDashboardFilter } from "../src/format";
import { MafiaService } from "../src/service";

const filters: AgentDashboardFilter[] = ["active", "all", "failed", "vps", "local"];

export async function showAgentDashboard(ctx: ExtensionCommandContext): Promise<void> {
  const mafia = new MafiaService();
  let jobs = mafia.listCached(500);
  let filterIndex = 0;
  let scrollOffset = 0;
  let refreshProcess: ChildProcess | undefined;
  let closed = false;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const requestRender = (): void => tui.requestRender();
      const loadCache = (): void => {
        jobs = mafia.listCached(500);
        requestRender();
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
          const body = formatAgentDashboard(jobs, filter).split("\n").map((line) => {
            const text = /^== .* ==$/.test(line)
              ? theme.fg("accent", theme.bold(line))
              : line.includes(" failed") || line.startsWith("failed")
                ? theme.fg("error", line)
                : line;
            return truncateToWidth(text, width);
          });
          const viewportRows = Math.max(6, terminalRows - 4);
          const maxScroll = Math.max(0, body.length - viewportRows);
          if (scrollOffset > maxScroll) scrollOffset = maxScroll;
          const scrollView = new ScrollView(body.slice(scrollOffset, scrollOffset + viewportRows), {
            height: viewportRows,
            scrollbar: "auto",
            totalRows: body.length,
            theme: {
              track: (text) => theme.fg("dim", text),
              thumb: (text) => theme.fg("accent", text),
            },
          });
          scrollView.setScrollOffset(scrollOffset);
          const footer = ` q close | r refresh | f next view | arrows/page scroll | ` +
            `${refreshProcess ? "syncing VPS" : filter} `;
          return [
            truncateToWidth(theme.fg("accent", theme.bold(" Mafia Agent Hub ")), width),
            ...scrollView.render(width),
            truncateToWidth(theme.fg("dim", footer), width),
          ];
        },
        handleInput(data: string): void {
          const filter = filters[filterIndex];
          const lineCount = formatAgentDashboard(jobs, filter).split("\n").length;
          const viewportRows = Math.max(6, (process.stdout.rows ?? 40) - 4);
          const maxScroll = Math.max(0, lineCount - viewportRows);
          if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
            done(undefined);
            return;
          }
          if (data === "r") {
            refresh();
          } else if (data === "f" || matchesKey(data, "tab")) {
            filterIndex = (filterIndex + 1) % filters.length;
            scrollOffset = 0;
          } else if (matchesKey(data, "up") || data === "k") {
            scrollOffset = Math.max(0, scrollOffset - 1);
          } else if (matchesKey(data, "down") || data === "j") {
            scrollOffset = Math.min(maxScroll, scrollOffset + 1);
          } else if (matchesKey(data, "pageUp")) {
            scrollOffset = Math.max(0, scrollOffset - viewportRows);
          } else if (matchesKey(data, "pageDown")) {
            scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
          } else if (data === "g") {
            scrollOffset = 0;
          } else if (data === "G") {
            scrollOffset = maxScroll;
          }
          requestRender();
        },
        invalidate(): void {},
        dispose(): void {
          closed = true;
          ctx.clearTimer(cacheTimer);
          ctx.clearTimer(refreshTimer);
        },
      };
    },
    { overlay: true },
  );
}
