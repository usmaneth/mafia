import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth } from "@oh-my-pi/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../src/config";
import { formatVpsDashboard } from "../src/format";
import { readVpsTelemetry } from "../src/telemetry";
import type { VpsTelemetry } from "../src/types";

export async function showVpsDashboard(
  ctx: ExtensionCommandContext,
  options: { allProcesses?: boolean } = {},
): Promise<void> {
  let telemetry = readVpsTelemetry();
  let allProcesses = options.allProcesses ?? false;
  let scrollOffset = 0;
  let refreshProcess: ChildProcess | undefined;
  let lastGeneratedAt = telemetry?.generatedAt;
  let closed = false;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const requestRender = (): void => tui.requestRender();
      const loadCache = (): void => {
        const next = readVpsTelemetry();
        if (next?.generatedAt && next.generatedAt !== lastGeneratedAt) {
          telemetry = next;
          lastGeneratedAt = next.generatedAt;
          requestRender();
        }
      };
      const refresh = (): void => {
        if (refreshProcess) return;
        refreshProcess = spawn(
          process.execPath,
          [join(repoRoot, "src", "cli.ts"), "__vps-refresh", "--force"],
          { cwd: repoRoot, stdio: "ignore" },
        );
        requestRender();
        const complete = (): void => {
          refreshProcess = undefined;
          loadCache();
          if (!closed) requestRender();
        };
        refreshProcess.once("exit", complete);
        refreshProcess.once("error", complete);
      };
      const pollTimer = ctx.setInterval(loadCache, 1000);
      refresh();

      return {
        render(width: number): readonly string[] {
          const terminalRows = process.stdout.rows ?? 40;
          const source = telemetry
            ? formatVpsDashboard(telemetry, { allProcesses }).split("\n")
            : ["MAFIA VPS OPERATIONS", "", "Telemetry cache is not ready."];
          const body = source.map((line) => {
            const text = /^== .* ==$/.test(line)
              ? theme.fg("accent", theme.bold(line))
              : line.startsWith("!")
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
          const mode = allProcesses ? "all processes" : "agent processes";
          const state = refreshProcess ? "refreshing" : "live cache";
          const footer = ` q close | r refresh | a ${allProcesses ? "agent processes" : "all processes"} | arrows/page scroll | ${mode} | ${state} `;
          return [
            truncateToWidth(theme.fg("accent", theme.bold(" Mafia VPS Operations ")), width),
            ...scrollView.render(width),
            truncateToWidth(theme.fg("dim", footer), width),
          ];
        },
        handleInput(data: string): void {
          const lineCount = telemetry
            ? formatVpsDashboard(telemetry, { allProcesses }).split("\n").length
            : 3;
          const viewportRows = Math.max(6, (process.stdout.rows ?? 40) - 4);
          const maxScroll = Math.max(0, lineCount - viewportRows);
          if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
            done(undefined);
            return;
          }
          if (data === "r") {
            refresh();
          } else if (data === "a") {
            allProcesses = !allProcesses;
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
          ctx.clearTimer(pollTimer);
        },
      };
    },
    { overlay: true },
  );
}
