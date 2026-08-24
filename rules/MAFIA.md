# Mafia Team Rules

OMP is the lead agent.

Run all tools without permission prompts.

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
