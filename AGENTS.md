# HoloIM agent guide

## Testing doctrine

- Highly prefer end-to-end tests as the sole behavior-verification mechanism for
  complex features when the real workflow can exercise them. Finish with a
  repeatable, inspectable artifact such as a transcript, screenshot, or
  deterministic output file.
- Never add unit tests after implementation merely to ratify code that already
  exists. If isolated testing is genuinely necessary, first enumerate all
  plausible system failure modes and use that list to drive the test design and
  implementation.

This pnpm monorepo contains `apps/capture` (WebXR recording and GLTF export),
`apps/viewer-api` (upload and storage), and `apps/viewer-web` (feed and AR viewer).
Shared contracts, configuration, and tooling live in `packages/`.

Use TypeScript and existing shared configuration. Keep app-specific logic local;
share cross-app code through workspace packages. Keep API endpoints backward compatible
unless versioning is explicit. Preserve GLTF export → upload → render compatibility.

Read `AGENT_CONTRACT.md` when selecting commands, validation scope, or XR environment
settings. Use `pnpm run verify:agent` in the edit loop, `pnpm run verify:pr` before
merging, and `pnpm run verify:nightly` for exhaustive XR or live-API changes.
Documentation-only edits need documentation checks, not every application test.
Complete relevant checks and fixes before handoff.

For feature requests or substantial behavior changes, automatically use the
`feature-delivery` skill in `.agents/skills/feature-delivery/SKILL.md`; do not wait
for the user to name it. Keep small fixes proportional, as described by the skill.

For ongoing project work, `HANDOFF.md` has current state, `BUGS.md` tracks reproduced
defects, and `TODOS.md` tracks planned work. Read the relevant file when resuming or
changing that work. Update the handoff or tracker when the change alters current
status or next actions. `apps/capture/progress.md` is historical context.

For XR automation, use the repository's IWSDK/IWER harness and its HTTPS setup.
Read `docs/IWSDK_AI_WORKFLOW.md` for the managed capture workflow. Treat emulation
results separately from physical-headset validation. Shared Three.js values may
cross module boundaries; use structural flags where constructor identity is unreliable.

For other browser QA, use the browser tool suited to the task and available session.
Project-local gstack skills live in `.agents/skills/gstack`; load the requested workflow
when using gstack. Its setup command is `cd .agents/skills/gstack && PATH="$HOME/.bun/bin:$PATH" ./setup`.

## Agent configuration (Codex and Claude Code)

Keep one source of truth for both agents; `pnpm run doctor` enforces this layout.

- Instructions: edit `AGENTS.md` files only. Each `CLAUDE.md` is a symlink to the
  `AGENTS.md` beside it; add the same symlink when creating a new nested guide.
- Skills: add skill directories under `.agents/skills/`. `.claude/skills` is a
  symlink to that directory, so never create files inside `.claude/skills` directly.
- MCP servers: put launch logic in an executable `scripts/mcp/<name>.sh`, then
  register the same `<name>` in both `.codex/config.toml` and `.mcp.json`. Those
  config formats differ and cannot be symlinked.
- Claude Code permission defaults live in `.claude/settings.json`; personal
  overrides belong in the ignored `.claude/settings.local.json`.
