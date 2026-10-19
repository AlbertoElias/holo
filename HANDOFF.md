# Project Handoff

Pointer only — do not duplicate state tracked elsewhere. The queue is
[`TODOS.md`](TODOS.md), in-flight work is the feature brief (see
[`docs/features/README.md`](docs/features/README.md)), open defects are in
[`BUGS.md`](BUGS.md), and history is `git log`.

**Updated:** 2026-10-19
**Baseline:** `01c1ca691378` — check `git log --oneline -10` before trusting it.
**Working tree when updated:** clean; MetaVR setup and capture AR recenter
landed on `main`.

## Next action

Record headset input and commit it: hands under
`apps/capture/fixtures/input-recordings/` (recalibrate the B-005 ceilings
against it) and room-scale walking, turning, crouching, and leaning under
`apps/capture/fixtures/body-recordings/` (steps in `apps/capture/README.md`).
Active briefs: [`docs/features/hand-tracking-fidelity.md`](docs/features/hand-tracking-fidelity.md)
and [`docs/features/room-scale-body-motion.md`](docs/features/room-scale-body-motion.md).

## Unverified / device-only

- Validate the room-scale body solver on a headset (walking, turning,
  crouching, leaning feel; world lock; comfort). The body check is IWER only.
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
