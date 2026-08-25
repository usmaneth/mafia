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
  workspaceSource?: string;
  workspacePatchPath?: string;
  workspaceArchivePath?: string;
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
  allowFallback?: boolean;
  fallbackRoutes?: RouteTarget[];
  expectedValue?: number;
}

export interface PipelineSpec {
  name: string;
  maxParallel?: number;
  minParallel?: number;
  autoScale?: boolean;
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
  currentParallel?: number;
  minParallel?: number;
  autoScale?: boolean;
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

export interface ModelRecord {
  harness: HarnessName;
  provider: string;
  id: string;
  selector: string;
  name: string;
  source: HarnessName;
  available: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  aliases?: string[];
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ModelCatalogSource {
  harness: HarnessName;
  status: "ok" | "error";
  count: number;
  error?: string;
}

export interface ModelCatalog {
  generatedAt: string;
  models: ModelRecord[];
  sources: ModelCatalogSource[];
}

export interface ScaleInput {
  taskCount: number;
  readyCount?: number;
  running?: number;
  completed?: number;
  failures?: number;
  hostCapacity?: number;
  budgetWorkers?: number;
  minParallel?: number;
  maxParallel?: number;
  risk?: "low" | "medium" | "high";
}

export interface ScaleDecision {
  recommendedParallel: number;
  ceiling: number;
  reasons: string[];
}

export interface VpsProcess {
  pid: number;
  user: string;
  state: string;
  ageSeconds: number;
  cpuPercent: number;
  memoryPercent: number;
  command: string;
}

export interface VpsUnit {
  name: string;
  active: string;
  sub: string;
  description: string;
  result?: string;
  execStatus?: number;
}

export interface VpsTimer {
  name: string;
  next?: string;
  last?: string;
  activates?: string;
}

export interface VpsJobSummary {
  id: string;
  title: string;
  state: JobState;
  harness: HarnessName;
  model?: string;
  updatedAt: string;
  error?: string;
}

export interface VpsDeployment {
  repoPath: string;
  branch?: string;
  sha?: string;
  originSha?: string;
  dirty: boolean;
  dirtyFiles: number;
}

export interface VpsTelemetry {
  generatedAt: string;
  host: string;
  reachable: boolean;
  latencyMs: number;
  error?: string;
  uptimeSeconds?: number;
  load?: [number, number, number];
  memory?: { usedBytes: number; totalBytes: number; swapUsedBytes: number; swapTotalBytes: number };
  disk?: { usedBytes: number; totalBytes: number; percent: number };
  deployment?: VpsDeployment;
  jobs: {
    total: number;
    running: number;
    failed: number;
    lost: number;
    byHarness: Record<string, number>;
    recent: VpsJobSummary[];
  };
  models: {
    total: number;
    generatedAt?: string;
    sources: Array<{ harness: string; status: string; count: number; error?: string }>;
    fallbackOrder: HarnessName[];
  };
  units: VpsUnit[];
  timers: VpsTimer[];
  processes: VpsProcess[];
}

export type PrOperationalState =
  | "needs-you"
  | "fixing"
  | "conflict"
  | "ci-failing"
  | "ci-pending"
  | "ready"
  | "queued"
  | "awaiting-review"
  | "watching";

export interface PrStatus {
  repo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  headSha: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  checks: string;
  unresolvedThreads: number;
  botThreads: number;
  sweeps: number;
  autoMerge: boolean;
  state: PrOperationalState;
}

export interface PrAutomationUnit {
  name: string;
  active: string;
  sub: string;
  result?: string;
  lastRun?: string;
}

export interface PrTelemetry {
  generatedAt: string;
  reachable: boolean;
  latencyMs: number;
  error?: string;
  totals: Record<PrOperationalState | "open", number>;
  units: PrAutomationUnit[];
  prs: PrStatus[];
}

export interface RoutingConfig {
  candidates: RoutingCandidate[];
  fallbackOrder?: HarnessName[];
}

export interface RouteTarget {
  harness: HarnessName;
  model?: string;
  host: string;
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
