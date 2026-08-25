import type { AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import {
  agentDisplayName,
  agentRegistryId,
  agentRegistryMetrics,
  agentRegistryStatus,
  isActiveAgent,
} from "../src/agent-display";
import { MafiaService } from "../src/service";
import type { JobStatus } from "../src/types";

const RECENT_WINDOW_MS = 30 * 60_000;
const RECENT_LIMIT = 20;

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function visibleAgentJobs(jobs: JobStatus[], now = Date.now()): JobStatus[] {
  const active = jobs.filter(isActiveAgent);
  const recent = jobs
    .filter((job) => !isActiveAgent(job) && now - timestamp(job.updatedAt) <= RECENT_WINDOW_MS)
    .slice(0, RECENT_LIMIT);
  return [...active, ...recent];
}

export class NativeAgentBridge {
  readonly #registry: AgentRegistry;
  readonly #mafia: Pick<MafiaService, "listCached" | "cancel">;
  readonly #managed = new Map<string, string>();
  #syncing = false;

  constructor(registry: AgentRegistry, mafia: Pick<MafiaService, "listCached" | "cancel"> = new MafiaService()) {
    this.#registry = registry;
    this.#mafia = mafia;
    this.#registry.onChange((event) => {
      if (this.#syncing || !["removed", "status_changed"].includes(event.type)) return;
      if (event.type === "status_changed" && event.ref.status !== "aborted") return;
      const jobId = this.#managed.get(event.ref.id);
      if (!jobId) return;
      const job = this.#mafia.listCached(500).find((item) => item.id === jobId);
      if (!job || !isActiveAgent(job)) return;
      try {
        this.#mafia.cancel(jobId);
      } catch {}
    });
  }

  sync(jobs = this.#mafia.listCached(500)): void {
    const desired = new Map(visibleAgentJobs(jobs).map((job) => [agentRegistryId(job), job]));
    this.#syncing = true;
    try {
      for (const [id] of this.#managed) {
        if (desired.has(id)) continue;
        this.#registry.unregister(id);
        this.#managed.delete(id);
      }

      for (const [id, job] of desired) {
        this.#managed.set(id, job.id);
        const status = agentRegistryStatus(job.state);
        const activity = `${job.host.toUpperCase()} - ${job.title}`;
        const history = {
          agent: job.harness,
          resolvedModel: job.model,
          metrics: agentRegistryMetrics(job.usage),
          branchName: job.branch,
        };
        let ref = this.#registry.get(id);
        if (!ref) {
          ref = this.#registry.register({
            id,
            displayName: `${job.host.toUpperCase()} - ${job.title}`,
            kind: "sub",
            parentId: "Main",
            session: null,
            status,
            activity: status === "running" ? activity : undefined,
            createdAt: timestamp(job.createdAt),
            lastActivity: timestamp(job.heartbeatAt ?? job.updatedAt),
            history,
          });
        } else {
          ref.displayName = `${job.host.toUpperCase()} - ${job.title}`;
          ref.lastActivity = timestamp(job.heartbeatAt ?? job.updatedAt);
          if (ref.status !== status) {
            if (ref.status === "aborted") {
              this.#registry.unregister(id, ref);
              ref = this.#registry.register({
                id,
                displayName: ref.displayName,
                kind: "sub",
                parentId: "Main",
                session: null,
                status,
                activity: status === "running" ? activity : undefined,
                createdAt: timestamp(job.createdAt),
                lastActivity: timestamp(job.heartbeatAt ?? job.updatedAt),
                history,
              });
            } else {
              this.#registry.setStatus(id, status, ref);
            }
          }
          if (status === "running" && ref.activity !== activity) this.#registry.setActivity(id, activity);
          const nextHistory = Object.fromEntries(
            Object.entries(history).filter(([, value]) => value !== undefined),
          );
          if (JSON.stringify(ref.history ?? {}) !== JSON.stringify({ ...ref.history, ...nextHistory })) {
            this.#registry.setHistory(id, history);
          }
        }
      }
    } finally {
      this.#syncing = false;
    }
  }

  refs(): AgentRef[] {
    return [...this.#managed.keys()]
      .map((id) => this.#registry.get(id))
      .filter((ref): ref is AgentRef => Boolean(ref));
  }
}
