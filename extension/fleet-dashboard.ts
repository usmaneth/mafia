import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth } from "@oh-my-pi/pi-tui";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { renderDashboard } from "../src/dashboard";
import { loadConfig, repoRoot } from "../src/config";
import { applyProposal, defaultApplyDeps, ProposalStore, type Proposal } from "../src/proposals";

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
  let confirming: Proposal | undefined;
  let notice = "";

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
        const footer = confirming
          ? ` approve "${confirming.title.slice(0, 48)}"? y/n `
          : notice
            ? ` ${notice.slice(0, 70)} `
            : ` q close | r refresh | p ${paused ? "resume" : "pause"} | 1-4 approve proposal | arrows scroll `;
        return [
          truncateToWidth(theme.fg("accent", theme.bold(" Mafia Fleet ")), width),
          ...view.render(width),
          truncateToWidth(confirming ? theme.fg("accent", footer) : theme.fg("dim", footer), width),
        ];
      },
      handleInput(data: string): void {
        const rows = Math.max(6, (process.stdout.rows ?? 40) - 4);
        // A pending confirmation owns the keyboard until answered. Applying a
        // config change off a single stray keystroke is how a dashboard becomes
        // dangerous, so the digit only selects and y is the consent.
        if (confirming) {
          if (matchesKey(data, "y")) {
            const chosen = confirming;
            confirming = undefined;
            if (chosen.kind === "bench-model") {
              // A benchmark runs for minutes; blocking the render loop for it
              // would freeze the dashboard, so it runs as its own process.
              const child = spawn("bun", [join(repoRoot, "src", "cli.ts"), "proposals", "approve", chosen.id], {
                detached: true, stdio: "ignore",
              });
              child.unref();
              notice = "benchmark started in the background";
            } else {
              const outcome = applyProposal(new ProposalStore(stateRoot), chosen, defaultApplyDeps(stateRoot));
              notice = `${outcome.ok ? "applied" : "FAILED"}: ${outcome.detail.slice(0, 56)}`;
            }
            refresh();
          } else {
            confirming = undefined;
            notice = "cancelled";
          }
          tui.requestRender();
          return;
        }
        const digit = /^[1-4]$/.test(data) ? Number(data) : undefined;
        if (digit) {
          const pending = new ProposalStore(stateRoot).list();
          const chosen = pending[digit - 1];
          if (chosen) {
            confirming = chosen;
            notice = "";
          } else {
            notice = `no proposal [${digit}]`;
          }
          tui.requestRender();
          return;
        }
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
