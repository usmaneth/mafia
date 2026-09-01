import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth } from "@oh-my-pi/pi-tui";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { renderDashboard } from "../src/dashboard";
import { loadConfig, repoRoot } from "../src/config";
import { applyProposal, defaultApplyDeps, ProposalStore, type Proposal } from "../src/proposals";
import { copyToClipboard, formatCopyTargets, type CopyTarget } from "../src/clipboard";
import { readReviewQueue } from "../src/review-queue";
import { JobStore } from "../src/store";

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
  let copyTargets: CopyTarget[] | undefined;
  let notice = "";

  /**
   * What a person actually reaches for: job ids to feed back into commands,
   * pull-request URLs, and the exact command a proposal would run. Mouse
   * selection cannot reach any of them - the TUI owns the mouse - so these are
   * addressed by digit instead.
   */
  const collectCopyTargets = (): CopyTarget[] => {
    const targets: CopyTarget[] = [];
    try {
      for (const job of new JobStore(stateRoot).list(50)) {
        if (!["queued", "starting", "running"].includes(job.state)) continue;
        targets.push({ label: `job ${job.title.split("\n")[0]?.slice(0, 18) ?? ""}`, text: job.id });
      }
      for (const item of readReviewQueue(stateRoot)?.items.slice(0, 4) ?? []) {
        targets.push({ label: `pr ${item.repo.split("/")[1]}#${item.number}`, text: item.url });
      }
      for (const proposal of new ProposalStore(stateRoot).list().slice(0, 3)) {
        targets.push({ label: `cmd ${proposal.title.slice(0, 22)}`, text: proposal.action });
      }
    } catch {}
    return targets.slice(0, 9);
  };

  let refreshing = false;

  /**
   * Rebuild the view without touching the render loop.
   *
   * Rendering the dashboard costs about a hundred milliseconds of database
   * aggregation. Run inline, that was a visible input hitch every three
   * seconds inside OMP's own interface, which is the one place a stall is
   * always noticed. The work happens in a child process; this loop only
   * swaps in the finished text.
   */
  const refresh = (onDone?: () => void): void => {
    if (refreshing) return;
    refreshing = true;
    const child = spawn("bun", [join(repoRoot, "src", "cli.ts"), "dash"], {
      env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("close", (code: number | null) => {
      refreshing = false;
      if (code === 0 && out.trim()) {
        body = out.trimEnd().split("\n");
        error = "";
      } else {
        // A view that fails should say so rather than vanish or go stale
        // silently; the previous text stays visible underneath.
        error = (err || `dash exited ${code}`).trim().slice(0, 120);
      }
      onDone?.();
    });
    child.on("error", (failure: Error) => {
      refreshing = false;
      error = failure.message.slice(0, 120);
      onDone?.();
    });
  };
  refresh();

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const timer = setInterval(() => {
      if (paused) return;
      refresh(() => tui.requestRender());
    }, REFRESH_MS);
    (timer as { unref?: () => void }).unref?.();

    return {
      render(width: number): readonly string[] {
        const rows = Math.max(6, (process.stdout.rows ?? 40) - 4);
        const source = copyTargets
          ? ["copy to clipboard - press the number", "", ...formatCopyTargets(copyTargets)]
          : [...body, ...(error ? ["", `  error: ${error}`] : [])];
        const lines = source.map((line) => {
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
        const footer = copyTargets
          ? ` copy: press 1-${Math.max(1, copyTargets.length)} | esc cancel `
          : confirming
            ? ` approve "${confirming.title.slice(0, 48)}"? y/n `
            : notice
            ? ` ${notice.slice(0, 70)} `
            : ` q close | r refresh | c copy | p ${paused ? "resume" : "pause"} | 1-4 approve proposal | arrows scroll `;
        return [
          truncateToWidth(theme.fg("accent", theme.bold(" Mafia Fleet ")), width),
          ...view.render(width),
          truncateToWidth(confirming ? theme.fg("accent", footer) : theme.fg("dim", footer), width),
        ];
      },
      handleInput(data: string): void {
        const rows = Math.max(6, (process.stdout.rows ?? 40) - 4);
        if (copyTargets) {
          const digit = /^[1-9]$/.test(data) ? Number(data) : undefined;
          if (digit && copyTargets[digit - 1]) {
            const target = copyTargets[digit - 1]!;
            const result = copyToClipboard(target.text);
            notice = result.ok
              ? `copied ${target.label.trim()} (${result.via})${result.truncated ? " - truncated" : ""}`
              : "copy failed - no clipboard path worked";
          } else {
            notice = "copy cancelled";
          }
          copyTargets = undefined;
          tui.requestRender();
          return;
        }
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
            refresh(() => tui.requestRender());
          } else {
            confirming = undefined;
            notice = "cancelled";
          }
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "c")) {
          copyTargets = collectCopyTargets();
          notice = "";
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
          refresh(() => tui.requestRender());
          return;
        }
        if (matchesKey(data, "p")) {
          paused = !paused;
          if (!paused) refresh(() => tui.requestRender());
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
