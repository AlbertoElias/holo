# Project Handoff

Pointer only — do not duplicate state tracked elsewhere. The queue is
[`TODOS.md`](TODOS.md), in-flight work is the feature brief (see
[`docs/features/README.md`](docs/features/README.md)), open defects are in
[`BUGS.md`](BUGS.md), and history is `git log`.

**Updated:** 2026-10-20
**Baseline:** branch `infra/iwsdk-runtime-refactor` (merged with `origin/main`
`c6bec9bc0492`) — check `git log --oneline -10` before trusting it.
**Working tree when updated:** clean on that branch. The shared main checkout
still holds the Oct 18 device session's uncommitted edits; they are ported on
the branch and can be discarded there once it lands.

## Next action

Decide on merging [the IWSDK runtime refactor](docs/features/iwsdk-runtime-refactor.md)
(main deploys automatically after CI), then validate it on a Quest. The real
headset hand fixture is committed (B-015/B-016 fixed on the branch). Still to
record: room-scale walking, turning, crouching and leaning under
`apps/capture/fixtures/body-recordings/` (steps in `apps/capture/README.md`;
brief [`docs/features/room-scale-body-motion.md`](docs/features/room-scale-body-motion.md)).

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
