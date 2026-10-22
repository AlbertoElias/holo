# Project Handoff

Pointer only — do not duplicate state tracked elsewhere. The queue is
[`TODOS.md`](TODOS.md), in-flight work is the feature brief (see
[`docs/features/README.md`](docs/features/README.md)), open defects are in
[`BUGS.md`](BUGS.md), and history is `git log`.

**Updated:** 2026-10-20
**Baseline:** `main` after the IWSDK runtime refactor merge (`971b076065e2`) — check `git log --oneline -10` before trusting it.
**Working tree when updated:** clean on `main`. The shared checkout's
uncommitted Oct 18 device-session edits are superseded by that merge
(ported as B-015/B-016 and the shoulder IK) and can be discarded there.

## Next action

Validate capture's IWSDK runtime on a Quest (performance against the
pre-refactor runtime, multiview rendering, AR, aim rays and hand touch on the
record pill); the gaps are listed in
[the archived brief](docs/features/archive/iwsdk-runtime-refactor.md). Then
record room-scale walking, turning, crouching and leaning under
`apps/capture/fixtures/body-recordings/` (brief
[`docs/features/room-scale-body-motion.md`](docs/features/room-scale-body-motion.md)).

## Ready to merge (grouped)

Verified branches awaiting a grouped merge to `main` (do not merge singly).

- `infra/meaning-contract` — new `@holoim/meaning` package: `HOLOIM_meaning` v0
  types and validator, VRM humanoid bone table with Mixamo aliases (brief:
  [`docs/features/self-resolving-pointing.md`](docs/features/self-resolving-pointing.md),
  on `docs/self-resolving-pointing-brief`). Consumers: capture and viewer.

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
