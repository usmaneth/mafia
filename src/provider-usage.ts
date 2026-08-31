import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config";
import { toolEnvironment } from "./process";
import type { ProviderQuota, ProviderUsage } from "./types";

const CACHE_AGE_MS = 5 * 60_000;

interface OmpLimit {
  id?: string;
  label?: string;
  window?: { id?: string; label?: string; resetsAt?: number };
  amount?: { used?: number; limit?: number; remainingFraction?: number; usedFraction?: number; unit?: string };
}

interface OmpReport {
  provider?: string;
  fetchedAt?: number;
  limits?: OmpLimit[];
  error?: string;
}

export function usagePath(stateRoot: string): string {
  return join(stateRoot, "provider-usage.json");
}

/**
 * Turn OMP's per-window limit report into one headroom number per provider.
 *
 * Routing needs a single comparable figure, and the binding constraint is
 * always the window closest to full. A provider with a five-hour window at 90%
 * is unusable right now even when its weekly window is nearly empty.
 */
export function parseProviderUsage(raw: string, now: number): ProviderUsage {
  const input = JSON.parse(raw) as { generatedAt?: number; reports?: OmpReport[] };
  const providers: ProviderQuota[] = [];
  for (const report of input.reports ?? []) {
    const provider = String(report.provider ?? "").trim();
    if (!provider) continue;
    let tightest: { used: number; label: string; resetsAt?: number } | undefined;
    for (const limit of report.limits ?? []) {
      const fraction = typeof limit.amount?.usedFraction === "number"
        ? limit.amount.usedFraction
        : typeof limit.amount?.remainingFraction === "number"
          ? 1 - limit.amount.remainingFraction
          : undefined;
      if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
      if (!tightest || fraction > tightest.used) {
        tightest = {
          used: fraction,
          label: limit.label ?? limit.window?.label ?? limit.id ?? "quota",
          resetsAt: limit.window?.resetsAt,
        };
      }
    }
    providers.push({
      provider,
      usedFraction: tightest?.used ?? 0,
      bindingWindow: tightest?.label,
      resetsAt: tightest?.resetsAt ? new Date(tightest.resetsAt).toISOString() : undefined,
      error: report.error,
    });
  }
  return {
    generatedAt: new Date(input.generatedAt ?? now).toISOString(),
    providers: providers.sort((left, right) => right.usedFraction - left.usedFraction),
  };
}

export class ProviderUsageService {
  constructor(readonly stateRoot: string = loadConfig().stateRoot) {}

  cached(): ProviderUsage | undefined {
    try {
      return JSON.parse(readFileSync(usagePath(this.stateRoot), "utf8")) as ProviderUsage;
    } catch {
      return undefined;
    }
  }

  fresh(maxAgeMs = CACHE_AGE_MS): ProviderUsage | undefined {
    const value = this.cached();
    if (!value) return undefined;
    return Date.now() - new Date(value.generatedAt).getTime() < maxAgeMs ? value : undefined;
  }

  /**
   * Read live quota from OMP.
   *
   * OMP already talks to every authenticated provider and knows each account's
   * remaining window. Asking it is cheaper and more accurate than Mafia holding
   * its own per-provider credentials to ask the same question.
   */
  refresh(): ProviderUsage {
    const result = spawnSync("omp", ["--profile", "mafia", "usage", "--json"], {
      encoding: "utf8",
      env: toolEnvironment(),
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw new Error(`omp usage failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error((result.stderr || "omp usage failed").trim().slice(0, 300));
    const value = parseProviderUsage(result.stdout, Date.now());
    const path = usagePath(this.stateRoot);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return value;
  }

  discover(force = false): ProviderUsage {
    if (!force) {
      const value = this.fresh();
      if (value) return value;
    }
    try {
      return this.refresh();
    } catch {
      return this.cached() ?? { generatedAt: new Date().toISOString(), providers: [] };
    }
  }
}

/**
 * Providers with too little headroom to take new work.
 *
 * A fleet of sixty-four workers can empty a window in one run. Mafia routed
 * across providers with no view of this at all, so a provider at 99% received
 * the same share of work as one at 2%.
 */
export function exhaustedProviders(usage: ProviderUsage | undefined, threshold = 0.95): Set<string> {
  const value = new Set<string>();
  for (const quota of usage?.providers ?? []) {
    if (quota.usedFraction >= threshold) value.add(quota.provider);
  }
  return value;
}

export function formatProviderUsage(usage: ProviderUsage, threshold = 0.95): string {
  if (!usage.providers.length) return "no provider quota reported";
  const bar = (fraction: number) => {
    const filled = Math.max(0, Math.min(20, Math.round(fraction * 20)));
    return `${"#".repeat(filled)}${"-".repeat(20 - filled)}`;
  };
  const lines = usage.providers.map((quota) => {
    const flag = quota.usedFraction >= threshold ? " EXHAUSTED" : "";
    const window = quota.bindingWindow ? ` ${quota.bindingWindow}` : "";
    const resets = quota.resetsAt ? ` resets ${quota.resetsAt.slice(11, 16)}Z` : "";
    return `  ${quota.provider.padEnd(14)} ${bar(quota.usedFraction)} ${`${Math.round(quota.usedFraction * 100)}%`.padStart(4)}${window}${resets}${flag}`;
  });
  return [`provider quota - ${usage.generatedAt}`, ...lines].join("\n");
}

/**
 * The provider-independent name of a model.
 *
 * The same model reaches Mafia by several routes: `anthropic/claude-opus-5`
 * direct and `openrouter/anthropic/claude-opus-5` resold. Both end in the same
 * segment, which makes that segment the identity to match on when one route
 * runs out of quota and the other has not.
 */
export function modelIdentity(model: { id: string; selector: string }): string {
  const source = model.id || model.selector;
  return (source.split("/").at(-1) ?? source).toLowerCase();
}

export function providerHeadroom(usage: ProviderUsage | undefined, provider: string | undefined): number {
  if (!provider) return 1;
  const quota = usage?.providers.find((entry) => entry.provider === provider);
  if (!quota) return 1;
  return Math.max(0, Math.min(1, 1 - quota.usedFraction));
}

export interface ModelSubstitution {
  from: string;
  to: string;
  reason: string;
}

/**
 * Find another route to the same model when the requested one is out of quota.
 *
 * A swap between two routes to the identical model changes nothing about the
 * output, only which account pays. That makes it safe to do without asking,
 * unlike dropping to a smaller model, which this deliberately never does.
 */
export function substituteExhaustedModel<T extends { id: string; selector: string; provider: string; available: boolean; harness: string }>(
  models: readonly T[],
  requested: T,
  usage: ProviderUsage | undefined,
  threshold = 0.95,
  blocked?: ReadonlySet<string>,
): { model: T; substitution: ModelSubstitution } | undefined {
  const spent = blocked ?? exhaustedProviders(usage, threshold);
  if (!spent.has(requested.provider)) return undefined;
  const identity = modelIdentity(requested);
  const alternatives = models
    .filter((model) =>
      model.available &&
      model.selector !== requested.selector &&
      !spent.has(model.provider) &&
      modelIdentity(model) === identity)
    // Prefer staying on the same harness, then the provider with the most room.
    .sort((left, right) =>
      Number(right.harness === requested.harness) - Number(left.harness === requested.harness) ||
      providerHeadroom(usage, right.provider) - providerHeadroom(usage, left.provider));
  const model = alternatives[0];
  if (!model) return undefined;
  const used = Math.round((1 - providerHeadroom(usage, requested.provider)) * 100);
  // Say why from what the quota actually shows. The threshold argument is 0
  // whenever the caller supplies its own blocked set, so it cannot explain a
  // provider that was benched for refusing work while still under its limit.
  const cause = used >= 95 ? `is at ${used}% of its quota` : "recently refused a request";
  return {
    model,
    substitution: {
      from: requested.selector,
      to: model.selector,
      reason: `${requested.provider} ${cause}; the same model is available through ${model.provider}.`,
    },
  };
}

/**
 * Provider failures that mean "stop sending work here now".
 *
 * A window can empty between two quota polls, and an account can lose its
 * authorisation without any quota changing at all. Both show up first as a
 * failed job, so the error text is the earliest signal Mafia gets.
 */
const quotaFailure = /\b(429|402|401)\b|rate[_ -]?limit|quota|insufficient[_ -]?(credit|balance|quota)|payment required|out of credits|unauthor(i[sz])?ed|invalid[_ -]api[_ -]key/i;

export function isQuotaFailure(error: string | undefined): boolean {
  return Boolean(error && quotaFailure.test(error));
}

export function providerOfSelector(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  const head = selector.split("/")[0];
  return head && head !== selector ? head : undefined;
}

export interface ProviderPenalty {
  provider: string;
  until: string;
  reason: string;
}

export function penaltyPath(stateRoot: string): string {
  return join(stateRoot, "provider-penalties.json");
}

export function readPenalties(stateRoot: string, now = Date.now()): ProviderPenalty[] {
  try {
    const value = JSON.parse(readFileSync(penaltyPath(stateRoot), "utf8")) as ProviderPenalty[];
    return value.filter((entry) => new Date(entry.until).getTime() > now);
  } catch {
    return [];
  }
}

/**
 * Bench a provider for a while after it refuses work.
 *
 * The ban is deliberately short. A provider that recovers should come back
 * without anyone clearing state by hand, and a provider that has not recovered
 * will simply fail again and be benched again.
 */
export function penaliseProvider(
  stateRoot: string,
  provider: string,
  reason: string,
  forMs = 15 * 60_000,
  now = Date.now(),
): ProviderPenalty[] {
  const kept = readPenalties(stateRoot, now).filter((entry) => entry.provider !== provider);
  const value = [...kept, { provider, until: new Date(now + forMs).toISOString(), reason: reason.slice(0, 200) }];
  const path = penaltyPath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return value;
}

/** Quota exhaustion and recent refusals, as one set the router can filter on. */
export function unavailableProviders(
  usage: ProviderUsage | undefined,
  stateRoot: string,
  threshold = 0.95,
  now = Date.now(),
): Set<string> {
  const value = exhaustedProviders(usage, threshold);
  for (const penalty of readPenalties(stateRoot, now)) value.add(penalty.provider);
  return value;
}

export interface AccountBalance {
  model: string;
  provider: string;
  samples: number;
  accounts: Array<{ account: string; count: number; percent: number }>;
  failures: number;
  reasons: string[];
}

/**
 * Ask OMP which credential a model would actually resolve to.
 *
 * This resolves credentials without sending a request, so it costs nothing and
 * can run before work is dispatched. A non-zero failure count means the model
 * cannot obtain a credential at all, which quota polling never reveals: an
 * account that has lost its authorisation still reports a healthy window.
 *
 * It also shows how requests spread across several accounts of one provider,
 * which is a level finer than the per-provider view the rest of this file uses.
 */
export function accountBalance(model: string, samples = 20): AccountBalance | undefined {
  const result = spawnSync("omp", [
    "--profile", "mafia", "dry-balance", model, "--count", String(samples), "--json",
  ], { encoding: "utf8", env: toolEnvironment(), timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout) as {
      model?: string; provider?: string; samples?: number;
      success?: { accounts?: Array<{ account?: string; count?: number; percent?: number }> };
      failure?: { total?: number; reasons?: unknown[] };
    };
    return {
      model: value.model ?? model,
      provider: value.provider ?? providerOfSelector(model) ?? "",
      samples: value.samples ?? samples,
      accounts: (value.success?.accounts ?? []).map((entry) => ({
        account: String(entry.account ?? "unknown"),
        count: Number(entry.count ?? 0),
        percent: Number(entry.percent ?? 0),
      })),
      failures: Number(value.failure?.total ?? 0),
      reasons: (value.failure?.reasons ?? []).map((reason) => String(reason).slice(0, 160)),
    };
  } catch {
    return undefined;
  }
}

export function formatAccountBalance(value: AccountBalance): string {
  const lines = [`${value.model} via ${value.provider} - ${value.samples} resolutions`];
  for (const account of value.accounts) {
    lines.push(`  ${String(account.percent).padStart(3)}%  ${account.account}  (${account.count})`);
  }
  if (value.failures) {
    lines.push(`  FAILED ${value.failures}/${value.samples} credential resolutions`);
    for (const reason of value.reasons.slice(0, 3)) lines.push(`      ${reason}`);
  }
  return lines.join("\n");
}
