# Project Handoff

Pointer only — do not duplicate state tracked elsewhere. The queue is
[`TODOS.md`](TODOS.md), in-flight work is the feature brief (see
[`docs/features/README.md`](docs/features/README.md)), open defects are in
[`BUGS.md`](BUGS.md), and history is `git log`.

**Updated:** 2026-10-24
**Baseline:** `main` after the IWSDK runtime refactor merge (`971b076065e2`) — check `git log --oneline -10` before trusting it.
**Working tree when updated:** clean on `main`. The shared checkout's
uncommitted Oct 18 device-session edits are superseded by that merge
(ported as B-015/B-016 and the shoulder IK) and can be discarded there.

## Next action

VR thumbstick locomotion is complete (brief
[`docs/features/archive/vr-thumbstick-locomotion.md`](docs/features/archive/vr-thumbstick-locomotion.md),
branch `feature/vr-locomotion`): the `VR_LOCO_VIDEO=1` locomotion check
passed and produced
`apps/capture/output/ci-vr-locomotion/vr-thumbstick-locomotion.mp4`, and
`pnpm run verify:pr` passed. Next: validate the room-scale body solver and
stick feel/comfort on a physical headset (see Unverified below), or pick
the next queue item in [`TODOS.md`](TODOS.md).

## Ready to merge (grouped)

- `feature/avatar-face`: face and expressions on avatars (brief
  [`docs/features/avatar-face.md`](docs/features/avatar-face.md)). Verified
  locally (`verify:pr`, all capture XR checks including the new `face`) and
  by an independent Codex review whose defects are fixed. Merge with the
  next finished change, then close the brief.


## Unverified / device-only

- Self-resolving pointing on a Quest and a phone: score at least three new
  headset takes with 20 or more author-labelled points against PRD-022's
  precision and recall targets, view the feed highlight on a real phone, and
  run the recipient trial (brief
  [`docs/features/self-resolving-pointing.md`](docs/features/self-resolving-pointing.md)).
- Validate the room-scale body solver on a headset (walking, turning,
  crouching, leaning feel; world lock; comfort). The body check is IWER only.
- Validate capture VR embodiment, hand/finger retargeting, pinch/release
  transitions, and VR enter/exit on a physical headset. IWER covers
  deterministic browser flows only; it does not prove tracking feel, comfort,
  performance, or device session behavior.
- Perform real-device viewer AR placement validation.
- Face on devices: WebXR eye gaze and its permission prompt on a Quest Pro,
  a real wink through the webcam (left/right mirroring), webcam tracking
  quality on a laptop and a phone, and the microphone-driven jaw with real
  speech (brief [`docs/features/avatar-face.md`](docs/features/avatar-face.md)).

## How to resume

1. Read this file, then [`TODOS.md`](TODOS.md) and [`BUGS.md`](BUGS.md).
2. Check `git status --short` and `git log --oneline -10`.
3. Use the command policy in [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md); start
   with an app-scoped check.
4. Before ending, update only the tracker that owns the state you changed
   (queue → `TODOS.md`, feature → its brief, bug → `BUGS.md`) and refresh the
   next action above.
