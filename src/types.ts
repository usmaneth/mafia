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
  version: 1;
  defaultHost: string;
  defaultHarness: HarnessName;
  stateRoot: string;
  hosts: Record<string, HostConfig>;
  harnessModels?: Partial<Record<HarnessName, string>>;
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
}

export interface PipelineSpec {
  name: string;
  maxParallel?: number;
  tasks: PipelineTask[];
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
}
