import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { toolEnvironment } from "./process";
import type { DecisionRecord, PipelineTask } from "./types";

const MAX_FILE_BYTES = 60_000;
const MAX_PACK_BYTES = 180_000;
/** Above this, densifying the pack buys more than it costs. */
const COMPRESS_ABOVE_BYTES = 60_000;

export function buildContextPack(input: {
  stateRoot: string;
  teamId: string;
  task: PipelineTask;
  decisions: DecisionRecord[];
  repoRules?: string;
  vaultRoot?: string;
  /**
   * Densify the pack with `omp compress`.
   *
   * Off by default: it is a model call, and a team builds one pack per task in
   * a loop. The largest pack observed here is 58 kB, which fits without help.
   */
  compress?: boolean;
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
  if (input.compress) compressContextPack(path);
  return path;
}

/**
 * Rewrite a context pack into OMP's dense prompt register.
 *
 * The pack is assembled by skipping whole files once the byte budget runs out,
 * which drops whichever file happens to be next rather than the least useful
 * text. `omp compress` reduces the wording instead and reports what it drops.
 *
 * A failure leaves the original in place: a pack that exists is worth more than
 * one that was optimised away.
 */
export function compressContextPack(path: string, model?: string): { compressed: boolean; before: number; after: number } {
  let before = 0;
  try {
    before = statSync(path).size;
  } catch {
    return { compressed: false, before: 0, after: 0 };
  }
  const result = spawnSync("omp", [
    "--profile", "mafia", "compress", path, "-o", path,
    ...(model ? ["-m", model] : []),
  ], { encoding: "utf8", env: toolEnvironment(), timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) return { compressed: false, before, after: before };
  let after = before;
  try {
    after = statSync(path).size;
  } catch {}
  return { compressed: after < before, before, after };
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
