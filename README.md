# Mafia

Mafia is the team orchestration layer for the OMP `mafia` profile.

OMP remains the main interface. Mafia does not replace the OMP session, model
system, tools, providers, or subagents.

Mafia adds these functions:

- Start every lead session with OMP yolo approval.
- Keep the OMP ask tool active for important design decisions.
- Start up to 128 supervised workers in one team.
- Run Claude Code, Codex, Kimi Code, Cline, OpenCode, and OMP model workers.
- Run work on this machine or an SSH host.
- Create one Git worktree for each code task.
- Track jobs, teams, logs, retries, dependencies, and handoffs.
- Collect worker results in the lead OMP session.

## Main Commands

Start the OMP profile:

```sh
mafia
```

Show all work:

```sh
mafia jobs
mafia team list
mafia watch
```

Run deterministic checks:

```sh
mafia eval
```

Run the local and VPS smoke team:

```sh
mafia eval --live
```

Start one worker:

```sh
mafia dispatch \
  --harness claude \
  --model opus \
  --repo /path/to/repo \
  --prompt "Fix the failing test and report the result."
```

Start a team:

```sh
mafia team start --file examples/review-team.json
```

Use `/mafia` inside OMP to show teams and workers.

## Worker Selection

Use `claude` with the `opus` or `fable` model.

Use `kimi` for Kimi Code.

Use `cline` for Cline.

Use `codex` for Codex.

Use `opencode` for OpenCode.

Use `omp` for models configured in OMP. Examples include Grok Build,
Nemotron Ultra, Gemini, and the local Qwen 3.8 model.

Use this selector for the local model:

```text
ollama/qwen3.8-27b-obliterated:q4_k_m
```

Import the tracked GGUF configuration with:

```sh
ollama create qwen3.8-27b-obliterated:q4_k_m \
  --file models/qwen3.8-27b-obliterated.Modelfile
```

## Safety

Mafia uses yolo mode for worker harnesses.

Mafia also starts the lead OMP session with yolo approval.

Yolo removes tool permission prompts.

Yolo does not remove product and design questions.

The lead uses the ask tool when a decision can materially change the product,
architecture, user experience, data model, security boundary, or scope.

Mafia creates a separate Git worktree when a task has a repository.

Mafia does not merge, push, or create a pull request by default.

The task must state each delivery action.

## State

Mafia stores local state in `~/.local/share/mafia/`.

The SQLite file is `~/.local/share/mafia/mafia.db`.

Each job has a status file and an output log.

Remote hosts use the state path in `~/.config/mafia/config.json`.
