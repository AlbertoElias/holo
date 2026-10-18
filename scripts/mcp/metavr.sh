#!/bin/sh
# MetaVR MCP server (stdio) for physical Quest automation.
# Registered for both agents in .codex/config.toml and .mcp.json.
# Explicit opt-in: requires the host-installed @meta-quest/metavr binary
# (npm install -g @meta-quest/metavr) and a USB-connected Quest in
# developer mode. No default workflow depends on this server.
set -eu
exec npx -y @meta-quest/metavr mcp server
