# Project Handoff

Pointer only — do not duplicate state tracked elsewhere. The queue is
[`TODOS.md`](TODOS.md), in-flight work is the feature brief (see
[`docs/features/README.md`](docs/features/README.md)), open defects are in
[`BUGS.md`](BUGS.md), and history is `git log`.

**Updated:** 2026-10-12
**Baseline:** `cf55d08c4ab0` — check `git log --oneline -10` before trusting it.
**Working tree when updated:** uncommitted capture pinch-retarget/IWSDK work
plus the in-flight deterministic-CI brief; preserve changes you did not make.

## Next action

Start a session that loads the project MCP config (`.codex/config.toml` or
`.mcp.json`), then use `pnpm run dev:capture:ai` for the next capture iteration.
Continue the active brief in [`docs/features/README.md`](docs/features/README.md).

## Unverified / device-only

- Validate capture VR embodiment, hand/finger retargeting, pinch/release
  transitions, and VR enter/exit on a physical headset. IWER covers
  deterministic browser flows only; it does not prove tracking feel, comfort,
  performance, or device session behavior.
- Perform real-device viewer AR placement validation.

## How to resume

1. Read this file, then [`TODOS.md`](TODOS.md) and [`BUGS.md`](BUGS.md).
2. Check `git status --short` and `git log --oneline -10`.
3. Use the command policy in [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md); start
   with an app-scoped check.
4. Before ending, update only the tracker that owns the state you changed
   (queue → `TODOS.md`, feature → its brief, bug → `BUGS.md`) and refresh the
   next action above.
