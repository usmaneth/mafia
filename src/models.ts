import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { HarnessName, ModelCatalog, ModelCatalogSource, ModelRecord, RoutingCandidate, TaskCapability } from "./types";

const CACHE_AGE_MS = 5 * 60_000;

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || `${command} exited ${result.status}`).trim());
  return result.stdout;
}

export function parseOmpModels(raw: string): ModelRecord[] {
  const input = JSON.parse(raw) as { models?: any[] };
  return (input.models ?? []).map((model) => ({
    harness: "omp" as const,
    provider: String(model.provider),
    id: String(model.id),
    selector: String(model.selector ?? `${model.provider}/${model.id}`),
    name: String(model.name ?? model.id),
    source: "omp" as const,
    available: true,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: Boolean(model.reasoning),
    input: model.input,
    cost: model.cost,
  }));
}

export function parseOpenCodeModels(raw: string): ModelRecord[] {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).map((selector) => {
    const [provider, ...id] = selector.split("/");
    return {
      harness: "opencode" as const, provider, id: id.join("/"), selector, name: id.join("/"),
      source: "opencode" as const, available: true,
    };
  });
}

export function parseCodexModels(raw: string, configured?: string): ModelRecord[] {
  const input = JSON.parse(raw) as { models?: any[] };
  const ids = new Set<string>();
  const models = (input.models ?? []).filter((model) => model.visibility !== "hide").map((model) => {
    ids.add(model.slug);
    return {
      harness: "codex" as const, provider: "openai-codex", id: model.slug, selector: model.slug,
      name: model.display_name ?? model.slug, source: "codex" as const, available: model.supported_in_api !== false,
      reasoning: Boolean(model.supported_reasoning_levels?.length),
    };
  });
  if (configured && !ids.has(configured)) models.unshift({
    harness: "codex", provider: "openai-codex", id: configured, selector: configured,
    name: configured, source: "codex", available: true, reasoning: true,
  });
  return models;
}

export function parseKimiModels(raw: string): ModelRecord[] {
  const input = Bun.TOML.parse(raw) as any;
  return Object.entries(input.models ?? {}).map(([id, value]: [string, any]) => ({
    harness: "kimi" as const, provider: "kimi-code", id, selector: id,
    name: value.display_name ?? id, source: "kimi" as const, available: true,
    contextWindow: value.context_size,
  }));
}

export function parseClineModels(raw: string): ModelRecord[] {
  const input = JSON.parse(raw) as any;
  return Object.entries(input.providers ?? {}).flatMap(([provider, value]: [string, any]) => {
    const model = value?.settings?.model;
    if (!model) return [];
    return [{
      harness: "cline" as const, provider, id: model, selector: model, name: model,
      source: "cline" as const, available: true, reasoning: Boolean(value?.settings?.reasoning?.enabled),
    }];
  });
}

export class ModelCatalogService {
  readonly path: string;

  constructor(stateRoot = join(homedir(), ".local", "share", "mafia")) {
    this.path = join(stateRoot, "models", "catalog.json");
  }

  discover(refresh = false): ModelCatalog {
    if (!refresh && existsSync(this.path)) {
      const cached = JSON.parse(readFileSync(this.path, "utf8")) as ModelCatalog;
      if (Date.now() - new Date(cached.generatedAt).getTime() < CACHE_AGE_MS) return cached;
    }
    const models: ModelRecord[] = [];
    const sources: ModelCatalogSource[] = [];
    const add = (harness: HarnessName, discover: () => ModelRecord[]) => {
      try {
        const found = discover();
        models.push(...found);
        sources.push({ harness, status: "ok", count: found.length });
      } catch (error) {
        sources.push({ harness, status: "error", count: 0, error: error instanceof Error ? error.message : String(error) });
      }
    };
    add("omp", () => parseOmpModels(run("omp", ["--profile", "mafia", "models", "--json"])));
    const anthropic = models.filter((model) => model.harness === "omp" && model.provider === "anthropic");
    models.push(...anthropic.map((model) => ({ ...model, harness: "claude" as const, source: "claude" as const, selector: model.id })));
    sources.push({ harness: "claude", status: "ok", count: anthropic.length });
    add("opencode", () => parseOpenCodeModels(run("opencode", ["models"])));
    add("codex", () => {
      const config = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
      const configured = config.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
      return parseCodexModels(readFileSync(join(homedir(), ".codex", "models_cache.json"), "utf8"), configured);
    });
    add("kimi", () => parseKimiModels(readFileSync(join(homedir(), ".kimi-code", "config.toml"), "utf8")));
    add("cline", () => parseClineModels(readFileSync(join(homedir(), ".cline", "data", "settings", "providers.json"), "utf8")));
    const unique = [...new Map(models.map((model) => [`${model.harness}:${model.selector}`, model])).values()];
    const catalog = { generatedAt: new Date().toISOString(), models: unique, sources };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`);
    renameSync(temp, this.path);
    return catalog;
  }
}

const excluded = /(embed|image|audio|speech|tts|video|moderation|rerank|guard|safety|vision-only)/i;

export function catalogCandidates(catalog: ModelCatalog, hosts: string[]): RoutingCandidate[] {
  return catalog.models.filter((model) => model.available && !excluded.test(`${model.selector} ${model.name}`)).flatMap((model) =>
    hosts.map((host) => candidateForModel(model, host))
  );
}

function candidateForModel(model: ModelRecord, host: string): RoutingCandidate {
  const name = `${model.selector} ${model.name}`.toLowerCase();
  const capabilities: TaskCapability[] = ["general"];
  if (/(code|codex|claude|gpt|gemini|grok|kimi|qwen|deepseek|nemotron)/.test(name)) capabilities.push("implementation", "review", "testing");
  if (/(opus|fable|pro|reason|thinking|gpt-5|grok|k3)/.test(name)) capabilities.push("architecture", "security", "synthesis");
  if (/(search|research|flash|mini|free|nemotron)/.test(name)) capabilities.push("research");
  const free = /(:free|free)/.test(name);
  const frontier = /(opus|fable|gpt-5\.[45]|gpt-5\.6|grok-build|gemini-3\.7|kimi-k3|\/k3)/.test(name);
  const small = /(mini|nano|flash|haiku|small|free)/.test(name);
  const rawCost = model.cost
    ? Math.max(0, model.cost.input) + Math.max(0, model.cost.output)
    : undefined;
  return {
    harness: model.harness,
    model: model.selector,
    host,
    capabilities: [...new Set(capabilities)],
    enabled: true,
    costWeight: free ? 0 : rawCost === undefined ? (small ? 0.25 : 0.6) : Math.min(1, rawCost / 30),
    quality: small ? 0.76 : frontier ? 0.97 : 0.84,
    latency: small ? 0.35 : frontier ? 0.75 : 0.55,
    contextTokens: model.contextWindow,
    provider: model.provider,
  };
}

export function filterCatalog(catalog: ModelCatalog, input: {
  harness?: HarnessName; provider?: string; query?: string; limit?: number;
}): ModelCatalog {
  const query = input.query?.toLowerCase();
  return {
    ...catalog,
    models: catalog.models.filter((model) =>
      (!input.harness || model.harness === input.harness) &&
      (!input.provider || model.provider === input.provider) &&
      (!query || `${model.selector} ${model.name} ${model.provider}`.toLowerCase().includes(query))
    ).slice(0, Math.min(2000, input.limit ?? 50)),
  };
}
