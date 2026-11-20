#!/usr/bin/env bash
# Disabled on 2026-11-20. Google's consumer terms do not allow agy (agy -p or agy acp)
# when Claude Code, Codex or an orchestrator drives it, even with a human in the loop;
# it can cause an automatic suspension of the owner's Google account. Source:
# https://discuss.ai.google.dev/t/tos-clarification-is-human-supervised-codex-to-antigravity-acp-delegation-permitted/200697
#
# This script always exits 75, so callers use the Claude design-reviewer instead.
# Do not start agy from an agent or a script on the owner's Google login.
echo "gemini-review: disabled. Google's consumer terms do not allow an agent to drive agy. Use the Claude design-reviewer." >&2
exit 75
