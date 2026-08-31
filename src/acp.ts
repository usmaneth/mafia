import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { toolEnvironment } from "./process";

export interface AcpRunOptions {
  command: string;
  args: string[];
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  /** Called for each tool call the agent makes, for live progress. */
  onTool?: (tool: string, detail: string) => void;
}

export interface AcpRunResult {
  text: string;
  stopReason: string;
  toolCalls: Record<string, number>;
}

/** Agents that speak ACP over stdio, and how to start them. */
export const acpHarnesses: Record<string, (cwd: string, model?: string) => { command: string; args: string[] }> = {
  omp: (_cwd, model) => ({
    command: "omp",
    args: ["--profile", "mafia", "acp", ...(model ? ["--model", model] : [])],
  }),
  cline: () => ({ command: "cline", args: ["--acp"] }),
};

export function speaksAcp(harness: string): boolean {
  return harness in acpHarnesses;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join("");
  if (content && typeof content === "object") {
    const part = content as { type?: string; text?: string; content?: unknown };
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.content !== undefined) return textOf(part.content);
  }
  return "";
}

/**
 * Run one prompt against an agent over the Agent Client Protocol.
 *
 * The alternative is what Mafia does today: build a different argv for each
 * harness, then guess the result out of six different stream formats. That
 * guessing lives in `extractResult` and is the most fragile code in the
 * repository, because a harness changing its output shape breaks it silently.
 *
 * ACP replies with a typed result and a stop reason, so there is nothing to
 * infer. Two of the six harnesses speak it today.
 */
export async function runOverAcp(options: AcpRunOptions): Promise<AcpRunResult> {
  // Imported here rather than at the top so a host without the package can
  // still run every other command. A missing protocol client should disable
  // one feature, not the tool.
  const { ClientSideConnection, ndJsonStream } = await import("@zed-industries/agent-client-protocol");
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: toolEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let text = "";
  const toolCalls: Record<string, number> = {};
  const seenTools = new Set<string>();

  const connection = new ClientSideConnection(
    () => ({
      // The agent streams its progress through this handler.
      async sessionUpdate(params: any) {
        const update = params?.update ?? params;
        const kind = update?.sessionUpdate;
        if (kind === "agent_message_chunk") text += textOf(update.content);
        if (kind === "tool_call") {
          const name = String(update.title ?? update.kind ?? "tool");
          // A tool call is announced once and then updated; only the first
          // announcement is a new call.
          const key = String(update.toolCallId ?? `${name}:${Object.keys(toolCalls).length}`);
          if (!seenTools.has(key)) {
            seenTools.add(key);
            toolCalls[name] = (toolCalls[name] ?? 0) + 1;
            options.onTool?.(name, String(update.rawInput ? JSON.stringify(update.rawInput).slice(0, 80) : ""));
          }
        }
      },
      // Mafia workers run unattended, so anything needing a decision is
      // approved. The sandbox and the approval mode are set when the job is
      // dispatched, not per call.
      async requestPermission(params: any) {
        const allow = (params?.options ?? []).find((option: any) => /allow|always/i.test(String(option?.kind ?? option?.optionId)));
        return { outcome: { outcome: "selected", optionId: allow?.optionId ?? params?.options?.[0]?.optionId } };
      },
      async writeTextFile() {
        return {};
      },
      async readTextFile() {
        return { content: "" };
      },
    }),
    // The protocol takes Web streams. Passing Node streams does not throw; the
    // connection simply never reads, so the handshake hangs with no error.
    ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    ),
  );

  const deadline = options.timeoutMs ?? 3_600_000;
  const timer = setTimeout(() => child.kill("SIGTERM"), deadline);
  try {
    await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    } as never);
    const session = await connection.newSession({ cwd: options.cwd, mcpServers: [] } as never);
    const result = await connection.prompt({
      sessionId: (session as { sessionId: string }).sessionId,
      prompt: [{ type: "text", text: options.prompt }],
    } as never);
    return {
      text: text.trim(),
      stopReason: String((result as { stopReason?: string })?.stopReason ?? "end_turn"),
      toolCalls,
    };
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
  }
}
