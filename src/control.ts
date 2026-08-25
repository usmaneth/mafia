import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createId } from "./id";
import { JobStore } from "./store";
import type {
  ArtifactRef,
  DecisionRecord,
  MafiaEvent,
  MafiaMessage,
  MessageType,
  TeamCheckpoint,
  UsageMetrics,
} from "./types";

function jsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}

export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export function artifact(path: string, description?: string, kind?: string): ArtifactRef {
  const ref: ArtifactRef = { path, description, kind };
  if (existsSync(path)) {
    ref.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return ref;
}

export class ControlPlane {
  readonly store: JobStore;

  constructor(readonly stateRoot: string) {
    this.store = new JobStore(stateRoot);
    mkdirSync(join(stateRoot, "events"), { recursive: true });
    mkdirSync(join(stateRoot, "rooms"), { recursive: true });
    mkdirSync(join(stateRoot, "checkpoints"), { recursive: true });
  }

  event(input: Omit<MafiaEvent, "id" | "createdAt">): MafiaEvent {
    const value: MafiaEvent = { ...input, id: createId("evt"), createdAt: new Date().toISOString() };
    this.store.insertEvent(value);
    appendJsonLine(join(this.stateRoot, "events", "audit.jsonl"), value);
    return value;
  }

  send(input: {
    teamId?: string;
    room?: string;
    from: string;
    to?: string;
    type?: MessageType;
    body: string;
    artifacts?: ArtifactRef[];
    host?: string;
    jobId?: string;
  }): MafiaMessage {
    const value: MafiaMessage = {
      id: createId("msg"),
      teamId: input.teamId,
      room: input.room ?? (input.teamId ? `team:${input.teamId}` : "mafia"),
      from: input.from,
      to: input.to,
      type: input.type ?? "message",
      body: input.body,
      artifacts: input.artifacts ?? [],
      host: input.host,
      jobId: input.jobId,
      createdAt: new Date().toISOString(),
    };
    this.store.insertMessage(value);
    appendJsonLine(join(this.stateRoot, "events", "messages.jsonl"), value);
    appendJsonLine(join(this.stateRoot, "rooms", `${safeName(value.room)}.jsonl`), value);
    this.event({
      teamId: value.teamId,
      jobId: value.jobId,
      host: value.host ?? "local",
      actor: value.from,
      type: `message.${value.type}`,
      data: { messageId: value.id, room: value.room, to: value.to, artifacts: value.artifacts },
    });
    return value;
  }

  deliverLocal(message: MafiaMessage): number {
    const recipients = new Set<string>();
    if (message.to?.startsWith("job-")) recipients.add(message.to);
    if (!message.to && message.teamId) {
      const statusPath = join(this.stateRoot, "teams", message.teamId, "status.json");
      if (existsSync(statusPath)) {
        const team = JSON.parse(readFileSync(statusPath, "utf8")) as { tasks?: Array<{ jobId?: string }> };
        for (const task of team.tasks ?? []) {
          if (task.jobId && task.jobId !== message.from) recipients.add(task.jobId);
        }
      }
    }
    const localRecipients = [...recipients].filter((jobId) => {
      const specPath = join(this.stateRoot, "jobs", jobId, "spec.json");
      if (existsSync(specPath)) {
        const spec = JSON.parse(readFileSync(specPath, "utf8")) as { host?: string };
        if (spec.host && spec.host !== "local") return false;
      }
      return true;
    });
    if (localRecipients.length !== recipients.size) return 0;
    for (const jobId of localRecipients) {
      appendJsonLine(join(this.stateRoot, "jobs", jobId, "inbox.jsonl"), message);
    }
    const delivered = localRecipients.length;
    if (delivered) this.store.markMessageDelivered(message.id, new Date().toISOString());
    return delivered;
  }

  deliverToLocalJob(message: MafiaMessage, jobId: string): void {
    appendJsonLine(join(this.stateRoot, "jobs", jobId, "inbox.jsonl"), message);
  }

  messages(options: { teamId?: string; room?: string; jobId?: string; limit?: number } = {}): MafiaMessage[] {
    return this.store.listMessages(options);
  }

  inbox(jobId: string, markRead = false): MafiaMessage[] {
    const path = join(this.stateRoot, "jobs", jobId, "inbox.jsonl");
    const messages = jsonLines<MafiaMessage>(path);
    if (markRead && messages.length) {
      const now = new Date().toISOString();
      for (const message of messages) this.store.markMessageRead(message.id, now);
      writeFileSync(path, "", { mode: 0o600 });
    }
    return messages;
  }

  control(jobId: string, action: string, data: Record<string, unknown> = {}): MafiaEvent {
    const value = this.event({
      jobId,
      host: "local",
      actor: "lead",
      type: `control.${action}`,
      data,
    });
    appendJsonLine(join(this.stateRoot, "jobs", jobId, "control.jsonl"), value);
    return value;
  }

  decision(input: Omit<DecisionRecord, "id" | "createdAt">): DecisionRecord {
    const value: DecisionRecord = { ...input, id: createId("decision"), createdAt: new Date().toISOString() };
    this.store.insertDecision(value);
    this.event({
      teamId: value.teamId,
      host: "local",
      actor: value.selectedBy,
      type: "decision.recorded",
      data: { decisionId: value.id, selected: value.selected, affectedTasks: value.affectedTasks },
    });
    return value;
  }

  decisions(teamId: string): DecisionRecord[] {
    return this.store.listDecisions(teamId);
  }

  usage(teamId?: string): UsageMetrics {
    return this.store.aggregateUsage(teamId);
  }

  checkpoint(value: TeamCheckpoint): void {
    this.store.insertCheckpoint(value);
    writeFileSync(
      join(this.stateRoot, "checkpoints", `${value.id}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
      { mode: 0o600 },
    );
    this.event({
      teamId: value.teamId,
      host: "local",
      actor: "lead",
      type: "checkpoint.created",
      data: { checkpointId: value.id, name: value.name },
    });
  }

  getCheckpoint(id: string): TeamCheckpoint | undefined {
    return this.store.getCheckpoint(id);
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
