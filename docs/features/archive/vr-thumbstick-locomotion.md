# Feature brief: VR thumbstick locomotion and snap turn

**Lead:** Muse Code
**Status:** Complete
**Layer:** event (capture)

## User outcome

In VR, a user with controllers can move through the room with the left
thumbstick (smooth, relative to where their head faces) and turn without
physically rotating with the right thumbstick (30° snap turn about their
own head, or smooth turn), while the room-scale body solver keeps the
avatar's body stepping from the resulting motion. Recordings therefore
show avatar travel the user did not physically walk.

## Scope

**Included:** left-stick analog smooth move (deadzone, magnitude-scaled
speed) relative to head world yaw; right-stick snap turn (30°, re-arms
inside the deadzone) and smooth turn (rate while deflected), selectable;
turn rotates the world-locked camera rig about the tracked head so the
body solver follows; real XR gamepad axes (standard mapping) plus the
deterministic mock hook; an IWER replay check driven through the mock
controller-input hook; a spectator video artifact of the check.
**Excluded:** teleport locomotion, thumbstick UI/settings menu (mode is
chosen by config/hook, default snap), arm-swing locomotion, marking
stick travel as inferred in exports (separate TODOS item), physical
comfort validation.

## Acceptance criteria

- [x] Left stick pushed forward/back/left/right moves the avatar in the
  head-yaw-relative direction (heading error < 45°, travel > 0.08 m per
  trial, analog half-deflection slower than full).
- [x] Right stick flick snaps the facing by ~30° about the head: the
  avatar's heading and the next forward move follow the new heading, and
  the head's world position does not translate from the turn itself.
- [x] Smooth-turn mode rotates the heading continuously while held.
- [ ] Stick motion and physical room-scale motion compose: the rig
  follows only stick/input movement, the body solver still plans root
  motion from the head, and releasing the stick stops travel.
  (Code path shares the motor's input-movement rig carry; the
  body-tracking composition itself is device/IWER-body-replay evidence,
  not covered by the mock-pose locomotion check.)
- [x] No stick input (or no controllers) leaves current behavior
  unchanged; desktop keyboard/mock boolean input is unaffected.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Swapped/inverted stick axes move the avatar the wrong way | Replay check asserts heading per direction at several head yaws |
| Turn rotates about the rig origin, swinging the head in an arc | Turn pivots on the head world position; check asserts head does not translate |
| Snap turn re-triggers while the stick is held | Edge trigger with re-arm below threshold; check holds the stick and counts one snap |
| Room-scale align wipes the accumulated turn | Align preserves the rig's turn quaternion; check turns, then physically steps |
| Stick drift (resting axes ≈ 0.05) creeps the avatar | Radial deadzone 0.15; check asserts no travel with sub-deadzone input |
| Gamepad axes layout differs (touchpad-only devices) | Standard mapping: axes[2,3], fallback axes[0,1] when only two axes |
| Mock/real divergence hides a broken gamepad path | One code path: gamepad axes and mock hook write the same thumbstick state |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Muse Code | Brief, integration, final handoff |
| Design reviewer | Muse Code (self-review, recorded below) | Read-only review before implementation |
| Implementer | Muse Code | `apps/capture/src/input/`, `physics/CharacterMotor.ts`, `systems/`, `runtime/captureTextState.ts`, `types/contracts.ts`, check script |
| Independent verifier | Separate subagent | Read-only verification; test artifacts only |

## Design decision

One thumbstick state (`moveX/moveY/turnX`, −1..1) owned by a new
`VrLocomotion` service. Real XR gamepad axes (read through `XrTracking`
input slots) and the mock hook both write it; `MovementSystem` consumes
it, so IWER exercises the production path. The motor gains an analog
move vector in look space (magnitude scales speed; boolean keys keep
the existing path). Turn accumulates `turnYaw`; a system after session
setup applies each frame's turn delta to the camera rig about the head
world position (position rotated around the pivot, quaternion premultiplied),
and `RoomScaleSystem`'s align preserves that quaternion instead of
resetting to identity. In mock VR the same turn offsets the rig on top
of the mock head pose, so the deterministic check sees the real math.

Alternatives considered: rotating only `lookYaw` (no visual turn on a
headset — rejected); IWSDK World's built-in locomotion (off by project
design; capture owns its rig and Rapier motor — rejected).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Head-relative analog move, deadzone, speed scaling | `pnpm --filter @holoim/capture run test:xr:flows` (new thumbstick scenarios in the locomotion check) | Passed 2026-10-22: stick cardinals 1.43–1.49 m at 0.000 rad heading error; deadzone, analog scaling, snap (one 30° snap per flick, rig yaw = turn yaw, no root translation), smooth turn all asserted green. Re-confirmed 2026-10-23 in the `VR_LOCO_VIDEO=1` run (stick cardinals 1.43–1.49 m, 0.000 rad) and the full `pnpm run verify:pr` (pipeline/portal/XR stages run on reassigned ports 3175/3002/5176 because another agent held 3174/3001) |
| Snap/smooth turn about the head | Same check (turn scenarios) | Same run as above |
| Video of it working | `VR_LOCO_VIDEO=1` run of the check | Passed 2026-10-23 (unsandboxed session): `vr-thumbstick-locomotion.mp4` (66 frames) produced; contact sheet shows the avatar/scene rendering through the run |
| No regression | `pnpm run verify:agent`, full `test:xr:capture` before merge | Command output |

## Physical-device limits

IWER proves deterministic stick→motion math only. Stick feel, snap-turn
comfort, and real controller axis layouts need a Quest session; that
stays on the physical-headset checklist in `TODOS.md`.
