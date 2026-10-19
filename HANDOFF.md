# IWSDK branch handoff

**Updated:** 2026-10-19
**Branch:** `infra/iwsdk-prototype` — older prototype plus production refactor plan.

## Next action

Give Claude [the implementation prompt](docs/prompts/claude-iwsdk-runtime-refactor.md).
The authoritative plan is [the refactor brief](docs/features/iwsdk-runtime-refactor.md).
Start the implementation from latest `origin/main`, preserving its completed
movement work and coordinating any newer uncommitted hand fixes. Selectively port
prototype ideas; do not merge this old runtime snapshot over main.

## Evidence and remaining work

Historical spike evidence is indexed in [the prototype guide](docs/IWSDK_RUNTIME_PROTOTYPE.md).
The production migration, latest movement/height/body integration, actual outer
MCP transport and device comparison remain implementation work described by the
brief. This planning change only updates documentation; it does not revalidate or
merge the prototype runtime.

Use the current main-based AGENTS.md, AGENT_CONTRACT.md and feature workflow.
Keep implementation state in its brief; this file is only the branch pointer.
