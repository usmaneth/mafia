import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { formatHub, formatJobs, formatMessages, formatTeam, formatTeams, formatVpsTelemetry } from "../src/format";
import { protocolSpec } from "../src/protocols";
import { routeTask } from "../src/router";
import { loadConfig, repoRoot } from "../src/config";
import { MafiaService } from "../src/service";
import { TeamService } from "../src/team";
import { catalogCandidates, filterCatalog, ModelCatalogService } from "../src/models";
import { recommendParallelism } from "../src/scale";
import { readVpsTelemetry, refreshVpsTelemetry } from "../src/telemetry";

export default function mafiaExtension(pi: ExtensionAPI) {
  const z = pi.zod;
  const designCheckpointPrompt = `
MAFIA DESIGN CHECKPOINT POLICY:
- This session uses yolo tool approval. Execute read, write, and command tools without permission prompts.
- Yolo approval does not authorize the agent to guess important product or design decisions.
- Use the ask tool when an unresolved choice can materially change the product, architecture, user experience, data model, security boundary, or delivery scope.
- Give two or three concrete options. Put the recommended option first. State the effect of each option in one short sentence.
- Wait for the user's answer when the decision is difficult to reverse.
- Do not ask for facts that can be found in the repository, vault, configuration, logs, or current system state.
- Do not ask about a small implementation detail when one reversible choice is clearly better.
`;

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: [...event.systemPrompt, designCheckpointPrompt],
  }));

  pi.registerTool({
    name: "mafia_team_start",
    label: "Start Mafia Team",
    description:
      "Create a supervised team of up to 128 real coding agents. Use explicit roles and dependencies. " +
      "Workers can use Claude Code, Codex, Kimi Code, Cline, OpenCode, or an OMP model such as Grok Build or Nemotron Ultra.",
    parameters: z.object({
      name: z.string().describe("Short team name."),
      goal: z.string().describe("The shared outcome for the complete team."),
      maxParallel: z.number().int().min(1).max(128).optional().default(128),
      minParallel: z.number().int().min(1).max(128).optional().default(1),
      autoScale: z.boolean().optional().default(true),
      tasks: z.array(z.object({
        id: z.string().describe("Stable task ID."),
        title: z.string().optional(),
        prompt: z.string().describe("One bounded worker assignment."),
        harness: z.enum(["claude", "codex", "kimi", "cline", "opencode", "omp"]).optional(),
        host: z.string().optional().describe("Configured host, such as local or vps."),
        repo: z.string().optional().describe("Repository path on the selected host."),
        cwd: z.string().optional(),
        model: z.string().optional().describe("Harness model. Use OMP provider/model IDs for OMP workers."),
        baseRef: z.string().optional(),
        isolate: z.boolean().optional().default(true),
        dependsOn: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        retries: z.number().int().min(0).max(5).optional().default(1),
        timeoutSeconds: z.number().int().min(30).max(86400).optional().default(3600),
        capability: z.enum(["architecture", "implementation", "research", "review", "security", "testing", "synthesis", "general"]).optional(),
        preferredModels: z.array(z.string()).optional(),
        expectedValue: z.number().min(0).max(1).optional(),
      })).min(1).max(128),
      budget: z.object({
        maxCostUsd: z.number().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        maxWorkers: z.number().int().min(1).max(128).optional(),
        maxRuntimeSeconds: z.number().int().positive().optional(),
        warningPercent: z.number().min(1).max(100).optional(),
        downgradeAtPercent: z.number().min(1).max(100).optional(),
        stopAtPercent: z.number().min(1).max(100).optional(),
        providerCostUsd: z.record(z.string(), z.number().positive()).optional(),
        minExpectedValue: z.number().min(0).max(1).optional(),
      }).optional(),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const team = new TeamService().create(params.goal, {
        name: params.name,
        maxParallel: params.maxParallel,
        minParallel: params.minParallel,
        autoScale: params.autoScale,
        tasks: params.tasks,
        budget: params.budget,
      });
      return {
        content: [{ type: "text", text: `${formatTeam(team)}\n\nUse mafia_team_status to supervise this team.` }],
        details: { id: team.id, state: team.state, taskCount: team.tasks.length },
      };
    },
  });

  pi.registerTool({
    name: "mafia_hub",
    label: "Mafia Agent Hub",
    description: "Show one live control view for all local and VPS workers, models, states, and messages.",
    parameters: z.object({ teamId: z.string() }),
    async execute(_toolCallId, rawParams) {
      const { teamId } = rawParams as any;
      const mafia = new MafiaService();
      const team = new TeamService().get(teamId);
      const messages = mafia.control.messages({ teamId, limit: 30 });
      return {
        content: [{ type: "text", text: formatHub(team, mafia.list(500), messages) }],
        details: { team, messages },
      };
    },
  });

  pi.registerTool({
    name: "mafia_message",
    label: "Message Mafia Team",
    description: "Send a direct or broadcast message to workers. Use typed findings, blockers, help, reviews, and handoffs.",
    parameters: z.object({
      teamId: z.string(),
      to: z.string().optional().describe("Target job ID. Omit this value for a team broadcast."),
      type: z.enum(["message", "need-help", "finding", "blocker", "review-request", "handoff"]).optional().default("message"),
      body: z.string(),
      artifacts: z.array(z.object({
        path: z.string(),
        kind: z.string().optional(),
        sha256: z.string().optional(),
        description: z.string().optional(),
      })).optional(),
    }),
    async execute(_toolCallId, rawParams) {
      const message = new MafiaService().sendMessage({ ...(rawParams as any), from: "omp-lead" });
      return {
        content: [{ type: "text", text: `Sent ${message.type} ${message.id}${message.to ? ` to ${message.to}` : " to the team"}.` }],
        details: message,
      };
    },
  });

  pi.registerTool({
    name: "mafia_team_control",
    label: "Control Mafia Team",
    description: "Pause, resume, add, update, retry, replace, checkpoint, or restore live Mafia work.",
    parameters: z.object({
      action: z.enum(["pause", "resume", "add", "update", "retry", "replace", "checkpoint", "restore"]),
      teamId: z.string().optional(),
      taskId: z.string().optional(),
      checkpointId: z.string().optional(),
      name: z.string().optional(),
      task: z.any().optional(),
      patch: z.any().optional(),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const teams = new TeamService();
      let value: unknown;
      if (params.action === "pause") value = teams.pause(params.teamId);
      else if (params.action === "resume") value = teams.resume(params.teamId);
      else if (params.action === "add") value = teams.addTask(params.teamId, params.task);
      else if (params.action === "update") value = teams.updateTask(params.teamId, params.taskId, params.patch);
      else if (params.action === "retry" || params.action === "replace") {
        value = teams.retryTask(params.teamId, params.taskId, params.patch);
      } else if (params.action === "checkpoint") {
        value = teams.checkpoint(params.teamId, params.name);
      } else {
        value = teams.restore(params.checkpointId);
      }
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value as any };
    },
  });

  pi.registerTool({
    name: "mafia_decision",
    label: "Record Mafia Decision",
    description: "Record one user or architecture decision and inject it into all affected worker context packs.",
    parameters: z.object({
      teamId: z.string(),
      question: z.string(),
      recommendation: z.string().optional(),
      alternatives: z.array(z.string()).optional(),
      selected: z.string(),
      selectedBy: z.string().optional().default("Usman"),
      affectedTasks: z.array(z.string()).optional(),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const value = new TeamService().recordDecision(params.teamId, {
        question: params.question,
        recommendation: params.recommendation,
        alternatives: params.alternatives ?? [],
        selected: params.selected,
        selectedBy: params.selectedBy,
        affectedTasks: params.affectedTasks ?? [],
      });
      return { content: [{ type: "text", text: `Recorded ${value.id}: ${value.selected}` }], details: value };
    },
  });

  pi.registerTool({
    name: "mafia_route",
    label: "Route Mafia Task",
    description: "Select a harness, model, and host from task capability, observed reliability, and budget mode.",
    parameters: z.object({
      capability: z.enum(["architecture", "implementation", "research", "review", "security", "testing", "synthesis", "general"]),
      host: z.string().optional(),
      preferredModels: z.array(z.string()).optional(),
      cheap: z.boolean().optional().default(false),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const config = loadConfig();
      const value = routeTask(config, {
        capability: params.capability,
        host: params.host,
        preferredModels: params.preferredModels,
        downgrade: params.cheap,
      }, new Map(), catalogCandidates(new ModelCatalogService(config.stateRoot).discover(), Object.keys(config.hosts)));
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });

  pi.registerTool({
    name: "mafia_models",
    label: "Mafia Model Catalog",
    description: "Search every model currently exposed by the configured provider harnesses.",
    parameters: z.object({
      harness: z.enum(["claude", "codex", "kimi", "cline", "opencode", "omp"]).optional(),
      provider: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(2000).optional().default(50),
      refresh: z.boolean().optional().default(false),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const config = loadConfig();
      const catalog = new ModelCatalogService(config.stateRoot).discover(params.refresh);
      const value = filterCatalog(catalog, params);
      return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        details: { generatedAt: catalog.generatedAt, total: catalog.models.length, matches: value.models.length, sources: catalog.sources },
      };
    },
  });

  pi.registerTool({
    name: "mafia_scale_plan",
    label: "Plan Mafia Scale",
    description: "Calculate justified team concurrency from the task graph, host capacity, failures, risk, and budget.",
    parameters: z.object({
      taskCount: z.number().int().min(1).max(128),
      readyCount: z.number().int().min(0).max(128).optional(),
      completed: z.number().int().min(0).max(128).optional(),
      failures: z.number().int().min(0).max(128).optional(),
      risk: z.enum(["low", "medium", "high"]).optional(),
      maxParallel: z.number().int().min(1).max(128).optional(),
    }),
    async execute(_toolCallId, rawParams) {
      const value = recommendParallelism(rawParams as any);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });

  pi.registerTool({
    name: "mafia_protocol_start",
    label: "Start Mafia Protocol",
    description: "Start a reusable adversarial team protocol.",
    parameters: z.object({
      protocol: z.enum([
        "builder-reviewer", "three-way-implementation", "research-council", "pr-council",
        "migration-factory", "incident-room", "design-council",
      ]),
      goal: z.string(),
      repo: z.string().optional(),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const spec = protocolSpec(params.protocol, params.goal, params.repo);
      const team = new TeamService().create(params.goal, spec);
      return { content: [{ type: "text", text: formatTeam(team) }], details: team };
    },
  });

  pi.registerTool({
    name: "mafia_team_status",
    label: "Mafia Team Status",
    description: "Inspect a Mafia team. Set collect to include all completed worker results.",
    parameters: z.object({
      teamId: z.string(),
      collect: z.boolean().optional().default(false),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const teams = new TeamService();
      const team = teams.get(params.teamId);
      const text = params.collect ? teams.collect(params.teamId) : formatTeam(team);
      return {
        content: [{ type: "text", text }],
        details: {
          id: team.id,
          state: team.state,
          tasks: team.tasks.map((task) => ({ id: task.id, state: task.state, jobId: task.jobId })),
        },
      };
    },
  });

  pi.registerTool({
    name: "mafia_dispatch",
    label: "Dispatch Mafia Worker",
    description: "Dispatch one real harness worker for a focused assignment.",
    parameters: z.object({
      prompt: z.string(),
      title: z.string().optional(),
      harness: z.enum(["claude", "codex", "kimi", "cline", "opencode", "omp"]),
      host: z.string().optional().default("local"),
      repo: z.string().optional(),
      cwd: z.string().optional(),
      model: z.string().optional(),
      baseRef: z.string().optional(),
      isolate: z.boolean().optional().default(true),
      timeoutSeconds: z.number().int().min(30).max(86400).optional().default(3600),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const job = new MafiaService().dispatch(params);
      return {
        content: [{ type: "text", text: `Started ${job.id}: ${job.harness}@${job.host} (${job.state})` }],
        details: { id: job.id, state: job.state, harness: job.harness, host: job.host },
      };
    },
  });

  pi.registerTool({
    name: "mafia_jobs",
    label: "Mafia Jobs",
    description: "Show current local and VPS Mafia workers.",
    parameters: z.object({ limit: z.number().int().min(1).max(200).optional().default(50) }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const jobs = new MafiaService().list(params.limit);
      return {
        content: [{ type: "text", text: formatJobs(jobs) }],
        details: jobs.map((job) => ({
          id: job.id,
          state: job.state,
          harness: job.harness,
          host: job.host,
          title: job.title,
        })),
      };
    },
  });

  pi.registerTool({
    name: "mafia_vps_status",
    label: "Mafia VPS Status",
    description: "Show VPS workers, processes, watchdogs, resources, model providers, and fallback order.",
    parameters: z.object({
      refresh: z.boolean().optional().default(false),
      allProcesses: z.boolean().optional().default(false),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const value = params.refresh
        ? refreshVpsTelemetry(true)
        : readVpsTelemetry() ?? refreshVpsTelemetry(true);
      return {
        content: [{ type: "text", text: formatVpsTelemetry(value, { allProcesses: params.allProcesses }) }],
        details: value,
      };
    },
  });

  pi.registerTool({
    name: "mafia_job_logs",
    label: "Mafia Job Logs",
    description: "Read the latest output from one local or VPS worker.",
    parameters: z.object({
      jobId: z.string(),
      lines: z.number().int().min(1).max(1000).optional().default(100),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const text = new MafiaService().logs(params.jobId, params.lines);
      return { content: [{ type: "text", text }], details: { jobId: params.jobId } };
    },
  });

  pi.registerTool({
    name: "mafia_handoff",
    label: "Handoff Mafia Job",
    description: "Continue one worker result with a new harness or on a new host.",
    parameters: z.object({
      jobId: z.string(),
      harness: z.enum(["claude", "codex", "kimi", "cline", "opencode", "omp"]),
      host: z.string().optional(),
      prompt: z.string().optional(),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const job = new MafiaService().handoff(params.jobId, params.harness, params.host, params.prompt);
      return {
        content: [{ type: "text", text: `Started handoff ${job.id}: ${job.harness}@${job.host}` }],
        details: { id: job.id, parentId: job.parentId, state: job.state },
      };
    },
  });

  pi.registerTool({
    name: "mafia_compare",
    label: "Compare Mafia Branches",
    description: "Compare two Mafia worker branches on the same host.",
    parameters: z.object({
      leftJobId: z.string(),
      rightJobId: z.string(),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const text = new MafiaService().compare(params.leftJobId, params.rightJobId);
      return { content: [{ type: "text", text }], details: params };
    },
  });

  pi.registerTool({
    name: "mafia_cancel",
    label: "Cancel Mafia Work",
    description: "Cancel one Mafia job or one complete Mafia team.",
    parameters: z.object({
      jobId: z.string().optional(),
      teamId: z.string().optional(),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      if (params.teamId) {
        const team = new TeamService().cancel(params.teamId);
        return {
          content: [{ type: "text", text: `Cancelled team ${team.id}.` }],
          details: { id: team.id, state: team.state } as Record<string, unknown>,
        };
      }
      if (params.jobId) {
        new MafiaService().cancel(params.jobId);
        return {
          content: [{ type: "text", text: `Sent the cancel signal to ${params.jobId}.` }],
          details: { id: params.jobId, state: "cancel_requested" } as Record<string, unknown>,
        };
      }
      throw new Error("Set jobId or teamId.");
    },
  });

  pi.registerTool({
    name: "mafia_team_wait",
    label: "Wait For Mafia Team",
    description: "Wait for a Mafia team to stop, then collect all worker results.",
    parameters: z.object({
      teamId: z.string(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional().default(600),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const teams = new TeamService();
      const deadline = Date.now() + params.timeoutSeconds * 1000;
      let team = teams.get(params.teamId);
      while (team.state === "queued" || team.state === "running") {
        if (Date.now() >= deadline) {
          return {
            content: [{ type: "text", text: `${formatTeam(team)}\n\nThe wait timed out. The team still runs.` }],
            details: { id: team.id, state: team.state, timedOut: true } as Record<string, unknown>,
          };
        }
        await Bun.sleep(2000);
        team = teams.get(params.teamId);
      }
      return {
        content: [{ type: "text", text: teams.collect(team.id) }],
        details: { id: team.id, state: team.state, timedOut: false } as Record<string, unknown>,
      };
    },
  });

  pi.registerCommand("mafia", {
    description: "Show Mafia teams and workers",
    handler: async (args, ctx) => {
      try {
        const text = args.trim();
        if (text.startsWith("team ")) {
          ctx.ui.notify(formatTeam(new TeamService().get(text.slice(5).trim())), "info");
        } else if (text.startsWith("hub ")) {
          const teamId = text.slice(4).trim();
          const mafia = new MafiaService();
          const team = new TeamService().get(teamId);
          ctx.ui.notify(formatHub(team, mafia.list(500), mafia.control.messages({ teamId, limit: 20 })), "info");
        } else if (text.startsWith("messages ")) {
          const teamId = text.slice(9).trim();
          ctx.ui.notify(formatMessages(new MafiaService().control.messages({ teamId, limit: 30 })), "info");
        } else if (text === "vps" || text.startsWith("vps ")) {
          const value = readVpsTelemetry() ?? refreshVpsTelemetry(true);
          ctx.ui.notify(formatVpsTelemetry(value, { allProcesses: text.includes("--all") }), "info");
        } else {
          const teams = formatTeams(new TeamService().list(10));
          const jobs = formatJobs(new MafiaService().list(20));
          ctx.ui.notify(`${teams}\n\n${jobs}`, "info");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const mafia = new MafiaService();
    const teamService = new TeamService();
    let collectorRunning = false;
    let lastStatus = "";
    let lastHub = "";
    let lastVps = "";
    const collectVps = () => {
      if (collectorRunning) return;
      collectorRunning = true;
      const child = spawn(process.execPath, [join(repoRoot, "src", "cli.ts"), "__vps-refresh", "--force"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      child.once("exit", () => {
        collectorRunning = false;
      });
      child.once("error", () => {
        collectorRunning = false;
      });
    };
    const refresh = () => {
      try {
        const active = mafia.reconcileLocal().filter((job) => ["queued", "starting", "running"].includes(job.state));
        const teams = teamService.list(10);
        const status = active.length ? `Mafia ${active.length} active` : "Mafia idle";
        if (status !== lastStatus) {
          ctx.ui.setStatus("mafia", status);
          lastStatus = status;
        }
        const team = teams.find((item) => item.state === "running");
        if (team) {
          const jobs = mafia.listCached(500);
          const lines = formatHub(team, jobs, mafia.control.messages({ teamId: team.id, limit: 5 }))
            .split("\n")
            .slice(0, 14);
          const hub = lines.join("\n");
          if (hub !== lastHub) {
            ctx.ui.setWidget("mafia-hub", lines);
            lastHub = hub;
          }
        } else if (lastHub) {
          ctx.ui.setWidget("mafia-hub", undefined);
          lastHub = "";
        }
        const telemetry = readVpsTelemetry(mafia.config.stateRoot);
        if (telemetry) {
          const lines = formatVpsTelemetry(telemetry, { compact: true }).split("\n").slice(0, 12);
          const vps = lines.join("\n");
          if (vps !== lastVps) {
            ctx.ui.setWidget("mafia-vps", lines);
            lastVps = vps;
          }
        } else if (!lastVps) {
          const message = "VPS - telemetry starts in the background";
          ctx.ui.setWidget("mafia-vps", [message]);
          lastVps = message;
        }
      } catch {}
    };
    collectVps();
    refresh();
    const renderTimer = setInterval(refresh, 2000);
    const collectorTimer = setInterval(collectVps, 20_000);
    renderTimer.unref();
    collectorTimer.unref();
  });
}
