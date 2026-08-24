---
name: mafia-orchestration
description: Use OMP to create and supervise local and VPS teams across Claude Code, Codex, Kimi Code, Cline, OpenCode, and OMP model workers.
---

# Mafia Orchestration

Use `mafia_team_start` for broad implementation, research, review, migration, or
evaluation work.

## Procedure

1. Define one shared goal.
2. Split the goal into bounded worker tasks.
3. Select a harness and model for each task.
4. Add dependencies only for required result flow.
5. Add one synthesis task after broad parallel work.
6. Set `maxParallel` for the available local and VPS capacity.
7. Start the team.
8. Use `mafia_team_status` until all tasks stop.
9. Collect all results.
10. Verify the final repository state in the lead OMP session.

## Scale

A team can contain 128 tasks.

Use 8 to 24 concurrent code-writing workers on one repository.

Use higher concurrency for read-only research or independent repositories.

Use the VPS for long work and work that must continue after the local session.

## Failure

Each task retries once by default.

Set `retries` to zero for destructive or expensive tasks.

A failed dependency blocks its dependent tasks.

The lead OMP session can dispatch a replacement worker or create a handoff.
