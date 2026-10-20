#!/usr/bin/env bash
# Puts the workspace's Node major (.nvmrc) first on PATH for agent shells.
# Claude Code runs this as a SessionStart hook and sources $CLAUDE_ENV_FILE
# before every Bash command; elsewhere, `eval "$(scripts/agent-node-env.sh)"`.
# It never changes the machine-wide default Node, which other sessions share.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
major="$(tr -dc '0-9' < "$root/.nvmrc")"

current="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[ "$current" = "$major" ] && exit 0

# Newest installed patch of that major from n, nvm, or Homebrew.
bin="$(
  for candidate in \
    "${N_PREFIX:-$HOME/n}"/n/versions/node/"$major".*/bin \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/v"$major".*/bin \
    /opt/homebrew/opt/node@"$major"/bin \
    /usr/local/opt/node@"$major"/bin; do
    if [ -x "$candidate/node" ]; then echo "$candidate"; fi
  done | sort -V | tail -1
)"

if [ -z "$bin" ]; then
  echo "[agent-node-env] No Node $major found (current: ${current:-none}); install one, e.g. 'n install $major'." >&2
  exit 0
fi

line="export PATH=\"$bin:\$PATH\""
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "$line" >> "$CLAUDE_ENV_FILE"
else
  echo "$line"
fi
