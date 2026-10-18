# Project Handoff

Pointer only — do not duplicate state tracked elsewhere. The queue is
[`TODOS.md`](TODOS.md), in-flight work is the feature brief (see
[`docs/features/README.md`](docs/features/README.md)), open defects are in
[`BUGS.md`](BUGS.md), and history is `git log`.

**Updated:** 2026-10-18
**Baseline:** `01c1ca691378` — check `git log --oneline -10` before trusting it.
**Working tree when updated:** clean; MetaVR setup and capture AR recenter
landed on `main`.

## Next action

Physical-device session (Quest 3 connected and USB-authorized;
`@meta-quest/metavr` 1.8.0.17.10 installed to `~/.local`, `adb` platform-tools
in `~/.local/bin`, `metavr` MCP registered for both agents — run device work
from a fresh agent session so the MCP server is host-spawned, or an
unsandboxed shell; sandboxed bash cannot reach USB). First: desk-bound
MetaVR checks (device screenshot, capture launch, frame-rate profile).
Then record headset input for `test:xr:hands` (steps in `apps/capture/README.md`,
"Hand-Tracking Fidelity From Headset Input"), commit it under
`apps/capture/fixtures/input-recordings/`, and recalibrate the B-005 ceilings
against it. Active brief: [`docs/features/hand-tracking-fidelity.md`](docs/features/hand-tracking-fidelity.md).

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
