import { TelemetryStore } from "./telemetry-store";
import { usableMetrics } from "./bench";
import { exhaustedProviders, ProviderUsageService, readPenalties } from "./provider-usage";
import { readConfiguredRoles, suggestFasterRoles } from "./roles";
import { ModelCatalogService } from "./models";

export interface Insight {
  /** Ranked so the largest lever reads first. */
  weight: number;
  title: string;
  evidence: string;
  action: string;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const big = (value: number) => value.toLocaleString();

/**
 * Cache reads are the cheapest input tokens available, so a harness that is not
 * getting them is paying full price for context it already sent.
 */
function cacheEfficiency(store: TelemetryStore): Insight[] {
  const rows = store.db.query(`
    SELECT harness, host,
      COALESCE(SUM(cache_read_tokens),0) cached,
      COALESCE(SUM(input_tokens),0) fresh
    FROM turns GROUP BY harness, host
    HAVING cached + fresh > 1000000
  `).all() as Array<{ harness: string; host: string; cached: number; fresh: number }>;
  return rows.flatMap((row) => {
    const total = row.cached + row.fresh;
    const rate = row.cached / total;
    if (rate >= 0.8) return [];
    return [{
      // The lever is the tokens that could have been cache reads and were not.
      weight: row.fresh,
      title: `${row.harness} on ${row.host} sends ${pct(1 - rate)} of its input uncached`,
      evidence: `${big(row.fresh)} fresh input tokens against ${big(row.cached)} cache reads.`,
      action: `Compare against the harness that caches well here, and check prompt-prefix stability for ${row.harness}.`,
    }];
  });
}

/**
 * A model whose turns are mostly reasoning is being asked to think about work
 * that a cheaper model could carry out.
 */
function reasoningShare(store: TelemetryStore): Insight[] {
  const rows = store.db.query(`
    SELECT model, harness, COUNT(*) turns,
      COALESCE(SUM(reasoning_tokens),0) reasoning,
      COALESCE(SUM(output_tokens),0) output
    FROM turns WHERE model IS NOT NULL GROUP BY model
    HAVING output > 100000 AND turns > 50
  `).all() as Array<{ model: string; harness: string; turns: number; reasoning: number; output: number }>;
  return rows.flatMap((row) => {
    const share = row.reasoning / row.output;
    if (share < 0.5) return [];
    return [{
      weight: row.reasoning,
      title: `${row.model} spends ${pct(share)} of its output on reasoning`,
      evidence: `${big(row.reasoning)} reasoning tokens of ${big(row.output)} output across ${row.turns} turns.`,
      action: `Consider a lower effort for routine work on this model, or route those tasks to the smol role.`,
    }];
  });
}

/** Work is concentrated somewhere; knowing where says which model choice matters. */
function concentration(store: TelemetryStore): Insight[] {
  const rows = store.db.query(`
    SELECT model, COALESCE(SUM(output_tokens),0) output FROM turns
    WHERE model IS NOT NULL GROUP BY model ORDER BY output DESC
  `).all() as Array<{ model: string; output: number }>;
  const total = rows.reduce((sum, row) => sum + row.output, 0);
  const top = rows[0];
  // One model is trivially all of the output when there is barely any output.
  // A floor keeps this from reporting a pattern that does not exist yet.
  if (!top || total < 1_000_000 || rows.length < 2) return [];
  const share = top.output / total;
  if (share < 0.4) return [];
  return [{
    weight: top.output,
    title: `${top.model} produces ${pct(share)} of all output`,
    evidence: `${big(top.output)} of ${big(total)} output tokens across every harness and host.`,
    action: `Measure this model first: \`mafia bench --models ${top.model}\`. Its latency decides most of the fleet's wait.`,
  }];
}

/** A model with no measurement is being routed on a guess from its name. */
function unmeasured(store: TelemetryStore, stateRoot: string): Insight[] {
  const measured = new Set(Object.keys(usableMetrics(stateRoot)));
  const rows = store.db.query(`
    SELECT model, COUNT(*) turns FROM turns WHERE model IS NOT NULL
    GROUP BY model HAVING turns > 200 ORDER BY turns DESC
  `).all() as Array<{ model: string; turns: number }>;
  const missing = rows.filter((row) =>
    ![...measured].some((selector) => selector.endsWith(row.model) || row.model.endsWith(selector.split("/").at(-1)!)));
  if (!missing.length) return [];
  return [{
    weight: missing.reduce((sum, row) => sum + row.turns, 0),
    title: `${missing.length} heavily used model(s) have no measured latency`,
    evidence: missing.slice(0, 4).map((row) => `${row.model} (${row.turns} turns)`).join(", "),
    action: `mafia bench --models ${missing.slice(0, 3).map((row) => row.model).join(",")}`,
  }];
}

function providerHealth(stateRoot: string): Insight[] {
  const usage = new ProviderUsageService(stateRoot).cached();
  const spent = [...exhaustedProviders(usage)];
  const benched = readPenalties(stateRoot);
  const tight = (usage?.providers ?? []).filter((row) => row.usedFraction >= 0.75 && row.usedFraction < 0.95);
  const out: Insight[] = [];
  if (spent.length || benched.length) {
    out.push({
      weight: 1e12,
      title: `${[...spent, ...benched.map((row) => row.provider)].join(", ")} cannot take work`,
      evidence: `Routing is already avoiding ${spent.length + benched.length} provider(s).`,
      action: `mafia quota --refresh, and mafia roles to see whether a role is stuck on one.`,
    });
  }
  for (const row of tight) {
    out.push({
      weight: 1e11 * row.usedFraction,
      title: `${row.provider} is at ${pct(row.usedFraction)} of its ${row.bindingWindow ?? "quota"}`,
      evidence: row.resetsAt ? `Resets at ${row.resetsAt.slice(11, 16)}Z.` : "No reset time reported.",
      action: `A large fleet run will exhaust this. Spread work or wait for the reset.`,
    });
  }
  return out;
}

function roleSpeed(stateRoot: string): Insight[] {
  const catalog = new ModelCatalogService(stateRoot).cached();
  const usage = new ProviderUsageService(stateRoot).cached();
  const suggestions = suggestFasterRoles(
    readConfiguredRoles(),
    usableMetrics(stateRoot),
    catalog,
    exhaustedProviders(usage),
  );
  return suggestions.map((row) => ({
    weight: 1e10 * (row.fromMs / row.toMs),
    title: `The ${row.role} role could be ${(row.fromMs / row.toMs).toFixed(1)}x faster`,
    evidence: `${row.from} measures ${row.fromMs}ms; ${row.to} measures ${row.toMs}ms.`,
    action: `mafia roles --suggest, then set modelRoles in the OMP profile.`,
  }));
}

/**
 * Derive what to change next from what actually happened.
 *
 * Every finding carries the evidence it came from and one thing to do. A
 * dashboard that reports numbers without naming an action gets read once.
 */
export function buildInsights(stateRoot: string): Insight[] {
  const store = new TelemetryStore(stateRoot);
  return [
    ...providerHealth(stateRoot),
    ...roleSpeed(stateRoot),
    ...unmeasured(store, stateRoot),
    ...cacheEfficiency(store),
    ...concentration(store),
    ...reasoningShare(store),
  ].sort((left, right) => right.weight - left.weight);
}

export function formatInsights(insights: Insight[]): string {
  if (!insights.length) return "nothing stands out - the fleet looks healthy";
  return insights.map((insight, index) =>
    `${String(index + 1).padStart(2)}. ${insight.title}\n    ${insight.evidence}\n    -> ${insight.action}`).join("\n\n");
}
