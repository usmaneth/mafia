export const harnessNames = ["claude", "codex", "kimi", "cline", "opencode", "omp"] as const;
export type HarnessName = (typeof harnessNames)[number];

export const jobStates = [
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const;
export type JobState = (typeof jobStates)[number];

export interface HostConfig {
  name: string;
  kind: "local" | "ssh";
  target?: string;
  stateRoot: string;
  workerPath?: string;
  defaultUser?: string;
  harnessUsers?: Partial<Record<HarnessName, string>>;
  maxParallel?: number;
}

export interface MafiaConfig {
  version: number;
  defaultHost: string;
  defaultHarness: HarnessName;
  stateRoot: string;
  hosts: Record<string, HostConfig>;
  harnessModels?: Partial<Record<HarnessName, string>>;
  routing?: RoutingConfig;
  defaultBudget?: TeamBudget;
  vaultRoot?: string;
}

export interface JobSpec {
  id: string;
  title: string;
  prompt: string;
  harness: HarnessName;
  host: string;
  repo?: string;
  cwd?: string;
  model?: string;
  baseRef?: string;
  isolate: boolean;
  parentId?: string;
  pipelineId?: string;
  labels: string[];
  createdAt: string;
  stateRoot: string;
  timeoutSeconds: number;
  taskId?: string;
  contextPackPath?: string;
  budget?: TeamBudget;
}

export interface JobStatus extends JobSpec {
  state: JobState;
  pid?: number;
  worktree?: string;
  branch?: string;
  command?: string[];
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  result?: string;
  logPath: string;
  heartbeatAt?: string;
  pausedAt?: string;
  gitSummary?: string;
  usage?: UsageMetrics;
  packet?: HandoffPacket;
}

export interface PipelineTask {
  id: string;
  title?: string;
  prompt: string;
  harness?: HarnessName;
  host?: string;
  repo?: string;
  cwd?: string;
  model?: string;
  baseRef?: string;
  isolate?: boolean;
  dependsOn?: string[];
  labels?: string[];
  retries?: number;
  timeoutSeconds?: number;
  capability?: TaskCapability;
  preferredModels?: string[];
  expectedValue?: number;
}

export interface PipelineSpec {
  name: string;
  maxParallel?: number;
  tasks: PipelineTask[];
  budget?: TeamBudget;
  protocol?: TeamProtocolName;
}

export type TeamTaskState = "waiting" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";

export interface TeamTaskStatus extends PipelineTask {
  state: TeamTaskState;
  jobId?: string;
  error?: string;
  attempts: number;
}

export interface TeamStatus {
  id: string;
  name: string;
  goal: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  maxParallel: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  tasks: TeamTaskStatus[];
  paused?: boolean;
  budget?: TeamBudget;
  usage?: UsageMetrics;
  protocol?: TeamProtocolName;
  checkpointId?: string;
  budgetMode?: "normal" | "warning" | "downgrade" | "stop";
}

export const messageTypes = [
  "message",
  "need-help",
  "finding",
  "blocker",
  "review-request",
  "handoff",
] as const;
export type MessageType = (typeof messageTypes)[number];

export interface ArtifactRef {
  path: string;
  kind?: string;
  sha256?: string;
  description?: string;
}

export interface MafiaMessage {
  id: string;
  teamId?: string;
  room: string;
  from: string;
  to?: string;
  type: MessageType;
  body: string;
  artifacts: ArtifactRef[];
  createdAt: string;
  deliveredAt?: string;
  readAt?: string;
  host?: string;
  jobId?: string;
}

export interface MafiaEvent {
  id: string;
  teamId?: string;
  jobId?: string;
  host: string;
  actor: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface DecisionRecord {
  id: string;
  teamId: string;
  question: string;
  recommendation?: string;
  alternatives: string[];
  selected: string;
  selectedBy: string;
  affectedTasks: string[];
  createdAt: string;
}

export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requests: number;
  failures: number;
  runtimeSeconds: number;
  ttftMs?: number;
}

export interface TeamBudget {
  maxCostUsd?: number;
  maxTokens?: number;
  maxWorkers?: number;
  maxRuntimeSeconds?: number;
  warningPercent?: number;
  providerCostUsd?: Record<string, number>;
  downgradeAtPercent?: number;
  stopAtPercent?: number;
  minExpectedValue?: number;
}

export type TaskCapability =
  | "architecture"
  | "implementation"
  | "research"
  | "review"
  | "security"
  | "testing"
  | "synthesis"
  | "general";

export interface RoutingCandidate {
  harness: HarnessName;
  model?: string;
  host: string;
  capabilities: TaskCapability[];
  enabled: boolean;
  costWeight: number;
  quality: number;
  latency: number;
  contextTokens?: number;
  provider?: string;
}

export interface RoutingConfig {
  candidates: RoutingCandidate[];
  fallbackOrder?: HarnessName[];
}

export interface RouteDecision {
  harness: HarnessName;
  model?: string;
  host: string;
  score: number;
  reasons: string[];
}

export interface HandoffPacket {
  outcome: string;
  changedFiles: string[];
  commits: string[];
  tests: string[];
  unresolvedRisks: string[];
  evidence: ArtifactRef[];
  recommendedNextWorker?: string;
  artifacts: ArtifactRef[];
  decisions: string[];
}

export interface TeamCheckpoint {
  id: string;
  teamId: string;
  name: string;
  createdAt: string;
  team: TeamStatus;
  branches: Array<{ taskId: string; jobId?: string; branch?: string; worktree?: string; sha?: string }>;
  decisionIds: string[];
}

export const teamProtocolNames = [
  "builder-reviewer",
  "three-way-implementation",
  "research-council",
  "pr-council",
  "migration-factory",
  "incident-room",
  "design-council",
] as const;
export type TeamProtocolName = (typeof teamProtocolNames)[number];
