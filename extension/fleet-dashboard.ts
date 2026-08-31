import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth } from "@oh-my-pi/pi-tui";
import { renderDashboard } from "../src/dashboard";
import { loadConfig } from "../src/config";

const REFRESH_MS = 3000;

/**
 * The fleet dashboard, inside OMP's own interface.
 *
 * The same view the command line prints, but live and without leaving the
 * session. It is drawn with block characters rather than an image protocol,
 * because images need the terminal and any multiplexer to agree, and this has
 * to look the same whether OMP runs locally, over SSH, or inside tmux.
 */
export async function showFleetDashboard(ctx: ExtensionCommandContext): Promise<void> {
  const stateRoot = loadConfig().stateRoot;
  let body: string[] = ["loading the fleet..."];
  let error = "";
  let paused = false;
  let scroll = 0;

  const refresh = (): void => {
    try {
      body = renderDashboard(stateRoot).split("\n");
      error = "";
    } catch (failure) {
      // A view that throws should say so rather than vanish.
      error = failure instanceof Error ? failure.message : String(failure);
    }
  };
  refresh();

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const timer = setInterval(() => {
      if (paused) return;
      refresh();
      tui.requestRender();
    }, REFRESH_MS);
    (timer as { unref?: () => void }).unref?.();

    return {
      render(width: number): readonly string[] {
        const rows = Math.max(6, (process.stdout.rows ?? 40) - 4);
        const lines = [...body, ...(error ? ["", `  error: ${error}`] : [])].map((line) => {
          // Section rules and alerts carry the structure, so they are the only
          // things worth colouring; the charts read on their own.
          const text = line.startsWith("  ! ")
            ? theme.fg("error", line)
            : line.includes("─")
              ? theme.fg("dim", line)
              : line.trimStart().startsWith("mafia ")
                ? theme.fg("dim", line)
                : line;
          return truncateToWidth(text, width);
        });
        const maxScroll = Math.max(0, lines.length - rows);
        scroll = Math.min(scroll, maxScroll);
        const view = new ScrollView(lines.slice(scroll, scroll + rows), {
          height: rows,
          scrollbar: "auto",
          totalRows: lines.length,
          theme: {
            track: (text: string) => theme.fg("dim", text),
            thumb: (text: string) => theme.fg("accent", text),
          },
        });
        view.setScrollOffset(scroll);
        return [
          truncateToWidth(theme.fg("accent", theme.bold(" Mafia Fleet ")), width),
          ...view.render(width),
          truncateToWidth(theme.fg("dim", ` q close | r refresh | p ${paused ? "resume" : "pause"} | arrows scroll `), width),
        ];
      },
      handleInput(data: string): void {
        const rows = Math.max(6, (process.stdout.rows ?? 40) - 4);
        if (matchesKey(data, "escape") || matchesKey(data, "q")) {
          clearInterval(timer);
          done();
          return;
        }
        if (matchesKey(data, "r")) {
          refresh();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "p")) {
          paused = !paused;
          if (!paused) refresh();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
        else if (matchesKey(data, "down")) scroll += 1;
        else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - rows);
        else if (matchesKey(data, "pageDown")) scroll += rows;
        else return;
        tui.requestRender();
      },
      onUnmount(): void {
        clearInterval(timer);
      },
    } as never;
  });
}
