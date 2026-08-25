import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { DecisionRecord, PipelineTask } from "./types";

const MAX_FILE_BYTES = 60_000;
const MAX_PACK_BYTES = 180_000;

export function buildContextPack(input: {
  stateRoot: string;
  teamId: string;
  task: PipelineTask;
  decisions: DecisionRecord[];
  repoRules?: string;
  vaultRoot?: string;
}): string {
  const root = input.vaultRoot ?? join(homedir(), "vault");
  const terms = keywords(`${input.task.title ?? ""} ${input.task.prompt} ${(input.task.labels ?? []).join(" ")}`);
  const candidates = [
    join(root, "_index", "dashboard.md"),
    ...findRelevantFiles(root, terms),
  ];
  let bytes = 0;
  const sections: string[] = [];
  for (const path of [...new Set(candidates)]) {
    if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) continue;
    const text = readFileSync(path, "utf8");
    if (bytes + text.length > MAX_PACK_BYTES) continue;
    bytes += text.length;
    sections.push(`## ${path.replace(`${root}/`, "")}\n${text}`);
  }
  const relevantDecisions = input.decisions.filter((decision) =>
    !decision.affectedTasks.length || decision.affectedTasks.includes(input.task.id)
  );
  const path = join(input.stateRoot, "teams", input.teamId, "context", `${input.task.id}.md`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, [
    `# Mafia Context Pack: ${input.task.id}`,
    "",
    "## Assignment",
    input.task.prompt,
    input.repoRules ? `\n## Repository Rules\n${input.repoRules}` : "",
    relevantDecisions.length
      ? `\n## Team Decisions\n${relevantDecisions.map((decision) => `- ${decision.question}: ${decision.selected}`).join("\n")}`
      : "",
    "",
    ...sections,
  ].filter(Boolean).join("\n"), { mode: 0o600 });
  return path;
}

function keywords(text: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "into", "task", "team"]);
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [])]
    .filter((word) => !stop.has(word))
    .slice(0, 16);
}

function findRelevantFiles(root: string, terms: string[]): string[] {
  const files: Array<{ path: string; score: number; mtime: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "archive") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const name = path.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 3 : 0), 0);
        if (score > 0 || /\/daily\/|\/sessions\//.test(name)) {
          files.push({ path, score, mtime: statSync(path).mtimeMs });
        }
      }
    }
  };
  walk(root, 0);
  return files
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime || basename(a.path).localeCompare(basename(b.path)))
    .slice(0, 8)
    .map((value) => value.path);
}
