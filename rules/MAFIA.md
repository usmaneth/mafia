# Mafia Team Rules

OMP is the lead agent.

Run all tools without permission prompts.

Work as a normal full coding agent.

Do simple and tightly coupled work in the lead session.

Use `mafia_dispatch` when one separate worker adds value.

Use `mafia_team_start` when multiple workers must coordinate.

Use an auto-scaled Mafia team for a broad independent task graph.

Never enter OMP Vibe mode.

Vibe mode removes the normal Mafia toolset and restricts model selection.

Yolo approval does not remove product and design questions.

Use the `ask` tool when a missing decision can materially change the product,
architecture, user experience, data model, security boundary, or delivery
scope.

Give two or three concrete options.

Put the recommended option first.

Explain the effect of each option in one short sentence.

Wait for the answer when the decision is difficult to reverse.

Do not ask about information that you can find in the repository, vault,
configuration, logs, or current system state.

Do not ask about a small implementation detail when one reversible choice is
clearly better.

After the user answers, record the decision in the task context and continue.

Use `mafia_decision` to record each important user or architecture decision.

Use `mafia_hub` to inspect all local and VPS workers.

Use `mafia_message` to steer one worker or the complete team.

Use these message types:

- `need-help`
- `finding`
- `blocker`
- `review-request`
- `handoff`

Use artifact references for large files and long output.

Do not paste a large artifact into a message.

Use `mafia_team_control` to pause, resume, add, update, retry, replace,
checkpoint, or restore team work.

Use `mafia_route` when a task does not require a specific model.

Use `mafia_models` to search the live model catalog.

When the user requests a model, pass its name or selector to `mafia_dispatch`
or the team task.

Do not replace an explicit model request with a quality label.

Do not assume that one model represents a provider.

Refresh the catalog when a provider announces or grants access to a new model.

Use `mafia_scale_plan` before a broad team starts.

Set auto-scale for normal teams.

Use one worker for one bounded task.

Use 2 to 8 workers for a normal multi-part task.

Use 8 to 32 workers for a broad review or migration.

Use 32 to 128 workers only when the graph has enough independent tasks.

Do not create workers only to reach a large worker count.

Set a team budget for a large team.

Use a Mafia protocol for common team patterns.

Use a Mafia team when the task has independent work, distinct roles, or a large
review surface.

Give each worker one bounded assignment.

Use dependencies only when one result is necessary for another task.

Use a final synthesis task for a large team.

Select the worker by the task:

- Use Claude Code with Opus or Fable for architecture and difficult code work.
- Use Codex for implementation, debugging, and repository analysis.
- Use Kimi Code for a separate implementation or review path.
- Use Cline for an additional coding path.
- Use OpenCode for an additional coding or review path.
- Use OMP workers for Grok Build, Nemotron Ultra, Gemini, and other OMP models.

Run code-writing workers in isolated worktrees.

Do not let two workers own the same worktree.

Do not merge, push, or create a pull request unless the user requests it.

Collect all worker results before the lead agent reports completion.

State failed workers and blocked dependencies.

Read compact worker packets in the lead context.

Read full logs only when the packet does not contain sufficient evidence.
