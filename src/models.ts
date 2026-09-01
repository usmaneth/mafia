import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { toolEnvironment } from "./process";
import { latencyWeight } from "./bench";
import type { HarnessName, ModelCatalog, ModelCatalogSource, ModelMetric, ModelRecord, RoutingCandidate, TaskCapability } from "./types";

const CACHE_AGE_MS = 5 * 60_000;

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: toolEnvironment(),
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  // A timer starts this with a minimal PATH. Without the tool environment
  // `omp` and `opencode` cannot be found, and the catalog silently falls back
  // to the stale cache while reporting a count that looks healthy.
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
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
    efforts: Array.isArray(model.thinking)
      ? model.thinking.map((level: unknown) => String(level)).filter(Boolean)
      : undefined,
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

export function parseClaudeModels(anthropic: ModelRecord[]): ModelRecord[] {
  const aliases = [
    { id: "sonnet", name: "Claude Sonnet" },
    { id: "opus", name: "Claude Opus" },
    { id: "haiku", name: "Claude Haiku" },
  ];
  return [
    ...aliases.map(({ id, name }) => ({
      harness: "claude" as const,
      provider: "anthropic",
      id,
      selector: id,
      name,
      source: "claude" as const,
      available: true,
      reasoning: true,
    })),
    ...anthropic.map((model) => ({
      ...model,
      harness: "claude" as const,
      source: "claude" as const,
      selector: model.id,
    })),
  ];
}

export class ModelCatalogService {
  readonly path: string;

  constructor(stateRoot = join(homedir(), ".local", "share", "mafia")) {
    this.path = join(stateRoot, "models", "catalog.json");
  }

  cached(): ModelCatalog | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as ModelCatalog;
    } catch {
      return undefined;
    }
  }

  discover(refresh = false): ModelCatalog {
    let previous = this.cached();
    if (!refresh && previous) {
      const cached = previous;
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
        const stale = previous?.models.filter((model) => model.harness === harness) ?? [];
        models.push(...stale);
        sources.push({
          harness,
          status: "error",
          count: stale.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    add("omp", () => parseOmpModels(run("omp", ["--profile", "mafia", "models", "--json"])));
    const anthropic = models.filter((model) => model.harness === "omp" && model.provider === "anthropic");
    const claude = parseClaudeModels(anthropic);
    models.push(...claude);
    sources.push({ harness: "claude", status: "ok", count: claude.length });
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

/**
 * Fold merge outcomes into a model's quality, gently.
 *
 * Whether the work was accepted outranks a guess from the model's name, but a
 * handful of pull requests is a hint, not a verdict: the effect needs at least
 * five, and is capped so a lucky streak cannot displace a frontier model.
 */
function adjustedQuality(base: number, outcome?: { prs: number; mergeRate: number }): number {
  if (!outcome || outcome.prs < 5) return base;
  const shift = Math.max(-0.03, Math.min(0.03, (outcome.mergeRate - 0.5) * 0.06));
  return Math.min(0.99, Math.max(0.5, base + shift));
}

/**
 * What a model costs to run here, given how its harness actually caches.
 *
 * A cached input token is about a tenth of the fresh price, so a harness that
 * serves most input from cache is cheaper than its list price says. This is
 * observed behaviour on this machine, not a promise from the provider.
 */
function effectiveCost(base: number, cacheRate?: number): number {
  if (!base || cacheRate === undefined) return base;
  const multiplier = (1 - cacheRate) + cacheRate * 0.1;
  return Math.max(0.02, base * multiplier);
}

export interface RoutingSignals {
  /** Merge outcomes per observed model name, from `mafia landed`. */
  outcomes?: Array<{ model: string; prs: number; mergeRate: number }>;
  /** Observed cache-read share per harness, from the telemetry corpus. */
  cacheRates?: Record<string, number>;
}

/** The live signal bundle for routing, read from local caches only. */
export function routingSignals(stateRoot: string): RoutingSignals {
  try {
    const { readModelOutcomes } = require("./pr-attribution") as typeof import("./pr-attribution");
    const { TelemetryStore } = require("./telemetry-store") as typeof import("./telemetry-store");
    return {
      outcomes: readModelOutcomes(stateRoot),
      cacheRates: new TelemetryStore(stateRoot).cacheRateByHarness(),
    };
  } catch {
    return {};
  }
}

export function catalogCandidates(
  catalog: ModelCatalog,
  hosts: string[],
  metrics: Record<string, ModelMetric> = {},
  signals: RoutingSignals = {},
): RoutingCandidate[] {
  return catalog.models.filter((model) => model.available && !excluded.test(`${model.selector} ${model.name}`)).flatMap((model) =>
    hosts.map((host) => candidateForModel(model, host, metrics[model.selector], signals))
  );
}

function candidateForModel(model: ModelRecord, host: string, metric?: ModelMetric, signals: RoutingSignals = {}): RoutingCandidate {
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
  // Merge outcomes are keyed by the name the provider served, which is usually
  // the tail of the catalog selector.
  const tail = model.id.split("/").at(-1)!.toLowerCase();
  const outcome = signals.outcomes?.find((row) =>
    row.model.toLowerCase() === model.selector.toLowerCase()
    || row.model.split("/").at(-1)!.toLowerCase() === tail);
  const cacheRate = signals.cacheRates?.[model.harness];
  return {
    harness: model.harness,
    model: model.selector,
    host,
    capabilities: [...new Set(capabilities)],
    enabled: true,
    costWeight: effectiveCost(free ? 0 : rawCost === undefined ? (small ? 0.25 : 0.6) : Math.min(1, rawCost / 30), cacheRate),
    quality: adjustedQuality(small ? 0.76 : frontier ? 0.97 : 0.84, outcome),
    // Prefer a measured time to first token. The fallback below is a guess from
    // the model's name, which mis-scored every model the pattern never listed.
    latency: latencyWeight(metric) ?? (small ? 0.35 : frontier ? 0.75 : 0.55),
    latencyMeasured: latencyWeight(metric) !== undefined,
    mergeRate: outcome && outcome.prs >= 5 ? outcome.mergeRate : undefined,
    cacheRate,
    contextTokens: model.contextWindow,
    provider: model.provider,
  };
}

export function filterCatalog(catalog: ModelCatalog, input: {
  harness?: HarnessName; provider?: string; query?: string; limit?: number; effort?: string;
}): ModelCatalog {
  const query = input.query?.toLowerCase();
  return {
    ...catalog,
    models: catalog.models.filter((model) =>
      (!input.harness || model.harness === input.harness) &&
      (!input.provider || model.provider === input.provider) &&
      (!query || `${model.selector} ${model.name} ${model.provider}`.toLowerCase().includes(query)) &&
      (!input.effort || Boolean(model.efforts?.includes(input.effort)))
    ).slice(0, Math.min(2000, input.limit ?? 50)),
  };
}

function normalizedModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function modelMatchScore(model: ModelRecord, requested: string): number {
  const raw = requested.toLowerCase().trim();
  const normalized = normalizedModelName(requested);
  const selector = model.selector.toLowerCase();
  const providerId = `${model.provider}/${model.id}`.toLowerCase();
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  if (selector === raw) return 110;
  if (providerId === raw) return 100;
  if (id === raw) return 109;
  if (name === raw) return 95;
  const normalizedSelector = normalizedModelName(model.selector);
  const normalizedName = normalizedModelName(model.name);
  if (normalizedSelector === normalized || normalizedName === normalized) return 94;
  if (normalizedSelector.endsWith(normalized) || normalizedName.endsWith(normalized)) return 92;
  if (["sonnet", "opus", "haiku"].includes(id) && normalized.includes(id)) return 96;
  const words = normalized.split(" ").filter(Boolean);
  const haystack = normalizedModelName(`${model.selector} ${model.name} ${model.provider}`);
  if (words.length && words.every((word) => haystack.includes(word))) return 70 + Math.min(10, words.length);
  if (haystack.includes(normalized)) return 60;
  return 0;
}

const nativeHarnessPriority: Record<HarnessName, number> = {
  claude: 6,
  codex: 5,
  kimi: 4,
  cline: 3,
  opencode: 2,
  omp: 1,
};

/**
 * Split an effort suffix from a model selector.
 *
 * OMP writes the reasoning level after a colon, as in
 * `xai-oauth/grok-4.6:high`. A provider segment can also hold a colon, as in
 * `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`, so only a final segment
 * that names a known effort level counts as an effort.
 */
/**
 * The effort ladder, taken from the harness rather than restated here.
 *
 * A local copy of this list went stale immediately: it omitted `max`, which
 * eighty-one models accept. `THINKING_EFFORTS` is what OMP itself uses, so the
 * two can no longer disagree.
 */
export const effortLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Parse an effort name the way OMP does, including its abbreviations.
 *
 * This mirrors `parseEffort` from `@oh-my-pi/pi-coding-agent/thinking`. It is
 * restated rather than imported because those packages ship raw TypeScript, so
 * importing them costs 250 ms of transpilation on every command. A test asserts
 * this stays identical to OMP's version, which is what a stale local copy of
 * the ladder lacked when it silently omitted `max`.
 */
export function parseEffort(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  // Case-sensitive, exactly as OMP is. Callers that take input from a person
  // lower-case it first; matching OMP here keeps the two from disagreeing on a
  // selector one of them would reject.
  if ((effortLevels as readonly string[]).includes(value)) return value;
  // Two characters minimum, so a single letter cannot guess between three.
  if (value.length < 2) return undefined;
  const matches = effortLevels.filter((level) => level.startsWith(value));
  return matches.length === 1 ? matches[0] : undefined;
}

export function catalogEfforts(catalog: ModelCatalog): Set<string> {
  const known = new Set<string>(effortLevels);
  for (const model of catalog.models) {
    for (const level of model.efforts ?? []) known.add(level);
  }
  return known;
}

/**
 * Split a trailing effort from a model selector.
 *
 * `parseEffort` is OMP's own parser, so an abbreviation that works in
 * `omp --model x:med` now works in Mafia too. Before this, Mafia accepted only
 * the full word and rejected a selector the harness would have taken.
 *
 * A tail that names no effort stays part of the base, which keeps a provider
 * tier such as `:free` or `:batch` intact.
 */
export function parseModelSelector(
  requested: string,
  known?: ReadonlySet<string>,
): { base: string; effort?: string } {
  const index = requested.lastIndexOf(":");
  if (index <= 0) return { base: requested };
  const tail = requested.slice(index + 1).toLowerCase();
  const canonical = parseEffort(tail) ?? (known?.has(tail) ? tail : undefined);
  if (!canonical) return { base: requested };
  return { base: requested.slice(0, index), effort: canonical };
}

export function applyEffort(model: ModelRecord, effort?: string): ModelRecord {
  if (!effort) return model;
  // Keep the request honest: a model that does not accept the level is
  // returned without it rather than with a selector the harness will reject.
  if (model.efforts?.length && !model.efforts.includes(effort)) return model;
  if (!model.efforts?.length && model.harness !== "omp") return model;
  return { ...model, effort, selector: `${model.selector}:${effort}` };
}

export function resolveCatalogModel(
  catalog: ModelCatalog,
  requested: string,
  harness?: HarnessName,
): ModelRecord {
  // A selector that names a real model wins outright, before any effort is
  // considered. `openrouter/anthropic/claude-opus-5:batch` is a whole model id,
  // not a model plus an effort, and no vocabulary of effort names can tell the
  // two apart reliably. Asking the catalog removes the guess.
  const exact = catalog.models.find((model) =>
    model.available && (!harness || model.harness === harness) && model.selector === requested);
  if (exact) return exact;
  // Otherwise strip the effort before scoring. With it attached the selector
  // never matches exactly, so a fuzzy rule wins and returns a different harness.
  const { base, effort } = parseModelSelector(requested, catalogEfforts(catalog));
  return applyEffort(resolveBaseModel(catalog, base, harness), effort);
}

function resolveBaseModel(
  catalog: ModelCatalog,
  requested: string,
  harness?: HarnessName,
): ModelRecord {
  const matches = catalog.models
    .filter((model) => model.available && (!harness || model.harness === harness))
    .map((model) => ({ model, score: modelMatchScore(model, requested) }))
    .filter((match) => match.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      nativeHarnessPriority[right.model.harness] - nativeHarnessPriority[left.model.harness] ||
      left.model.selector.localeCompare(right.model.selector)
    );
  const match = matches[0]?.model;
  if (!match) {
    const scope = harness ? ` for ${harness}` : "";
    throw new Error(`No available Mafia model matches "${requested}"${scope}. Use mafia models --find "${requested}".`);
  }
  return match;
}
