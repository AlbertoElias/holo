# Feature brief: Natural full-body motion from room-scale movement

**Lead:** Claude Code
**Status:** Implementing

## User outcome

In VR, when the user physically walks, turns, crouches, leans, or steps in
their room, the capture avatar's whole body moves the way theirs does: the
avatar's eyes stay at the user's eyes, the pelvis follows without snapping or
overshooting, the feet plant and step instead of sliding, and the torso and
head bend and turn with the user. Because capture records the avatar, this is
also what the exported GLB shows. CI proves it by replaying recorded headset
input through the real WebXR path and measuring the body against the tracked
head.

## Findings that motivate the work (investigation, 2026-10-18)

How physical head movement drives the avatar on `main` (`c72c32b`):

- `CharacterMotor` moves only from keyboard/mock input. Physical head
  translation never moves the character, so walking in the room leaves the
  avatar behind: the camera is `cameraRig + headLocal`, and the rig is pinned
  to the avatar's eye anchor every frame (`CameraController.updateFirstPersonCamera`).
- The rig is placed 0.08 × avatar height (~14 cm) in front of the eye anchor
  along the look direction, so turning the head in place swings the rig — and
  the whole world — around a ~14 cm circle.
- Body yaw is the head yaw every frame (`syncYaw` → `lookYaw` →
  `avatarRoot.rotation.y`): glancing sideways spins the whole body, with no
  neck twist or turn lag.
- VR crouch lowers the avatar's hips with a canned pose driven by head drop,
  and the rig follows the lowered eye anchor while the tracked head drop is
  also applied: the view drops by roughly head drop + pose drop.
- Feet are not planted. The VR "lower-body" profile plays a fixed 1 s walk
  cycle at a constant rate whenever the motor moves, which slides the feet.
- The avatar head bone is never rotated to the tracked head; pitch and roll
  never reach the avatar or the export.
- Device-only: in a real XR frame three.js leaves `renderer.xr.getCamera()`
  holding the *tracking-space* left-eye pose until `render()` runs, but
  `XrSessionService` reads it as world space (hand targets, head height). The
  replay harness hides this because its manual clock runs `xr.updateCamera`
  before the simulation step (the B-004 class of bug).

## Scope

**Included:**
- A VR body solver for real XR input: root and capsule follow the tracked head
  through the physics controller; body yaw follows head yaw with a neck-twist
  allowance and turn lag; procedural foot planting and stepping; two-bone leg
  IK; pelvis height and spine lean solved so the avatar's eyes meet the tracked
  eyes; neck and head follow the tracked head orientation.
- A world-locked camera rig: it moves only for artificial locomotion,
  collision pushback, and terrain height, never because the avatar moved.
- Head pose read from the XR views' tracking-space transforms, independent of
  render order; hand targets use the same head pose.
- Deterministic IWER fixtures for room-scale motion, a replay check through the
  real WebXR path that steps the simulation inside XR frames (device order),
  body metrics with thresholds, and a fault-injection mode proving each metric
  can fail.
- Evidence: a third-person spectator video with the tracked head path overlaid,
  and per-check screenshots.

**Excluded:** thumbstick locomotion and snap turn (none exists today; queued
as its own feature in `TODOS.md`);
the `__setMockVrPose` debug path (it keeps its legacy behavior and checks);
desktop locomotion and animation; physical-headset validation of feel and
comfort; changes to the export format (bones are already recorded per frame).

## Acceptance criteria

All measured on IWER replays through the real WebXR path, with the simulation
stepped inside XR frames as on a headset. Distances are metres; lengths
marked "leg" are normalized by the avatar's leg length so a different avatar or
user height does not change the verdict.

- [ ] **World lock:** with no artificial input, the camera rig moves ≤ 1 cm and
  turns 0° over each replay (no world swim).
- [ ] **Eyes on eyes:** avatar eye midpoint vs tracked eye midpoint p95 ≤ 3 cm,
  lag 0 frames by cross-correlation of velocity, wherever the pose is reachable.
- [ ] **Head orientation:** avatar head yaw and pitch (from eye and head-top
  bones, not the solver's own mapping) within 8° p95 of the tracked head.
- [ ] **Pelvis and root:** pelvis horizontal lag ≤ 2 frames; after a walk
  stops, root and pelvis overshoot ≤ 3 cm beyond their settled position.
- [ ] **Body yaw:** pelvis–head yaw difference never exceeds 75°; after the
  head stops turning, the pelvis is within 15° of it within 1.0 s; pelvis yaw
  lags head yaw by 0.05–0.6 s in turn-in-place; while walking straight the
  pelvis is within 20° of the head.
- [ ] **Feet:** a planted foot drifts ≤ 2 cm per contact; ≤ 2% of frames have a
  foot skating (sole within 1.5 cm of the ground moving > 0.25 m/s); planted
  sole height within −1.5…+2 cm of the ground; feet never closer than 8 cm.
- [ ] **Stepping:** at 0.8–1.6 m/s, cadence 1.2–2.6 steps/s and step length
  0.4–1.1 leg; standing with head sway takes ≤ 1 step; leaning and crouching in
  place take ≤ 1 step.
- [ ] **Crouch:** pelvis drop is 0.6–1.2 × head drop, feet stay planted.
- [ ] **Lean:** spine pitch correlates ≥ 0.9 with the head's forward offset
  from the feet.
- [ ] **Smoothness:** pelvis jerk ≤ 2× tracked-head jerk; no body joint moves
  > 15 cm or pelvis yaw > 15° in one 30 Hz frame; planted feet jitter ≤ 2 mm.
- [ ] **Hands still follow:** `test:xr:hands` passes in device frame order, and
  hand targets are correct while the user walks.
- [ ] Every metric fails when its behavior is broken (fault-injection run).
- [ ] Results are identical across runs and between macOS and the 2-vCPU CI
  container; existing mock-VR, locomotion, hands, viewer, and pipeline checks pass.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Test reads app state that the real input path never produces | Replay keeps `mockVr` off; samples come from XR views and avatar bones |
| Render order differs between test and headset (B-004 class) | New check ticks inside XR frames, like a headset; head pose comes from view transforms, not the ArrayCamera |
| Rig follows the avatar, so the world swims | World-lock metric on rig translation and rotation |
| Avatar trails or leads the head | Eye-offset p95 and velocity cross-correlation lag |
| Pelvis overshoots on stops (spring dynamics) | Overshoot metric on root and pelvis at stops |
| Body snaps to every glance, or never turns | Max neck twist, turn-in-place lag window, settle time |
| Feet slide (animation not tied to speed) | Planted drift and skating-frame share |
| Feet sink into or float above sloped terrain | Sole height vs raycast ground per foot |
| Fidgety stepping while standing or leaning | Step counts in still, lean, and crouch phases |
| Legs cross on side steps | Minimum foot separation |
| Crouch double-counted or missing | Pelvis drop / head drop ratio and eye offset |
| Unreachable poses (head above standing height, very deep crouch) | Eye error measured only where reachable; reported, not hidden |
| Avatar proportions differ from the user | Leg-normalized step metrics; orientation from bone pairs; eyes matched in absolute metres because the camera is the avatar's eye |
| Scratch-vector aliasing between solver stages | Dedicated scratch per stage; fault run confirms metrics react |
| Collision with virtual walls while walking physically | Capsule moves through the character controller; rig pushback is the only rig motion |
| Metric that cannot fail | Fault-injection run must fail each metric's named check |
| Fixture bloat | 30 Hz recordings, ~30 s total |
| Existing checks rely on legacy VR behavior | Mock-VR path unchanged; full `test:xr` and `verify:pr` |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code | Brief, integration, handoff |
| Design reviewer | Codex (`codex exec -s read-only`) | Brief and plan before implementation |
| Implementer | Claude Code | `apps/capture/src/body/*`, `AppOrchestrator`, `CameraController`, `CharacterMotor`, `XrSessionService`, debug hooks, capture scripts and fixtures |
| Independent verifier | Codex final-diff review plus fault-injection run | Read-only review; replay artifacts |

## Design decision

Proposed (pending design review):

1. **Head pose.** `XrSessionService.readHeadPose()` reads the eye midpoint and
   orientation from `renderer.xr.getCamera().cameras[i].matrix`, which three
   sets from `view.transform` every XR frame in tracking space, and maps it to
   world with the rig's matrix. Hand targets and crouch use this pose instead
   of the ArrayCamera's position, whose space depends on whether `render()`
   has run yet.
2. **World-locked rig.** On the first valid head pose after entry the rig is
   placed so the tracked eyes sit on the avatar's standing eyes and the body
   faces the head. Afterwards the rig moves only by the artificial part of the
   capsule's motion (keyboard input, collision pushback, terrain height
   changes, jumps).
3. **`VrBodySolver`** (new, `src/body/`), active while presenting real XR
   input (the mock-VR path is unchanged). Per frame, before physics:
   - *Body yaw* follows head yaw (derived from forward and up so looking
     straight down is stable) with a ±35° neck deadzone, a hard ±70° limit, a
     catch-up rate once triggered (hysteresis to 8°), and faster alignment
     while walking.
   - *Root target*: the tracked head projected to the floor, minus the avatar's
     bind head-over-feet offset. The root follows it on a leash: within an
     anisotropic lean allowance (forward 0.3, back 0.12, side 0.15 leg) it
     stays put, so leaning bends the spine instead of stepping; when the head
     moves faster than 0.25 m/s the root catches up with a 0.12 s time
     constant (exponential, so no overshoot). The displacement goes through
     `CharacterMotor` so walls block it.
   After physics:
   - *Feet*: each foot is planted at a world position and yaw. A foot steps
     when its offset from its stance slot (root ± half bind stance width)
     exceeds 0.12 leg, or its yaw is off by > 25°; one foot swings at a time,
     the more displaced first, never crossing the midline. Landing targets lead
     by the root velocity × 0.55 s; swing lasts 0.32–0.42 s with a sine lift of
     up to 0.08 leg. Landing heights come from terrain raycasts.
   - *Pelvis and spine*: the head-bone target comes from the tracked eye pose
     and the bind eye offset in head space. The pelvis starts at standing
     height over the root (shifted back as the torso leans) and drops when the
     head is closer than the spine length; the lean rotation from the bind
     spine axis to the pelvis→head direction is spread over hips, Spine,
     Spine1, Spine2, and Neck; head-minus-body yaw twists the spine and neck
     progressively; the head bone takes the exact tracked orientation. Three
     correction passes translate the pelvis by the remaining head-target error,
     clamped to what the legs can reach.
   - *Legs*: two-bone IK per leg, built as a frame map from bind (bone axis plus
     knee-forward axis), so the knee bends toward the foot's facing direction;
     the foot keeps its bind orientation turned to the planted yaw.
4. Arm IK and finger retargeting run after the body, unchanged.
5. **Test order.** The new replay check freezes the page clock and then lets
   realtime frames tick the simulation inside each XR frame (`__setFrameStepping`),
   which is the headset's order; frames skip drawing unless a video is made.

### Design review (Codex, read-only, 2026-10-18)

Confirmed the XR camera timing finding and the missing physical-motion,
world-swim, and body-yaw findings; the crouch double-count is plausible but
not yet measured. Changes adopted before implementation:

- Explicit head-pose validity and recenter policy: re-align the rig on the
  first valid pose, on reference-space `reset`, and on tracking jumps > 0.5 m,
  instead of moving the body.
- Define the root target in capsule-centre coordinates; add a collision-aware
  external-displacement API to `CharacterMotor` that reports blocked motion;
  bound per-frame displacement. Measure eye error only on frames where the
  body is not blocked and the pose is within leg reach, from bones, not the
  solver.
- One write order: motor → root → mixer → body solver (owns hips, spine,
  neck, head, legs, feet, toes; crouch pose skipped) → arm IK → camera →
  recording.
- Feet align to the terrain normal, not only its height.
- Oracles independent of the solver: tracked head from the recording frames
  at the player's time; feet contact and steps from sole heights and speeds;
  overshoot against the tracked head's settled position; hand fidelity from
  avatar bones vs tracked joints.
- Add an export check that the solved hips/leg motion is in the exported GLB.
- Determinism: compare reports with a stated tolerance (bit-identical
  expected; ≤ 1e-6 accepted).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| All body criteria | `pnpm --filter @holoim/capture run test:xr:body` | pending |
| Metrics can fail | `BODY_REPLAY_FAULTS=1 … test:xr:body` | pending |
| Video and screenshots | `BODY_REPLAY_VIDEO=1 XR_CAPTURE_SUCCESS_SCREENSHOTS=1 …` | pending |
| Determinism and speed | 2-vCPU Playwright container, `test:xr:capture`, `test:xr:viewer`, `test:smoke:pipeline` twice | pending |

## Physical-device limits

All fixtures are generated in IWER, not recorded on a headset; they prove the
solver against scripted room-scale paths through the real WebXR input path.
They do not prove comfort, tracking feel, rendering latency, or real gait
variety. A headset recording (steps in `apps/capture/README.md`) is the next
evidence to collect.
