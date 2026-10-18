# Feature brief: XR avatar height adaptation

**Lead:** Codex height owner  
**Status:** Complete

## User outcome

In immersive VR, the avatar fits the person's initial neutral eye height while
its feet remain at the character ground and hands continue to use tracked meters.

## Scope

**Included:** stable initial floor-height calibration, uniform avatar sizing,
camera floor mapping, lifecycle/reset safety, arm lengths and real XR E2E evidence.
**Excluded:** locomotion animations/state machine, terrain motor, desktop sizing,
AR placement, personal body-proportion estimation, new export contracts.

## Acceptance criteria

- [x] Short, tall, and seated initial neutral heights produce proportionate avatars
  from actual rig eye anchors, independent of configured asset size.
- [x] Calibration requires valid stable floor-relative viewer poses; crouching,
  jumping, missing tracking, visibility loss, and recenter never continuously resize.
- [x] Foot base stays fixed through scale changes; camera and hand input stay in
  meters; arm IK lengths follow avatar scale without recapturing bind rotations.
- [x] Exit restores desktop size; re-entry calibrates fresh. Recording retains its
  starting avatar size until export completes, including across session exit.
- [x] Deterministic browser artifacts prove boundaries and existing hand replay and
  export/upload/render checks pass. Device-only limitations remain explicit.

## Failure cases considered

| Failure case | Prevention or evidence |
| --- | --- |
| Floor is unavailable or pose missing/nonfinite/emulated | Require floor reference and live viewer pose; leave baseline size while waiting |
| Entry during movement/noisy pose | Require 0.5 seconds within 2 cm; restart window on invalid tracking |
| Seated mistaken for crouch | Initial neutral posture defines size; lock until next VR entry; cannot infer posture from one headset |
| Crouch/jump causes growing/shrinking | One-shot size per VR entry; recenter preserves calibrated size |
| Reset/visibility interruption | Restart pending sample window, preserve completed size; camera follows reference floor |
| Unusual eye/head proportions or nonzero asset origin | Measure rig eye anchor above mesh base; fallback to existing eye metric |
| Stale IK reach after scaling | Multiply cached world lengths by scale ratio; never recapture retarget bind pose |
| Double scaling animation/tracking/world/collider | Scale avatar asset only; root and tracking rigs stay unit scale |
| Exit/reentry while recording corrupts export | Freeze sizing during recording/export; defer desktop restore/fresh calibration until idle |
| Scope overlaps parallel locomotion feature | Own no animator/motor changes; document narrow orchestrator and rig merge boundaries |

## Ownership

| Role | Owner | Files or modules |
| --- | --- | --- |
| Lead / implementer | Codex height | This brief, XR height module, AvatarRig scale boundary, CameraController VR mapping, XrSessionService floor samples, narrow orchestrator hooks, height E2E |
| Design reviewer | Scoped read-only agent | This brief and transform boundaries |
| Independent verifier | Scoped agent | Acceptance and workflow artifacts |
| Parallel locomotion owner | Separate chat | Animator/motor, crouch animation behavior; no ownership here |

## Design decision

Automatic one-shot calibration after 0.5 seconds within 2 cm of the initial
neutral pose avoids a new setup panel. Accept floor-relative eye heights from
0.65 to 2.4 meters; invalid/emulated/missing poses leave the configured size. Initial seated entry fits the avatar to that height, rather than
claiming it estimates standing stature. Stand/sit neutrally on entry; exit and
re-enter VR to deliberately recalibrate. No persistent user profile.

**Transform contract:** `avatarRoot` carries motor position/yaw at unit scale;
`avatar` carries asset/config scale multiplied by calibrated factor. World and
cameraRig remain unit scale. Public `avatarHeight`, `avatarMinLocalY`, and
`avatarEyeLocalY` are current meters; skeletal local positions remain bind units.
The motor capsule and its visual offset retain baseline dimensions; visual root
gets `baselineMinY - currentMinY` compensation so mesh base does not drift.
Animation consumes current meter metrics without multiplying calibration again.
Cached IK lengths are world meters and are updated by relative scale ratio.
Eye anchors are measured before animation begins, not from a crouched pose.
Crouch hip translations and world ground-compensation lift convert meters to
bone-parent-local units; applying current avatarHeight directly would double-scale.
Tracking is not scaled. Camera rig's vertical origin is character visual ground;
Initial tracking X/Z is rebased at fit or recenter; subsequent room-scale
horizontal/head movement remains tracked input. Calibrated real hands use the same floor-world origin as the camera; mock
poses retain their existing head-relative mapping. Size locking begins before
recording startup awaits, and lasts through asynchronous export completion.

Test ports reserved here: capture 5274, viewer 3274, API 3101, pipeline 5275.
Human authorized cross-chat coordination; locomotion owner uses ports 5374,
3374, 3201, 5375. Its crouch composition must retain the world-meter to
bone-parent-local conversion added here. Terrain solver consumes world matrices.
The initial messaging rejection was resolved by that explicit authorization.

### Design review changes

Scoped design reviewer required early recording locking, raw floor-frame sampling,
common floor-world camera/hand mapping, and local-unit conversion for hip offsets;
all are implemented. Independent review found that hidden sessions can stop XR
frames before pending calibration sees visibility loss: a session visibilitychange
listener now interrupts sampling independently of frames. XR frames are sampled
only inside their valid callback; automation consumes copied pose values.

## Test plan and evidence

| Criterion | Workflow | Result |
| --- | --- | --- |
| Floor calibration and lifecycle | New real IWER height scenario | Passed 3 real IWER scenarios; final strengthened run 42.7s, wrapper 45.3s |
| Calibrated hand/controller meters | Same height workflow | Independent XR grip X/Y/Z within 2 mm; 3D wrist-target error within 4 cm; crouch leaves floor-space targets fixed |
| Recording / export | Same height workflow | Delayed microphone startup + XR exit preserve size; downloaded GLB retains calibrated scale; desktop restores after export |
| Hand fidelity | Existing real XRHand replay | 244 frames, 100% XRHand; wrist p95 0 cm / 0 degrees, pinch agreement 1.00; worst jerk 1.18x |
| Integration | verify:agent; verify:pr (includes verify:xr and pipeline) | Passed; quality/unit/build, pipeline 1/1, capture XR 4 suites, viewer AR 2/2 |

Full height transcript: `apps/capture/output/ci-xr-height/height-report.json`;
recording: `apps/capture/output/ci-xr-height/height-recording.glb`;
UI screenshots: `apps/capture/output/ci-xr-height/{short,tall,seated}.png`.
The screenshots show entry instructions/status; pose assertions come from the JSON
transcript, not the undrawn 3D viewport. A compact measured summary is committed in
[`evidence/xr-height-adaptation.json`](evidence/xr-height-adaptation.json).
Independent design and final verification agents completed review; no open findings.
Recording through XR re-entry is inspected by the same scale lock; recording startup,
XR exit, async export, and ordinary re-entry have direct browser evidence.

Commands ran from the isolated worktree:

```sh
pnpm run verify:agent
DEV_PORT=5274 E2E_BASE_URL=https://localhost:3274 E2E_API_PORT=3101 E2E_CAPTURE_URL=https://127.0.0.1:5275 pnpm run verify:pr
DEV_PORT=5274 pnpm --filter @holoim/capture run test:xr:height
pnpm --filter @holoim/capture run verify:fast
```

`verify:pr` includes the required XR tier: mock VR, locomotion, real XRHand replay,
height, viewer AR, and the capture/export/upload/render pipeline. Capture suite
wrapper passed in 73.7s; pipeline 1/1 in 25.6s; viewer AR 2/2 in 23.9s. Final
height-only rerun strengthened controller assertions to all three axes and 3D reach.

## Physical-device limits

IWER proves transform math and browser lifecycle only. Quest floor setup accuracy,
recenter/system-menu behavior, initial seated feel, comfort and tracking latency
require physical headset checks; no such evidence claimed.
