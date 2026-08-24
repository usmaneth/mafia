# Mafia Team Rules

OMP is the lead agent.

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
