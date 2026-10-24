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

Face and expressions on avatars is complete (brief
[`docs/features/archive/avatar-face.md`](docs/features/archive/avatar-face.md)):
webcam, WebXR eye gaze and liveness drive synthesized ARKit shapes, and
`test:xr:face` (`FACE_VIDEO=1` for the proof video) runs in the capture XR
suite. Next: validate the face on devices (see Unverified below), or pick the
next queue item in [`TODOS.md`](TODOS.md).

## Ready to merge (grouped)

- UI redesign slice 4 (every capture page, touch, handedness; brief
  [`docs/features/ui-redesign.md`](docs/features/ui-redesign.md)) is pushed on
  `claude/sharp-snyder-e9566f` and verified locally with `verify:pr`
  (evidence in the brief). It carries slice 3's `7b9f666` (`GlyphControl
  glyph: null`) and the `ui-dom` passthrough `2be153f`. Merge it together
  with slice 3. Slices 0, 1 and 2 were merged on 2026-10-24.

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
  and webcam tracking in a phone browser. The desktop webcam (including
  left/right on a real wink) and the voice-driven jaw passed on a laptop on
  2026-10-24 (brief
  [`docs/features/archive/avatar-face.md`](docs/features/archive/avatar-face.md)).

## How to resume

1. Read this file, then [`TODOS.md`](TODOS.md) and [`BUGS.md`](BUGS.md).
2. Check `git status --short` and `git log --oneline -10`.
3. Use the command policy in [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md); start
   with an app-scoped check.
4. Before ending, update only the tracker that owns the state you changed
   (queue → `TODOS.md`, feature → its brief, bug → `BUGS.md`) and refresh the
   next action above.
