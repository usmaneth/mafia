function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" || part.type === "output_text")
    .map((part) => String(part.text ?? part.content ?? ""))
    .filter(Boolean)
    .join("\n");
}

export function extractHarnessResult(raw: string): string {
  let result = "";
  for (const line of raw.split("\n")) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "result" && typeof event.result === "string") result = event.result;
    if (event.item?.type === "agent_message" && typeof event.item.text === "string") result = event.item.text;
    if (event.message?.role === "assistant") {
      const text = contentText(event.message.content);
      if (text) result = text;
    }
    if (event.type === "assistant" && event.message) {
      const text = contentText(event.message.content);
      if (text) result = text;
    }
    if (event.part?.type === "text" && typeof event.part.text === "string") result = event.part.text;
    if (event.type === "run_result" && typeof event.text === "string") result = event.text;
  }
  if (result.trim()) return result.trim();
  const plain = raw.split("\n").filter((line) => line.trim() && !line.trim().startsWith("{")).join("\n");
  return (plain || raw).slice(-20000).trim();
}
