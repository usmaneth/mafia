#!/usr/bin/env node
import { spawn } from "node:child_process";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function runBash(command, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let size = 0;
    const limit = 40_000;
    const append = (chunk) => {
      if (size >= limit) return;
      const value = chunk.toString();
      output.push(value.slice(0, limit - size));
      size += value.length;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        signal,
        output: output.join("") || "(no output)",
      });
    });
  });
}

const model = required(option("--model"), "--model is required").replace(/^ollama\//, "");
const cwd = required(option("--cwd"), "--cwd is required");
const prompt = required(option("--prompt"), "--prompt is required");
const maxSteps = Math.max(1, Number(option("--max-steps") ?? 20));
const endpoint = process.env.OLLAMA_HOST
  ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, "")}`
  : "http://127.0.0.1:11434";

const messages = [
  {
    role: "system",
    content:
      "You are a Mafia coding worker. Complete the task in the current repository. " +
      "Use the bash tool to inspect, edit, and test files. Do not ask for permission. " +
      "Return a concise result with changed files and verification.",
  },
  { role: "user", content: prompt },
];
const tools = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the current repository.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." },
          timeout_ms: {
            type: "integer",
            description: "The timeout in milliseconds. The default is 120000.",
          },
        },
        required: ["command"],
      },
    },
  },
];

let finalText = "";
const usage = {
  input_tokens: 0,
  output_tokens: 0,
  prompt_eval_duration_ns: 0,
  eval_duration_ns: 0,
  load_duration_ns: 0,
  total_duration_ns: 0,
};
for (let step = 0; step < maxSteps; step += 1) {
  const response = await fetch(`${endpoint}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      think: false,
      keep_alive: "30m",
      options: {
        num_ctx: 32768,
        temperature: 0.7,
        top_p: 0.8,
        top_k: 20,
        presence_penalty: 1.5,
        num_predict: 4096,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }
  const value = await response.json();
  usage.input_tokens += value.prompt_eval_count ?? 0;
  usage.output_tokens += value.eval_count ?? 0;
  usage.prompt_eval_duration_ns += value.prompt_eval_duration ?? 0;
  usage.eval_duration_ns += value.eval_duration ?? 0;
  usage.load_duration_ns += value.load_duration ?? 0;
  usage.total_duration_ns += value.total_duration ?? 0;
  const message = value.message ?? {};
  messages.push(message);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length === 0) {
    finalText = String(message.content ?? "").trim();
    break;
  }
  for (const call of toolCalls) {
    if (call.function?.name !== "bash") {
      messages.push({
        role: "tool",
        tool_name: call.function?.name ?? "unknown",
        content: "Unsupported tool.",
      });
      continue;
    }
    const rawArgs = call.function.arguments ?? {};
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    const result = await runBash(
      String(args.command ?? ""),
      cwd,
      Math.max(1_000, Number(args.timeout_ms ?? 120_000)),
    );
    messages.push({
      role: "tool",
      tool_name: "bash",
      content: `exit_code=${result.exitCode}\nsignal=${result.signal ?? ""}\n${result.output}`,
    });
  }
}

if (!finalText) {
  throw new Error(`The local Ollama agent did not finish after ${maxSteps} steps.`);
}
console.log(JSON.stringify({ type: "run_result", text: finalText, usage }));
