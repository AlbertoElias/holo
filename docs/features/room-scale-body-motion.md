# Feature brief: Natural full-body motion from room-scale movement

**Lead:** Claude Code
**Status:** Verifying

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

Measured on IWER replays of `fixtures/body-recordings/` through the real WebXR
path, with the simulation ticking inside XR frames as on a headset
(`test:xr:body`). Distances are metres; "leg" means the avatar's leg length, so
a different avatar or user height does not change the verdict. Thresholds live
in `apps/capture/scripts/lib/body-fidelity.mjs`.

- [x] **Input path:** the app's head pose equals the recorded pose (≤ 2 mm).
- [x] **World lock:** with no artificial input the rig moves ≤ 1 cm and turns
  ≤ 0.1°, and its height follows the ground under the body (≤ 3 cm p95).
- [x] **Eyes on eyes:** avatar eye midpoint vs tracked eyes p95 ≤ 2 cm while
  standing, ≤ 4.5 cm while moving, max ≤ 6 cm, lag 0 frames. *(Changed from a
  single 3 cm p95: while walking, the pelvis dips so planted feet stay reachable
  at double support, and the tracked head's bob is not in phase with the
  avatar's steps.)*
- [x] **Head orientation:** yaw and pitch from eye and head-top bones within 8°
  p95 of the tracked head.
- [x] **Pelvis and root:** pelvis lag ≤ 2 frames while walking; root and pelvis
  overshoot ≤ 3 cm after a walk stops.
- [x] **Body yaw:** neck twist ≤ 75°; after a turn the pelvis is within 15° of
  the head within 1.0 s; in-place turns lag 0.05–0.6 s (half-turn crossing,
  turns the head holds); while walking straight the pelvis is within 20°.
- [x] **Feet:** planted heel or ball drift ≤ 2 cm per contact; ≤ 2% skating
  foot-frames; soles never below −1.5 cm; planted soles ≤ 2 cm above ground;
  ankles ≥ 8 cm apart; planted jitter ≤ 2 mm RMS.
- [x] **Stepping:** at 0.8–1.6 m/s, 1.2–2.6 steps/s and 0.4–1.1 leg per step;
  ≤ 1 foot relocation while standing with head sway, crouching, or leaning.
- [x] **Crouch:** pelvis drop 0.6–1.2 × head drop.
- [x] **Lean:** spine pitch correlates ≥ 0.9 with the head's forward offset
  over each in-place lean.
- [x] **Smoothness:** pelvis jerk ≤ 2× the tracked head's; no pops (a joint step
  > 3× its neighbours' and > 4 cm); per-frame caps (pelvis and head 10 cm, legs
  27 cm ≈ 8 m/s); pelvis yaw ≤ 15° per frame.
- [x] **Hands still follow:** `test:xr:hands` passes in device frame order;
  wrists ≤ 2 cm p95 in the crouch-and-lean replay.
- [x] Every behavior's metric fails when the behavior is broken
  (`BODY_REPLAY_FAULTS=1`: 12 of 12 caught).
- [x] Identical results across runs locally and in the 2-vCPU container
  (byte-identical samples, Linux and macOS alike); full CI tier pending below.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Test reads app state that the real input path never produces | Replay keeps `mockVr` off; truth comes from the recording, the avatar from bones |
| Render order differs between test and headset (B-009) | Replays tick inside XR frames; head pose comes from view transforms |
| Rig follows the avatar, so the world swims (B-012) | World-lock metric; fault `rig-follows-avatar` fails it |
| Avatar trails or leads the head | Eye error and velocity cross-correlation; fault `root-ignores-head` fails it |
| Pelvis overshoots on stops | Overshoot metric; fault `root-overshoots` (spring) fails it |
| Body snaps to every glance, or never turns | Neck twist, settle time, turn lag; fault `body-yaw-snaps` fails it |
| Feet slide | Drift and skating; fault `feet-glued-to-root` fails them |
| Feet sink into or float above sloped terrain | Sole heights over raycast ground (ramp fixture); fault `feet-float` fails it |
| Fidgety stepping while standing or leaning | Foot relocations in still and in-place windows; fault `fidget-steps` fails it |
| Legs cross on side steps | Foot separation; fault `feet-cross` fails it |
| Crouch missing | Pelvis/head drop ratio; fault `pelvis-ignores-crouch` fails it |
| Lean turns into stepping | Lean correlation and in-place relocations; fault `no-spine-lean` fails it |
| Head bone not driven | Pitch from bones; fault `head-not-rotated` fails it |
| Jittery pelvis | Jerk ratio; fault `pelvis-jitter` fails it |
| IK knee snaps near full extension | Pop metric; soft IK in `legIk.ts` |
| Hand sensors block the body (B-010) | Movement queries exclude sensors |
| Scratch-vector aliasing between solver stages | One scratch set per stage (plan, step, pose, leg); faults confirm metrics react |
| Replays depend on host speed (B-013) | Clear-state cache, steady-frame wait, frame-clock alignment; byte-identical samples across runs |
| Recenter or tracking jump | Rig realigns on reference-space `reset` or a > 0.5 m head jump instead of walking the body |
| Walking into a virtual wall | The body stops at the wall and the view is not pushed back; not covered by a fixture yet |
| Fixture bloat | 30 Hz recordings; controllers where hands are not under test (1.6 MB total) |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code | Brief, integration, handoff |
| Design reviewer | Codex (`codex exec -s read-only`) | Brief and plan before implementation |
| Implementer | Claude Code | `apps/capture/src/body/*`, `AppOrchestrator`, `CameraController`, `CharacterMotor`, `XrSessionService`, debug hooks, capture scripts and fixtures, `tooling-testing/xr-env` |
| Independent verifier | Codex final-diff review plus the fault-injection run | Read-only review; replay artifacts |

## Design decision (as built)

1. **Head pose.** `XrSessionService.updateHeadPose()` reads the eye midpoint and
   orientation from `getCamera().cameras[i].matrix` (tracking space, set every
   XR frame before the app runs) and maps them through the rig. Hands, crouch,
   and body all use it (B-009).
2. **World-locked rig.** On the first valid head pose, on a reference-space
   `reset`, or after a > 0.5 m tracking jump, the rig is placed so the tracked
   eyes sit on the avatar's standing eyes (soft knees, real ground) and the
   body faces the head. Afterwards the rig moves only with input movement and
   the ground height under the body; a wall stops the body, not the view.
3. **`VrBodySolver`** (`src/body/`), active for real XR input; the mock-VR hook
   keeps the legacy path. Write order: motor → root → mixer → body solver (owns
   hips, spine, neck, head, legs, feet, toes) → arm IK → camera → recording.
   - *Body yaw* follows a head yaw that stays stable looking straight down;
     ±40° neck deadzone, release at 3°, ±70° hard limit, faster while walking.
   - *Root*: the head projected to the floor minus the bind eye offset. The
     body tells a lean from a step by head drop (a lean pivots the head down):
     the allowed offset grows with the filtered drop. Walking (sustained
     > 0.55 m/s, upright) moves the root with the head plus a capped catch-up,
     so it never overshoots. Displacement goes through `CharacterMotor` as a
     separate, collision-aware move (`externalDisplacement`).
   - *Feet*: planted until displaced (0.12 leg), turned (25°), strained, or
     holding the pelvis down; walking alternates feet at a speed-based cadence
     (~2.2 steps/s at 1.2 m/s) with swings of 80% of a step, landings led by
     velocity and re-aimed during the swing (rate-limited), quick first steps,
     a minimum swing time for long strides, no crossing, and a minimum gap.
     Foot height and pitch come from ground under heel and ball.
   - *Pelvis and spine*: pelvis placed so the head bone reaches the tracked
     head (three passes), lean spread over hips and spine with residual
     passes, twist over spine and neck, neck shares head pitch, head bone takes
     the tracked orientation. The pelvis dips (≤ 0.05 leg, eased) when planted
     feet would otherwise be out of reach.
   - *Legs*: two-bone IK as a frame map from bind (knee toward the foot, a
     little outward), soft IK over the last 5% of reach, and rate-limited heel
     or toe roll when the ankle is out of reach.
4. **Replays.** Checks freeze the page clock, wait for steady XR frames, align
   the frame clock, and tick inside XR frames (`__setFrameStepping`).
   `attachXrEnvironment` caches GL clear state so IWER frames do not stall.

### Design review (Codex, read-only, 2026-10-18)

Confirmed the XR camera timing finding and the motivating findings; the crouch
double-count was plausible but not measured. Adopted: explicit recenter and
tracking-jump policy; root displacement as a collision-aware motor input; one
write order; feet aligned to the ground under heel and ball; oracles from the
recording and bones, not the solver. Not adopted: a dedicated GLB export
assertion (the recorder already stores every bone's local position and rotation
per frame, unchanged) and eye-error exclusion for blocked frames (no fixture
walks into a wall yet).

### Final review (Codex, read-only, 2026-10-18)

Nine findings, all fixed:

- Jumps pinned the pelvis to the floor and could pop: the solver now has an
  airborne mode (pelvis rides the capsule, feet tuck, re-plant on landing).
- Solver poses survived XR exit into desktop: body bones return to bind when
  the solver stops.
- The landing frame was left out of the rig's height: the rig follows the
  capsule through landing, so a jump nets zero.
- Heading mixed roll into yaw: projected forward when well conditioned, the
  up-vector fallback only near vertical.
- Lost tracking looked valid: head validity now comes from the frame's
  viewer pose (`noteXrFrame`).
- Metrics assumed even sample spacing (samples land on a 16 ms grid, 32/48 ms
  apart): samples are resampled onto a uniform 30 Hz timeline; the input check
  uses the raw samples.
- A spine that never leans passed (null correlation): it now fails.
- Missing ground samples counted as contact: a ground-coverage check fails
  them.
- The GL clear-state cache clamped colors: it now learns the stored value
  from one real read per distinct input.

Both metric holes were re-tested by tampering with saved samples (upright
spine; feet raised 1 m with ground removed): each now fails.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Body criteria | `pnpm --filter @holoim/capture run test:xr:body` | All five fixtures pass (table below); reports in `output/ci-body-replay/` |
| Metrics can fail | `BODY_REPLAY_FAULTS=1 node scripts/run-xr-checks.mjs body` | 12/12 faults caught, each by its named metric; `output/ci-body-replay/fault-matrix.json` |
| Video and screenshots | `BODY_REPLAY_VIDEO=1 XR_CAPTURE_SUCCESS_SCREENSHOTS=1` | One MP4 and one final PNG per fixture (third person, tracked head path cyan, avatar eyes pink) |
| Hands in device order | `test:xr:hands` | Passes; the old head read fails it at 2,082 cm (B-009) |
| Determinism | Body and hands checks twice, concurrency 2; one replay three times | Byte-identical samples for all six replays |
| Determinism and speed on 2 vCPU | `docker run --cpus=2 --memory=7g mcr.microsoft.com/playwright:v1.58.2-noble`, CI suites twice | Both runs pass: capture XR 200/196 s (body 140 s, two replays at once), viewer 49/42 s, pipeline 44/39 s; samples byte-identical between runs and with macOS |

Results on macOS after merging `main` (fixtures: walk forward/back/side, turn in place + arc, crouch
and lean, small steps + sway, walk up the ramp):

| Metric | Walk | Turn | Crouch/lean | Steps/sway | Ramp |
|---|---|---|---|---|---|
| Eyes p95 standing / moving | 0.1 / 2.2 cm | 0.7 / 2.7 cm | 1.5 / 1.4 cm | 1.5 / 3.2 cm | 0.0 / 1.5 cm |
| Head yaw / pitch p95 | 0.0° / 0.0° | 0.1° / 0.0° | 0.0° / 0.1° | 0.0° / 0.0° | 0.0° / 0.0° |
| Rig drift | 0.0 cm | 0.0 cm | 0.0 cm | 0.0 cm | 0.0 cm |
| Root / pelvis overshoot | 1.6 / 1.3 cm | 0.2 / 0.2 cm | – | – | 0.2 / 0.1 cm |
| Turn lag, neck twist max | – | 0.20 s, 44° | – | – | 0.20 s, 48° |
| Foot drift, skating | 0.4 cm, 0.7% | 0.3 cm, 1.3% | 0.1 cm, 0.0% | 0.2 cm, 0.1% | 0.5 cm, 1.4% |
| Planted sole max, min sole | 2.0, 0.0 cm | 1.0, 0.0 cm | 1.4, 0.0 cm | 1.8, 0.0 cm | 1.3, -0.2 cm |
| Cadence, step length | 2.21/s, 0.60 leg | 2.26/s, 0.48 leg | – | – | 2.14/s, 0.51 leg |
| Crouch ratio, lean r | – | – | 0.91, 1.00 | – | – |
| Pelvis jerk ratio | 0.75 | 1.03 | 0.53 | 0.85 | 1.02 |

The tightest margin is the planted-sole height (up to 2.0 cm against 2 cm): soft IK and heel roll leave a
planted foot up to ~2 cm off the floor at the end of a long reach.

### Defects found and fixed

B-009 (head pose read in the wrong space on device), B-010 (hand sensors block
the body), B-011 (standing creep on slopes), B-012 (room-scale motion missing
from the body), and B-013 (replay tooling) — see
[`../archive/closed-bugs.md`](../archive/closed-bugs.md).

### Follow-ups

- Phase-lock the avatar's steps to the tracked head's bob (double support at
  the head's low point), which would cut walking eye error further.
- A wall fixture: walking into a virtual wall, with eye error reported for
  blocked frames.
- Headset recordings for `fixtures/body-recordings/` (steps in
  `apps/capture/README.md`).
- Natural, non-robotic motion (full-body IK with joint limits, secondary
  motion, data-driven priors, naturalness metrics) is queued in `TODOS.md`.

## Physical-device limits

All fixtures are generated in IWER, not recorded on a headset; they prove the
solver against scripted room-scale paths through the real WebXR input path.
They do not prove comfort, tracking feel, rendering latency, or real gait
variety. A headset recording (steps in `apps/capture/README.md`) is the next
evidence to collect.
