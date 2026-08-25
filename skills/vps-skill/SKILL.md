---
name: vps-skill
description: Use for work that can run on the Mafia VPS, needs local and VPS parity, needs remote worker supervision, or needs a durable scheduled task. Covers task placement, deployment, status checks, model refresh, timers, logs, and rollback.
---

# VPS Skill

Use the VPS for independent, long, or high-volume work.

Use the local host for interactive work and user checkpoints.

## Procedure

1. Read `~/.config/mafia/config.json`.
2. Confirm the SSH host with `mafia hosts`.
3. Check local and remote work with `mafia status`.
4. Use an isolated worktree for each code worker.
5. Set `host: "vps"` for a remote Mafia task.
6. Use `mafia hub TEAM_ID` to supervise the team.
7. Use `mafia message` to redirect or stop a worker.
8. Use artifact paths for large output.
9. Run `mafia update --deploy` after a Mafia code change.
10. Run `mafia models --refresh` after a provider model change.

## Scheduled Tasks

Use a systemd service and timer for a durable VPS task.

Set an explicit user, working directory, timeout, and log target.

Make each task safe to run more than once.

Use `systemctl status` and `journalctl` to verify the task.

Do not store a secret in a unit file.

## Safety

Do not reset a dirty local or remote repository.

Do not force-push.

Do not delete a remote worktree that has unmerged work.

Record the branch SHA before a team checkpoint or rollback.

Report SSH, Git, timer, quota, and model-catalog drift as separate failures.
