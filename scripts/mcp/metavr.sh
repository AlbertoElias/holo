#!/bin/sh
# MetaVR MCP server (stdio) for physical Quest automation.
# Registered for both agents in .codex/config.toml and .mcp.json.
# Explicit opt-in: requires the host-installed @meta-quest/metavr binary
# (npm install -g --prefix "$HOME/.local" @meta-quest/metavr) and a USB-connected Quest in
# developer mode. No default workflow depends on this server.
set -eu
# Prefer the host-installed binary (no download on the agent path; sandboxed
# sessions cannot reach Meta's CDN). Fall back to npx on uninstalled hosts.
if command -v metavr >/dev/null 2>&1; then
  exec metavr mcp server
fi
exec npx -y @meta-quest/metavr mcp server
