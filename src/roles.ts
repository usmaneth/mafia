import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
import { toolEnvironment } from "./process";
import {
  providerHeadroom,
  substituteExhaustedModel,
  unavailableProviders,
} from "./provider-usage";
import type { ModelCatalog, ModelRecord, ProviderUsage, RoleModels } from "./types";

/**
 * The roles OMP accepts as a command-line override.
 *
 * `advisor` is a boolean switch, not a model selector, and `task` and
 * `designer` are configuration-only. Overriding a role OMP cannot take on the
 * command line would silently do nothing, so only these three are handled.
 */
export const overridableRoles = ["smol", "slow", "plan"] as const;
export type OverridableRole = (typeof overridableRoles)[number];

export interface RoleChange {
  /** Any configured role name. `unfixable` carries roles OMP cannot override. */
  role: string;
  from: string;
  to: string;
  reason: string;
}

/** Reading the profile spawns OMP, which costs 364 ms. It changes rarely. */
const ROLE_CACHE_MS = 5 * 60_000;

function roleCachePath(profile: string): string {
  return join(loadConfig().stateRoot, "cursors", `roles-${profile}.json`);
}

export function readConfiguredRoles(profile = "mafia"): RoleModels {
  try {
    const cached = JSON.parse(readFileSync(roleCachePath(profile), "utf8")) as { at?: number; roles?: RoleModels };
    if (cached.at && cached.roles && Date.now() - cached.at < ROLE_CACHE_MS) return cached.roles;
  } catch {}
  const roles = fetchConfiguredRoles(profile);
  if (Object.keys(roles).length) {
    try {
      const path = roleCachePath(profile);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ at: Date.now(), roles })}\n`, { mode: 0o600 });
    } catch {}
  }
  return roles;
}

function fetchConfiguredRoles(profile: string): RoleModels {
  const result = spawnSync("omp", ["--profile", profile, "config", "get", "modelRoles", "--json"], {
    encoding: "utf8",
    env: toolEnvironment(),
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return {};
  try {
    const value = JSON.parse(result.stdout) as { value?: Record<string, unknown> };
    const roles: RoleModels = {};
    for (const [role, model] of Object.entries(value.value ?? {})) {
      if (typeof model === "string" && model.trim()) roles[role] = model.trim();
    }
    return roles;
  } catch {
    return {};
  }
}

function findRecord(catalog: ModelCatalog, selector: string): ModelRecord | undefined {
  const base = selector.split(":").slice(0, -1).join(":") || selector;
  return catalog.models.find((model) => model.selector === selector)
    ?? catalog.models.find((model) => model.selector === base);
}

/**
 * Replace role models whose provider cannot take work.
 *
 * Mafia only ever set OMP's top-level `--model`. Every subagent OMP starts for
 * itself uses the roles from its profile, so a dead provider there kept being
 * called no matter how carefully the outer model was chosen. On the VPS both
 * `default` and `task` pointed at OpenRouter after it ran out of credits.
 *
 * A role is only rewritten when the same model is reachable another way, or
 * when another healthy model already fills a different role. Nothing here
 * invents a model the operator never chose.
 */
export function healthyRoleModels(
  configured: RoleModels,
  catalog: ModelCatalog | undefined,
  usage: ProviderUsage | undefined,
  stateRoot: string,
): { overrides: RoleModels; changes: RoleChange[]; unfixable: RoleChange[] } {
  const overrides: RoleModels = {};
  const changes: RoleChange[] = [];
  const unfixable: RoleChange[] = [];
  if (!catalog) return { overrides, changes, unfixable };
  const blocked = unavailableProviders(usage, stateRoot);
  if (!blocked.size) return { overrides, changes, unfixable };

  // Every configured role is checked, but only three can be overridden on the
  // command line. Reporting on just those three would have said "all roles are
  // healthy" while `task` pointed at a provider that was out of credits.
  for (const [name, selector] of Object.entries(configured)) {
    if ((overridableRoles as readonly string[]).includes(name)) continue;
    // `default` is not stuck: Mafia always passes an explicit --model, which
    // supersedes it, and that model already went through the quota check.
    if (name === "default") continue;
    const record = findRecord(catalog, selector);
    if (!record || !blocked.has(record.provider)) continue;
    unfixable.push({
      role: name,
      from: selector,
      to: selector,
      reason: `${record.provider} cannot take work, and OMP has no --${name} flag. Change the role in the profile.`,
    });
  }

  for (const role of overridableRoles) {
    const selector = configured[role];
    if (!selector) continue;
    const record = findRecord(catalog, selector);
    if (!record || !blocked.has(record.provider)) continue;
    const suffix = selector.slice(record.selector.length);

    const swap = substituteExhaustedModel(catalog.models, record, usage, 0, blocked);
    if (swap) {
      overrides[role] = `${swap.model.selector}${suffix}`;
      changes.push({ role, from: selector, to: overrides[role]!, reason: swap.substitution.reason });
      continue;
    }
    // No second route to the same model. Borrow another configured role's
    // model, but only one that suits this role. Repinning the reasoning role to
    // a flash model would quietly weaken every plan the agent makes, which is
    // the same silent downgrade the top-level model selection refuses to do.
    const healthy = Object.entries(configured)
      .filter(([other]) => other !== role && other !== "default")
      .map(([, value]) => findRecord(catalog, value))
      .filter((value): value is ModelRecord => Boolean(value) && !blocked.has(value!.provider));
    const tier = (model: ModelRecord) => model.cost?.output ?? 0;
    const wanted = tier(record);
    const stand = role === "smol"
      // A cheap role may take anything; cheaper is the point.
      ? healthy.sort((left, right) => tier(left) - tier(right))[0]
      // A reasoning or planning role must not get weaker.
      : healthy.filter((model) => tier(model) >= wanted * 0.6)
        .sort((left, right) => tier(right) - tier(left))[0];
    if (!stand) {
      unfixable.push({
        role,
        from: selector,
        to: selector,
        reason: `${record.provider} cannot take work and no comparable model is available for the ${role} role.`,
      });
      continue;
    }
    overrides[role] = stand.selector;
    changes.push({
      role,
      from: selector,
      to: stand.selector,
      reason: `${record.provider} cannot take work; ${stand.selector} is the closest healthy model for the ${role} role.`,
    });
  }
  return { overrides, changes, unfixable };
}

/** Command-line flags that pin OMP's roles to healthy models. */
export function roleArgs(overrides: RoleModels | undefined): string[] {
  if (!overrides) return [];
  return overridableRoles.flatMap((role) =>
    overrides[role] ? [`--${role}`, overrides[role]!] : []);
}

export function formatRoleChanges(changes: RoleChange[], unfixable: RoleChange[] = []): string {
  const lines: string[] = [];
  for (const change of changes) {
    lines.push(`  repinned ${change.role}: ${change.from} -> ${change.to}`, `      ${change.reason}`);
  }
  for (const problem of unfixable) {
    lines.push(`  STUCK    ${problem.role}: ${problem.from}`, `      ${problem.reason}`);
  }
  if (!lines.length) return "every OMP role points at a provider that can take work";
  return lines.join("\n");
}

export interface RoleSuggestion {
  role: string;
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
}

/**
 * Suggest a faster model for a role, from latency the fleet actually observed.
 *
 * These are suggestions, never applied on their own. Repinning a role because
 * its provider is dead restores a capability the operator already chose;
 * repinning it because something is quicker overrides that choice, and speed is
 * not always what a role was picked for.
 *
 * The names mislead in both directions here: a model called `mini` measured
 * slower than the full model it shrinks, and one called `flash` was the slowest
 * of everything configured.
 */
export function suggestFasterRoles(
  configured: RoleModels,
  metrics: Record<string, { selector: string; ttftMs?: number }>,
  catalog: ModelCatalog | undefined,
  blocked: ReadonlySet<string> = new Set(),
  minimumGain = 1.5,
): RoleSuggestion[] {
  if (!catalog) return [];
  const latency = (selector: string): number | undefined => {
    const exact = metrics[selector]?.ttftMs;
    if (exact) return exact;
    const tail = selector.split("/").at(-1)!.toLowerCase();
    return Object.values(metrics).find((entry) => entry.selector.toLowerCase().endsWith(tail))?.ttftMs;
  };
  const healthy = Object.values(metrics)
    .filter((entry) => entry.ttftMs)
    .map((entry) => ({ entry, record: catalog.models.find((model) => model.selector === entry.selector) }))
    .filter((row) => row.record && !blocked.has(row.record.provider));

  const suggestions: RoleSuggestion[] = [];
  for (const [role, selector] of Object.entries(configured)) {
    // Only roles where speed is the point. A reasoning role is chosen for depth.
    if (!["smol", "task", "designer"].includes(role)) continue;
    const current = latency(selector);
    if (!current) continue;
    const better = healthy
      .filter((row) => row.entry.ttftMs! * minimumGain <= current)
      .sort((left, right) => left.entry.ttftMs! - right.entry.ttftMs!)[0];
    if (!better) continue;
    suggestions.push({
      role,
      from: selector,
      to: better.entry.selector,
      fromMs: current,
      toMs: better.entry.ttftMs!,
    });
  }
  return suggestions;
}

export function formatRoleSuggestions(suggestions: RoleSuggestion[]): string {
  if (!suggestions.length) return "no role would gain meaningfully from a faster model";
  return [
    "measured latency suggests a faster model for these roles:",
    ...suggestions.map((entry) =>
      `  ${entry.role.padEnd(9)} ${entry.from} (${entry.fromMs}ms)\n            -> ${entry.to} (${entry.toMs}ms, ${(entry.fromMs / entry.toMs).toFixed(1)}x faster)`),
    "",
    "  Apply with: omp --profile mafia config set modelRoles '<json>'",
  ].join("\n");
}
