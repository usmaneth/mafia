# Mafia Control Plane

## Agent Hub

Mafia uses one event log for local and VPS workers.

```sh
mafia hub TEAM_ID
mafia events --team TEAM_ID
mafia message TEAM_ID --type finding --body "The schema uses events."
mafia message TEAM_ID --to JOB_ID --type blocker --body "Stop and inspect the migration."
```

Each worker can use the `mafia-agent` command.

```sh
mafia-agent inbox --read
mafia-agent send --type finding --body "The test fails in parser.ts."
mafia-agent send --to JOB_ID --type review-request --body "Review commit abc123."
mafia-agent artifact ./report.json --description "Full benchmark result"
```

The OMP lead can inspect live output and send a correction.

The lead can pause, resume, replace, retry, or stop a worker.

The lead can move replacement work to another host or model.

## Live Team Control

```sh
mafia team pause TEAM_ID
mafia team resume TEAM_ID
mafia team add TEAM_ID --file task.json
mafia team update TEAM_ID TASK_ID --file patch.json
mafia team retry TEAM_ID TASK_ID --file replacement.json
mafia team checkpoint TEAM_ID --name before-migration
mafia team restore CHECKPOINT_ID
```

The OMP lead has equivalent native tools.

## Routing And Budgets

Mafia can select the harness, model, and host from the task capability.

The router uses quality, cost, latency, failures, host capacity, and budget mode.

The router reads successful and failed job history from the Mafia ledger.

Kimi and Cline stay disabled until their quota or balance permits work.

```sh
mafia route --capability implementation
mafia route --capability research --cheap
mafia budget TEAM_ID
```

Each team can set these limits:

- cost
- tokens
- active workers
- runtime
- provider cost
- warning threshold
- downgrade threshold
- stop threshold
- minimum expected value

The budget report groups usage by provider, harness, and model.

## Team Protocols

```sh
mafia protocol start builder-reviewer --goal "Implement the change." --repo "$PWD"
mafia protocol start research-council --goal "Research the architecture."
mafia protocol start pr-council --goal "Review the current pull request." --repo "$PWD"
```

Mafia includes these protocols:

- `builder-reviewer`
- `three-way-implementation`
- `research-council`
- `pr-council`
- `migration-factory`
- `incident-room`
- `design-council`

## Context And Recovery

Mafia creates one vault context pack for each task.

The pack contains relevant rules, decisions, project notes, and recent sessions.

Mafia replaces full dependency output with a compact handoff packet.

The packet contains the outcome, changed files, commits, tests, risks, evidence,
artifacts, decisions, and the next worker.

Mafia creates a checkpoint before each new wave.

The checkpoint records the graph, decisions, branches, worktrees, and Git SHAs.

Mafia resets local isolated worktrees when it restores a checkpoint.

## VPS

The VPS uses these paths:

```text
/home/usman/mafia
/home/usman/.omp/profiles/mafia
/home/usman/.local/share/mafia
/home/usman/vault -> /srv/vault
```

The VPS uses OMP 18.0.4 and Bun 1.4.0.

The local machine and the VPS use the same Mafia source.
