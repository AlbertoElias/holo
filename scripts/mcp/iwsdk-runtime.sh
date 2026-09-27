#!/bin/sh
# IWSDK runtime MCP server (stdio), scoped to the capture app.
# Registered for both agents in .codex/config.toml and .mcp.json.
set -eu
cd "$(dirname "$0")/../../apps/capture"
exec node node_modules/@iwsdk/cli/dist/cli.js mcp stdio
