import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config";
import { toolEnvironment } from "./process";
import { readConfiguredRoles, suggestFasterRoles, healthyRoleModels } from "./roles";
import { usableMetrics, runBench } from "./bench";
import { ModelCatalogService } from "./models";
import { ProviderUsageService, providerHeadroom, exhaustedProviders } from "./provider-usage";
import { TelemetryStore } from "./telemetry-store";
import { runPrAutomation } from "./pr";
import type { ModelCatalog, ModelRecord, ProviderUsage, RoleModels } from "./types";

export type ProposalState = "pending" | "approved" | "applied" | "dismissed" | "expired" | "failed";

export interface Proposal {
  /** Content-hashed, so a dismissed proposal stays dismissed across regeneration. */
  id: string;
  kind: "repin-role" | "bench-model" | "edit-role" | "run-shepherd";
  title: string;
  evidence: string;
  effect: string;
  /** A cost the change would impose, when there is one. Its absence is a claim. */
  tradeoff?: string;
  /** The command a person would run; shown even when Mafia can run it itself. */
  action: string;
  /** True when applying carries no judgement Mafia is not entitled to make. */
  auto: boolean;
  payload: Record<string, unknown>;
  state: ProposalState;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  dismissReason?: string;
  /** Metric snapshot at apply time, so the outcome has something to compare to. */
  before?: string;
  outcome?: string;
}

function id(kind: string, ...facts: Array<string | number | undefined>): string {
  return createHash("sha1").update([kind, ...facts.map(String)].join("|")).digest("hex").slice(0, 12);
}

/**
 * Whether a model is actually free to call.
 *
 * Absent cost data is not zero cost. The catalog carries no pricing for models
 * a harness merely detects, and reading that absence as "free" is how a
 * recommendation quietly moves paid traffic onto a metered window.
 */
export function isFreeModel(model: ModelRecord | undefined): boolean {
  if (!model) return false;
  if (/:free\b/.test(model.selector)) return true;
  return model.cost !== undefined && model.cost.input === 0 && model.cost.output === 0;
}

export class ProposalStore {
  readonly db: Database;

  constructor(stateRoot: string = loadConfig().stateRoot) {
    mkdirSync(stateRoot, { recursive: true });
    // Shares the telemetry database: generation reads it anyway, and proposal
    // writes are rare, so nothing here touches the job store's hot path.
    this.db = new Database(join(stateRoot, "telemetry.db"), { create: true });
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        evidence TEXT NOT NULL,
        effect TEXT NOT NULL,
        tradeoff TEXT,
        action TEXT NOT NULL,
        auto INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        applied_at TEXT,
        dismiss_reason TEXT,
        before_note TEXT,
        outcome TEXT
      );
      CREATE INDEX IF NOT EXISTS proposals_state ON proposals(state, created_at);
    `);
  }

  /**
   * Insert what is new; keep current evidence on what is still pending.
   *
   * A dismissed or applied proposal is never touched — its id is the record of
   * a decision. A pending one, though, must show today's numbers: measurements
   * move, and advice displayed with last week's evidence reads as broken.
   */
  upsertNew(proposals: Proposal[]): number {
    const insert = this.db.query(`
      INSERT OR IGNORE INTO proposals (
        id,kind,title,evidence,effect,tradeoff,action,auto,payload_json,state,created_at,updated_at
      ) VALUES ($id,$kind,$title,$evidence,$effect,$tradeoff,$action,$auto,$payload,'pending',$at,$at)
    `);
    const freshen = this.db.query(`
      UPDATE proposals SET title=$title, evidence=$evidence, effect=$effect, tradeoff=$tradeoff,
        action=$action, auto=$auto, payload_json=$payload, updated_at=$at
      WHERE id=$id AND state='pending'
    `);
    let added = 0;
    this.db.transaction(() => {
      for (const p of proposals) {
        const params = {
          $id: p.id, $kind: p.kind, $title: p.title, $evidence: p.evidence, $effect: p.effect,
          $tradeoff: p.tradeoff ?? null, $action: p.action, $auto: p.auto ? 1 : 0,
          $payload: JSON.stringify(p.payload), $at: p.createdAt,
        };
        const inserted = insert.run(params as never).changes;
        added += inserted;
        if (!inserted) {
          const { $kind: _kind, ...rest } = params;
          freshen.run(rest as never);
        }
      }
    })();
    return added;
  }

  /**
   * Expire pending proposals the latest generation no longer produces.
   *
   * A proposal whose condition has passed — the provider recovered, the model
   * was measured — must leave the list on its own, or the list fills with
   * advice about a world that no longer exists.
   */
  expireMissing(currentIds: ReadonlySet<string>): number {
    const pending = this.db.query("SELECT id FROM proposals WHERE state = 'pending'").all() as Array<{ id: string }>;
    let expired = 0;
    this.db.transaction(() => {
      for (const row of pending) {
        if (currentIds.has(row.id)) continue;
        expired += this.db.query(
          "UPDATE proposals SET state='expired', updated_at=? WHERE id=? AND state='pending'",
        ).run(new Date().toISOString(), row.id).changes;
      }
    })();
    return expired;
  }

  list(states: ProposalState[] = ["pending"]): Proposal[] {
    const marks = states.map(() => "?").join(",");
    const rows = this.db.query(
      `SELECT * FROM proposals WHERE state IN (${marks}) ORDER BY created_at, id`,
    ).all(...states) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), kind: row.kind as Proposal["kind"], title: String(row.title),
      evidence: String(row.evidence), effect: String(row.effect),
      tradeoff: row.tradeoff ? String(row.tradeoff) : undefined,
      action: String(row.action), auto: Boolean(row.auto),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      state: row.state as ProposalState,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      appliedAt: row.applied_at ? String(row.applied_at) : undefined,
      dismissReason: row.dismiss_reason ? String(row.dismiss_reason) : undefined,
      before: row.before_note ? String(row.before_note) : undefined,
      outcome: row.outcome ? String(row.outcome) : undefined,
    }));
  }

  get(ref: string): Proposal | undefined {
    // A bare number refers to a position in the pending list, which is what a
    // person reading the dashboard actually sees.
    if (/^\d{1,2}$/.test(ref)) return this.list()[Number(ref) - 1];
    return this.list(["pending", "approved", "applied", "dismissed", "expired", "failed"])
      .find((p) => p.id === ref || p.id.startsWith(ref));
  }

  setState(pid: string, state: ProposalState, extra: { dismissReason?: string; before?: string; outcome?: string } = {}): void {
    const now = new Date().toISOString();
    this.db.query(`
      UPDATE proposals SET state=$state, updated_at=$now,
        applied_at=CASE WHEN $state='applied' THEN $now ELSE applied_at END,
        dismiss_reason=COALESCE($reason, dismiss_reason),
        before_note=COALESCE($before, before_note),
        outcome=COALESCE($outcome, outcome)
      WHERE id=$id
    `).run({ $state: state, $now: now, $reason: extra.dismissReason ?? null, $before: extra.before ?? null, $outcome: extra.outcome ?? null, $id: pid } as never);
  }
}

export interface GenerationInputs {
  configured: RoleModels;
  catalog: ModelCatalog | undefined;
  usage: ProviderUsage | undefined;
  metrics: Record<string, { selector: string; ttftMs?: number; samples?: number; source?: string }>;
  blocked: ReadonlySet<string>;
  /** Recent pull-request state observations, for the shepherd proposal. */
  prStates: Array<{ state: string; observations: number; last: string }>;
  telemetry?: TelemetryStore;
  stateRoot?: string;
  now?: number;
}

function record(catalog: ModelCatalog | undefined, selector: string): ModelRecord | undefined {
  return catalog?.models.find((m) => m.selector === selector)
    ?? catalog?.models.find((m) => m.selector.endsWith(`/${selector}`) || selector.endsWith(`/${m.selector}`));
}

/**
 * The selector to write into OMP's profile for a model.
 *
 * Metric keys are observed names, and a bare name is ambiguous: OMP resolved
 * a bare "gpt-5.4" to the raw OpenAI provider, whose key is dead, while the
 * intended provider was the Codex subscription. A role selector is always
 * written provider-qualified so resolution cannot wander.
 */
export function canonicalRoleSelector(catalog: ModelCatalog | undefined, name: string, matched?: ModelRecord): string {
  const model = matched ?? record(catalog, name);
  if (!model) return name;
  if (model.selector.includes("/")) return model.selector;
  return `${model.provider}/${model.id}`;
}

/**
 * Turn what the telemetry knows into concrete, decidable proposals.
 *
 * Each is either safe for Mafia to apply itself — the change imposes no cost
 * the operator has not already accepted — or it names the tradeoff and waits.
 * A role move within one provider changes nothing about who pays; a move from
 * a free model onto a metered window is a spending decision, and those are
 * never automatic.
 */
export function generateProposals(inputs: GenerationInputs): Proposal[] {
  const now = new Date(inputs.now ?? Date.now()).toISOString();
  const out: Proposal[] = [];

  // Faster models for latency-sensitive roles, with the cost question answered.
  for (const s of suggestFasterRoles(inputs.configured, inputs.metrics, inputs.catalog, inputs.blocked)) {
    const from = record(inputs.catalog, s.from);
    const to = record(inputs.catalog, s.to);
    const sameProvider = Boolean(from && to && from.provider === to.provider);
    const freeToMetered = isFreeModel(from) && !isFreeModel(to);
    const toHeadroom = providerHeadroom(inputs.usage, to?.provider);
    const tighterTarget = Boolean(to && from && to.provider !== from.provider && toHeadroom < providerHeadroom(inputs.usage, from.provider));
    const tradeoffs: string[] = [];
    if (freeToMetered) tradeoffs.push(`moves free work onto ${to?.provider ?? "a metered provider"}'s quota`);
    else if (!sameProvider && to && !isFreeModel(to)) tradeoffs.push(`shifts load to ${to.provider} (${Math.round(toHeadroom * 100)}% headroom left)`);
    if (tighterTarget) tradeoffs.push("the target provider has less quota headroom than the current one");
    const auto = sameProvider && !freeToMetered;
    const target = canonicalRoleSelector(inputs.catalog, s.to, to);
    const roles = { ...inputs.configured, [s.role]: target };
    out.push({
      id: id("repin-role", s.role, s.from, target),
      kind: "repin-role",
      title: `Repin ${s.role}: ${s.from} -> ${target}`,
      evidence: `${s.from} measures ${s.fromMs}ms; ${s.to} measures ${s.toMs}ms.`,
      effect: `${(s.fromMs / s.toMs).toFixed(1)}x faster ${s.role} work${sameProvider ? ", same provider, no quota shift" : ""}.`,
      tradeoff: tradeoffs.length ? tradeoffs.join("; ") : undefined,
      action: `omp --profile mafia config set modelRoles '${JSON.stringify(roles)}'`,
      auto,
      payload: { role: s.role, from: s.from, to: target, roles, fromMs: s.fromMs, toMs: s.toMs },
      state: "pending", createdAt: now, updatedAt: now,
    });
  }

  // Roles stuck on a provider that cannot take work and has no override flag.
  const health = healthyRoleModels(inputs.configured, inputs.catalog, inputs.usage, inputs.stateRoot ?? loadConfig().stateRoot);
  for (const stuck of health.unfixable) {
    out.push({
      id: id("edit-role", stuck.role, stuck.from),
      kind: "edit-role",
      title: `The ${stuck.role} role is stuck on a dead provider`,
      evidence: stuck.reason,
      effect: "OMP's own subagents stop calling a provider that refuses work.",
      action: `omp --profile mafia config set modelRoles '<json with ${stuck.role} changed>'`,
      auto: false,
      payload: { role: stuck.role, from: stuck.from },
      state: "pending", createdAt: now, updatedAt: now,
    });
  }

  // Heavily used models routing on a name-pattern guess.
  if (inputs.telemetry) {
    const heavy = inputs.telemetry.db.query(`
      SELECT model, COUNT(*) turns FROM turns WHERE model IS NOT NULL
      GROUP BY model HAVING turns > 500 ORDER BY turns DESC LIMIT 6
    `).all() as Array<{ model: string; turns: number }>;
    const measured = Object.keys(inputs.metrics);
    const missing = heavy.filter((row) =>
      !measured.some((sel) => sel === row.model || sel.endsWith(`/${row.model}`) || row.model.endsWith(`/${sel.split("/").at(-1)}`)));
    if (missing.length) {
      const models = missing.slice(0, 3).map((m) => m.model);
      out.push({
        id: id("bench-model", ...models),
        kind: "bench-model",
        title: `Measure ${models.length} heavily used model(s)`,
        evidence: missing.slice(0, 3).map((m) => `${m.model} (${m.turns} turns, unmeasured)`).join(", "),
        effect: "Routing scores these from their names today; a measurement replaces the guess.",
        tradeoff: "spends a few benchmark requests of real quota",
        action: `mafia bench --models ${models.join(",")}`,
        auto: true,
        payload: { models },
        state: "pending", createdAt: now, updatedAt: now,
      });
    }
  }

  // Work sitting in review states the shepherd exists to clear.
  const dayAgo = (inputs.now ?? Date.now()) - 86_400_000;
  const actionable = inputs.prStates.filter((row) =>
    ["threads-open", "ci-failing", "conflicting"].includes(row.state)
    && row.observations > 0
    && new Date(row.last).getTime() > dayAgo);
  if (actionable.length) {
    out.push({
      id: id("run-shepherd", ...actionable.map((a) => a.state).sort()),
      kind: "run-shepherd",
      title: "Run the PR shepherd now",
      evidence: `Observed in the last day: ${actionable.map((a) => a.state).join(", ")}.`,
      effect: "The shepherd fixes review threads and CI on open pull requests; this starts its existing unit early.",
      action: "mafia prs --shepherd",
      auto: true,
      payload: { states: actionable.map((a) => a.state) },
      state: "pending", createdAt: now, updatedAt: now,
    });
  }

  return out;
}

export interface ApplyDeps {
  setRoles: (roles: RoleModels, changed: string) => { ok: boolean; detail: string };
  bench: (models: string[]) => { ok: boolean; detail: string };
  shepherd: () => { ok: boolean; detail: string };
}

/**
 * Ask OMP whether a selector resolves to a provider with working credentials.
 *
 * `dry-balance` resolves without sending a request, so the check is free. This
 * gate exists because an apply once wrote a selector that resolved to a dead
 * provider: the config change succeeded, and the role broke.
 */
export function validateRoleSelector(selector: string): { ok: boolean; detail: string } {
  const result = spawnSync("omp", ["--profile", "mafia", "dry-balance", selector, "--count", "2", "--json"], {
    encoding: "utf8", env: toolEnvironment(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, detail: `cannot resolve ${selector}: ${(result.stderr || result.stdout || "dry-balance failed").trim().slice(0, 100)}` };
  }
  try {
    const value = JSON.parse(result.stdout) as { provider?: string; failure?: { total?: number } };
    const failures = Number(value.failure?.total ?? 0);
    if (failures > 0) {
      return { ok: false, detail: `${selector} resolves to ${value.provider ?? "?"} but ${failures} credential resolution(s) failed - the provider has no working key` };
    }
    return { ok: true, detail: `${selector} resolves to ${value.provider ?? "?"} with working credentials` };
  } catch {
    return { ok: false, detail: `dry-balance returned nothing readable for ${selector}` };
  }
}

export function defaultApplyDeps(stateRoot: string): ApplyDeps {
  return {
    setRoles: (roles, changed) => {
      const gate = validateRoleSelector(roles[changed] ?? changed);
      if (!gate.ok) return { ok: false, detail: gate.detail };
      const result = spawnSync("omp", ["--profile", "mafia", "config", "set", "modelRoles", JSON.stringify(roles)], {
        encoding: "utf8", env: toolEnvironment(), timeout: 60_000,
      });
      if (result.error || result.status !== 0) {
        return { ok: false, detail: (result.stderr || result.stdout || "omp config set failed").trim().slice(0, 140) };
      }
      // The five-minute role cache would otherwise keep serving the old map.
      try {
        const { rmSync } = require("node:fs") as typeof import("node:fs");
        rmSync(join(stateRoot, "cursors", "roles-mafia.json"), { force: true });
      } catch {}
      return { ok: true, detail: (result.stdout || "roles updated").trim().slice(0, 140) };
    },
    bench: (models) => {
      try {
        const { measured } = runBench({ models, stateRoot, runs: 2, maxTokens: 64 });
        return { ok: true, detail: `measured ${Object.keys(measured).length} model(s)` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message.slice(0, 140) : String(error) };
      }
    },
    shepherd: () => {
      try {
        runPrAutomation("shepherd");
        return { ok: true, detail: "shepherd started" };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message.slice(0, 140) : String(error) };
      }
    },
  };
}

/**
 * Apply an approved proposal.
 *
 * A manual proposal is never executed here, whatever its state says: approval
 * of a tradeoff is consent to the decision, and the command is still the
 * operator's to run. The distinction is what keeps `auto` honest.
 */
export function applyProposal(store: ProposalStore, proposal: Proposal, deps: ApplyDeps): { ok: boolean; detail: string } {
  if (!proposal.auto) {
    store.setState(proposal.id, "approved");
    return { ok: true, detail: `approved - run it yourself: ${proposal.action}` };
  }
  let result: { ok: boolean; detail: string };
  let before: string | undefined;
  switch (proposal.kind) {
    case "repin-role": {
      const p = proposal.payload as { roles: RoleModels; from: string; role: string; fromMs?: number };
      before = p.fromMs ? `${p.from} at ${p.fromMs}ms` : p.from;
      result = deps.setRoles(p.roles, p.role);
      break;
    }
    case "bench-model":
      result = deps.bench((proposal.payload as { models: string[] }).models);
      break;
    case "run-shepherd":
      result = deps.shepherd();
      break;
    default:
      result = { ok: false, detail: `no automatic apply for ${proposal.kind}` };
  }
  store.setState(proposal.id, result.ok ? "applied" : "failed", { before, outcome: result.ok ? undefined : result.detail });
  return result;
}

/**
 * Record what an applied proposal actually did, once the data exists.
 *
 * An approve button without a measured outcome is a suggestion box. The repin
 * outcome waits for observed latency on the new model, which arrives from real
 * work rather than from the apply itself.
 */
export function measureOutcomes(store: ProposalStore, metrics: GenerationInputs["metrics"]): number {
  let measured = 0;
  for (const p of store.list(["applied"])) {
    if (p.outcome) continue;
    if (p.kind === "repin-role") {
      const to = (p.payload as { to: string; fromMs?: number }).to;
      const metric = metrics[to] ?? Object.values(metrics).find((m) => m.selector.endsWith(to));
      if (!metric?.ttftMs || !p.appliedAt) continue;
      const fromMs = (p.payload as { fromMs?: number }).fromMs;
      store.setState(p.id, "applied", {
        outcome: `now measuring ${metric.ttftMs}ms${fromMs ? ` (was ${fromMs}ms, ${(fromMs / metric.ttftMs).toFixed(1)}x)` : ""} from ${metric.samples ?? 1} sample(s)`,
      });
      measured++;
    }
    if (p.kind === "bench-model") {
      const models = (p.payload as { models: string[] }).models;
      const done = models.filter((m) => metrics[m] ?? Object.values(metrics).some((x) => x.selector.endsWith(m)));
      if (done.length === models.length) {
        store.setState(p.id, "applied", { outcome: `all ${models.length} model(s) now measured` });
        measured++;
      }
    }
  }
  return measured;
}

/** Regenerate from live inputs: insert what is new, expire what no longer holds. */
export function refreshProposals(stateRoot = loadConfig().stateRoot): { created: number; expired: number; pending: number } {
  const store = new ProposalStore(stateRoot);
  const telemetry = new TelemetryStore(stateRoot);
  const usage = new ProviderUsageService(stateRoot).cached();
  const metrics = usableMetrics(stateRoot);
  const generated = generateProposals({
    configured: readConfiguredRoles(),
    catalog: new ModelCatalogService(stateRoot).cached(),
    usage,
    metrics,
    blocked: exhaustedProviders(usage),
    prStates: telemetry.prStates(2).map((row) => ({ state: row.state, observations: row.observations, last: row.last })),
    telemetry,
    stateRoot,
  });
  const created = store.upsertNew(generated);
  const expired = store.expireMissing(new Set(generated.map((p) => p.id)));
  measureOutcomes(store, metrics);
  return { created, expired, pending: store.list().length };
}

export function formatProposals(pending: Proposal[], recent: Proposal[] = []): string {
  if (!pending.length && !recent.length) return "no open proposals - the fleet has nothing to suggest";
  const lines: string[] = [];
  pending.forEach((p, index) => {
    lines.push(`  [${index + 1}] ${p.auto ? "auto" : "ask "}  ${p.title}`);
    lines.push(`        ${p.evidence}`);
    lines.push(`        effect: ${p.effect}`);
    if (p.tradeoff) lines.push(`        tradeoff: ${p.tradeoff}`);
  });
  if (pending.length) {
    lines.push("");
    lines.push("  approve: mafia proposals approve N   dismiss: mafia proposals dismiss N --why '...'");
  }
  const settled = recent.filter((p) => ["applied", "failed"].includes(p.state)).slice(-4);
  if (settled.length) {
    lines.push("", "  recently applied");
    for (const p of settled) {
      lines.push(`    ${p.state === "failed" ? "FAILED" : "done  "}  ${p.title}${p.outcome ? ` - ${p.outcome}` : ""}`);
    }
  }
  return lines.join("\n");
}
