import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth } from "@oh-my-pi/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../src/config";
import { formatPrDashboard } from "../src/format";
import { readPrTelemetry } from "../src/pr";
import type { PrOperationalState, PrTelemetry } from "../src/types";

const filters: Array<PrOperationalState | "all"> = [
  "all", "needs-you", "fixing", "conflict", "ci-failing",
  "ci-pending", "ready", "queued", "awaiting-review",
];

export async function showPrDashboard(ctx: ExtensionCommandContext): Promise<void> {
  let telemetry = readPrTelemetry();
  let filterIndex = 0;
  let scrollOffset = 0;
  let childProcess: ChildProcess | undefined;
  let action = "";
  let lastGeneratedAt = telemetry?.generatedAt;
  let closed = false;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const requestRender = (): void => tui.requestRender();
      const loadCache = (): void => {
        const next = readPrTelemetry();
        if (next?.generatedAt && next.generatedAt !== lastGeneratedAt) {
          telemetry = next;
          lastGeneratedAt = next.generatedAt;
          requestRender();
        }
      };
      const run = (args: string[], label: string): void => {
        if (childProcess) return;
        action = label;
        childProcess = spawn(process.execPath, [join(repoRoot, "src", "cli.ts"), ...args], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        requestRender();
        const complete = (): void => {
          childProcess = undefined;
          action = "";
          const refresh = spawn(process.execPath, [
            join(repoRoot, "src", "cli.ts"), "__prs-refresh", "--force",
          ], { cwd: repoRoot, stdio: "ignore" });
          refresh.once("exit", loadCache);
          refresh.once("error", loadCache);
          if (!closed) requestRender();
        };
        childProcess.once("exit", complete);
        childProcess.once("error", complete);
      };
      const refresh = (): void => run(["__prs-refresh", "--force"], "refreshing");
      const pollTimer = ctx.setInterval(loadCache, 1000);
      refresh();

      return {
        render(width: number): readonly string[] {
          const terminalRows = process.stdout.rows ?? 40;
          const filter = filters[filterIndex];
          const source = telemetry
            ? formatPrDashboard(telemetry, filter).split("\n")
            : ["MAFIA PR DESK", "", "The PR snapshot is not ready."];
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
          const footer = ` q close | r refresh | f next view | s shepherd | m merge scan | ${action || filter} `;
          return [
            truncateToWidth(theme.fg("accent", theme.bold(" Mafia PR Desk ")), width),
            ...scrollView.render(width),
            truncateToWidth(theme.fg("dim", footer), width),
          ];
        },
        handleInput(data: string): void {
          const filter = filters[filterIndex];
          const lineCount = telemetry ? formatPrDashboard(telemetry, filter).split("\n").length : 3;
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
          } else if (data === "s") {
            run(["prs", "--shepherd"], "starting shepherd");
          } else if (data === "m") {
            run(["prs", "--merge"], "starting merge scan");
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
