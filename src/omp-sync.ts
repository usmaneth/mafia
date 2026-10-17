/**
 * Pure logic for the weekly OMP refresh: which models the model page shows,
 * when the refresh is due, and how to read the output of `omp update --check`.
 * Nothing here starts a process or touches a file, so tests can run it alone.
 */

export interface CatalogEntry {
  provider: string;
  id: string;
}

interface FamilyRule {
  /** The provider name that the selector uses. */
  provider: string;
  /**
   * Providers whose catalog entries feed this rule, best source first. Only the
   * first source that has a matching entry is used.
   */
  sources: string[];
  id: RegExp;
  family: (match: RegExpMatchArray) => string;
  version: (match: RegExpMatchArray) => number[];
}

/** Ids that are not chat or coding models. No rule accepts these. */
const notForChat =
  /(audio|realtime|transcribe|tts|image|search|chat|instruct|embedding|moderation|deep-research|live|translate|robotics|omni|customtools|computer-use|lyria|banana|antigravity|contributor)/;

const dotted = (text: string): number[] => text.split(".").map(Number);

/**
 * One rule per model line. A new line that no rule matches is left out, which
 * is the safe failure: the page misses a model, but it never shows a wrong one.
 */
const rules: FamilyRule[] = [
  {
    provider: "anthropic",
    sources: ["anthropic"],
    // The end anchor drops dated ids such as claude-opus-4-1-20250805.
    id: /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+(?:-\d+)?)$/,
    family: (match) => match[1]!,
    version: (match) => match[2]!.split("-").map(Number),
  },
  {
    // Mafia sends GPT work through Codex OAuth only (see codexOAuthEnvironment),
    // so the selector names openai-codex. The openai catalog is the fallback
    // source of ids, because Codex lists no models while its login is dead.
    provider: "openai-codex",
    sources: ["openai-codex", "openai"],
    id: /^gpt-(\d+(?:\.\d+)?)-([a-z]+(?:-pro)?)$/,
    family: (match) => match[2]!,
    version: (match) => dotted(match[1]!),
  },
  {
    provider: "openai-codex",
    sources: ["openai-codex", "openai"],
    id: /^gpt-(\d+(?:\.\d+)?)(-pro)?$/,
    family: (match) => `gpt${match[2] ?? ""}`,
    version: (match) => dotted(match[1]!),
  },
  {
    provider: "google",
    sources: ["google"],
    // A preview and its final release are one family, so the final one wins.
    id: /^gemini-(\d+(?:\.\d+)?)-(.+?)(?:-preview(?:-[\d-]+)?)?$/,
    family: (match) => match[2]!,
    version: (match) => dotted(match[1]!),
  },
  {
    provider: "xai-oauth",
    sources: ["xai-oauth"],
    id: /^grok-(\d+(?:\.\d+)?)$/,
    family: () => "grok",
    version: (match) => dotted(match[1]!),
  },
  {
    provider: "xai-oauth",
    sources: ["xai-oauth"],
    id: /^grok-build$/,
    family: () => "build",
    // A model with no version number is never retired.
    version: () => [],
  },
];

/** The order of provider groups on the model page. */
const providerOrder = ["anthropic", "openai-codex", "google", "xai-oauth"];

const thinkingSuffixes = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

/**
 * Remove a trailing thinking level from a selector. A tail that is not a level
 * stays, because `:free` is part of an OpenRouter id.
 */
export function stripThinking(selector: string): string {
  const index = selector.lastIndexOf(":");
  if (index <= 0) return selector;
  return thinkingSuffixes.has(selector.slice(index + 1)) ? selector.slice(0, index) : selector;
}

/** Compare two version lists number by number. A missing number counts as zero. */
export function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

interface Pick {
  selector: string;
  provider: string;
  family: string;
  version: number[];
}

export interface Latest extends Pick {
  id: string;
}

/**
 * The generation that a provider's families are measured against: the newest
 * major version that at least two families reach. One new family alone does not
 * start a generation, so it does not retire the others.
 */
function anchorMajor(picks: Latest[]): number {
  const counts = new Map<number, number>();
  for (const pick of picks) {
    if (pick.version.length) counts.set(pick.version[0]!, (counts.get(pick.version[0]!) ?? 0) + 1);
  }
  const shared = [...counts].filter(([, count]) => count >= 2).map(([major]) => major);
  return Math.max(...(shared.length ? shared : [...counts.keys()]), 0);
}

/**
 * The newest model of every family, in the order of the model page.
 *
 * A family whose newest model is more than one major version behind its
 * provider's current generation is retired (for example gpt-4-turbo).
 */
export function pickLatest(catalog: CatalogEntry[]): Latest[] {
  // One source for each provider. A source that lists any matching model feeds
  // every rule of that provider, so a fallback never adds to a working source.
  const sourceOf = new Map<string, string | undefined>();
  for (const rule of rules) {
    if (sourceOf.has(rule.provider)) continue;
    const same = rules.filter((other) => other.provider === rule.provider);
    sourceOf.set(
      rule.provider,
      rule.sources.find((name) =>
        catalog.some((entry) => entry.provider === name && !notForChat.test(entry.id) && same.some((other) => other.id.test(entry.id))),
      ),
    );
  }
  const best = new Map<string, Latest>();
  for (const [index, rule] of rules.entries()) {
    const source = sourceOf.get(rule.provider);
    if (!source) continue;
    for (const entry of catalog) {
      if (entry.provider !== source || notForChat.test(entry.id)) continue;
      const match = entry.id.match(rule.id);
      if (!match) continue;
      const family = rule.family(match);
      const version = rule.version(match);
      const key = `${index}|${rule.provider}|${family}`;
      const current = best.get(key);
      const newer = !current || compareVersions(version, current.version) > 0;
      // On a tie the shorter id wins, so the final release beats its preview.
      const shorter = current && compareVersions(version, current.version) === 0 && entry.id.length < current.id.length;
      if (newer || shorter) {
        best.set(key, { selector: `${rule.provider}/${entry.id}`, provider: rule.provider, family, version, id: entry.id });
      }
    }
  }
  const all = [...best.values()];
  const floor = new Map<string, number>();
  for (const provider of new Set(all.map((pick) => pick.provider))) {
    floor.set(provider, anchorMajor(all.filter((pick) => pick.provider === provider)) - 1);
  }
  const rank = (provider: string) => {
    const position = providerOrder.indexOf(provider);
    return position === -1 ? providerOrder.length : position;
  };
  return all
    .filter((pick) => !pick.version.length || pick.version[0]! >= (floor.get(pick.provider) ?? 0))
    .sort((left, right) =>
      rank(left.provider) - rank(right.provider)
      || compareVersions(right.version, left.version)
      || left.family.localeCompare(right.family),
    );
}

/**
 * The model page: the newest model of every family, plus the models that a role
 * already uses. Pinned selectors keep their place even when a newer model
 * exists, because a role that points at an older model is the operator's choice.
 */
export function buildShowcase(catalog: CatalogEntry[], pins: string[] = []): string[] {
  const list: string[] = [];
  for (const selector of [...pickLatest(catalog).map((pick) => pick.selector), ...pins.map(stripThinking)]) {
    if (selector.includes("/") && !list.includes(selector)) list.push(selector);
  }
  return list;
}

export interface RoleUpgrade {
  role: string;
  from: string;
  to: string;
}

/**
 * Roles that point at an older model of a family than the catalog offers.
 * This only reports. The roles belong to the operator.
 */
export function roleUpgrades(catalog: CatalogEntry[], roles: Record<string, string>): RoleUpgrade[] {
  const latest = pickLatest(catalog);
  const upgrades: RoleUpgrade[] = [];
  for (const [role, value] of Object.entries(roles)) {
    const selector = stripThinking(value);
    const slash = selector.indexOf("/");
    if (slash <= 0) continue;
    const provider = selector.slice(0, slash);
    const id = selector.slice(slash + 1);
    for (const rule of rules.filter((candidate) => candidate.provider === provider)) {
      const match = id.match(rule.id);
      if (!match) continue;
      const family = rule.family(match);
      const newest = latest.find((pick) => pick.provider === provider && pick.family === family);
      if (newest && compareVersions(newest.version, rule.version(match)) > 0) {
        upgrades.push({ role, from: selector, to: newest.selector });
      }
      break;
    }
  }
  return upgrades;
}

/**
 * Keep what a person added by hand.
 *
 * `previous` is the list that the last refresh wrote. An entry in `current`
 * that is not in `previous` came from a person, so it stays. An entry that the
 * last refresh wrote and this refresh dropped goes away.
 */
export function mergeShowcase(next: string[], current: string[], previous: string[]): string[] {
  const written = new Set(previous);
  const added = current.filter((selector) => !written.has(selector) && !next.includes(selector));
  return [...next, ...added];
}

export const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60_000;
/** A failed refresh waits this long before the next try. */
export const RETRY_INTERVAL_MS = 60 * 60_000;

export interface SyncState {
  /** When the last refresh finished. */
  at?: number;
  /** When the last refresh started, whether or not it worked. */
  attemptedAt?: number;
  /** The OMP version at the last refresh. */
  omp?: string;
  /** The list that the last refresh wrote. */
  managed?: string[];
}

/**
 * Whether the refresh runs now.
 *
 * It runs once a week, on demand, and at once when the installed OMP is not the
 * version that the last refresh saw, because a new version brings a new catalog.
 * A failed try waits an hour so that an offline machine does not retry every pass.
 */
export function refreshDue(state: SyncState | undefined, now: number, installed?: string, force = false): boolean {
  if (force) return true;
  if (state?.attemptedAt && state.attemptedAt > (state.at ?? 0) && now - state.attemptedAt < RETRY_INTERVAL_MS) {
    return false;
  }
  if (!state?.at) return true;
  if (installed && state.omp !== installed) return true;
  return now - state.at >= REFRESH_INTERVAL_MS;
}

/** Read `omp update --check`. It names a new version only when one exists. */
export function parseUpdateCheck(output: string): { current?: string; latest?: string } {
  return {
    current: output.match(/Current version:\s*(\S+)/)?.[1],
    latest: output.match(/New version available:\s*(\S+)/)?.[1],
  };
}

/** Read the version from `omp --version`, for example `omp/18.11.3`. */
export function parseOmpVersion(output: string): string | undefined {
  return output.match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/)?.[1];
}

/** The OMP version that package.json pins, or undefined when the pins disagree. */
export function pinnedOmp(packageJson: { dependencies?: Record<string, string> }): string | undefined {
  const pins = ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-tui"].map((name) => packageJson.dependencies?.[name]);
  return pins[0] && pins.every((pin) => pin === pins[0]) ? pins[0] : undefined;
}
