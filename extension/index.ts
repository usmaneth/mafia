import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { formatJobs, formatTeam, formatTeams } from "../src/format";
import { MafiaService } from "../src/service";
import { TeamService } from "../src/team";

export default function mafiaExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "mafia_team_start",
    label: "Start Mafia Team",
    description:
      "Create a supervised team of up to 128 real coding agents. Use explicit roles and dependencies. " +
      "Workers can use Claude Code, Codex, Kimi Code, Cline, OpenCode, or an OMP model such as Grok Build or Nemotron Ultra.",
    parameters: z.object({
      name: z.string().describe("Short team name."),
      goal: z.string().describe("The shared outcome for the complete team."),
      maxParallel: z.number().int().min(1).max(128).default(16),
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
      })).min(1).max(128),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as any;
      const team = new TeamService().create(params.goal, {
        name: params.name,
        maxParallel: params.maxParallel,
        tasks: params.tasks,
      });
      return {
        content: [{ type: "text", text: `${formatTeam(team)}\n\nUse mafia_team_status to supervise this team.` }],
        details: { id: team.id, state: team.state, taskCount: team.tasks.length },
      };
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
    const active = new MafiaService().list(200).filter((job) => ["queued", "starting", "running"].includes(job.state));
    if (active.length) ctx.ui.setStatus("mafia", `Mafia ${active.length} active`);
  });
}
