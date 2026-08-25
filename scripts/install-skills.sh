#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_root/skills/vps-skill"

install_link() {
  local root="$1"
  mkdir -p "$root"
  rm -rf "$root/vps-skill"
  ln -s "$source_dir" "$root/vps-skill"
}

install_link "$HOME/.codex/skills"
install_link "$HOME/.claude/skills"
install_link "$HOME/.agents/skills"
install_link "$HOME/.cline/skills"
install_link "$HOME/.config/opencode/skills"

echo "installed vps-skill for Codex, Claude, shared agents, Cline, OpenCode, and Mafia OMP"
