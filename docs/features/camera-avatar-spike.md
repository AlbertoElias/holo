# Feature brief: Camera-driven avatar (evaluation spike)

**Lead:** Claude (Fable 5)  
**Status:** Implementing (slice 1 built and re-run independently, 2026-11-10; slice 2 next; the measured numbers wait on the user's clip)
**Layer:** event (the author's head, face, arms and hands over time); see
`docs/product/concepts/what-a-hologram-is.md`

## User outcome

An author with no headset opens capture on a phone or a laptop, props the
device, turns the camera on, and their avatar's head, face, arms and fingers
follow them like a mirror. They record a take, and it uploads and plays like
a headset take.

This is a spike. Its product is a decision: **is single-camera tracking good
enough for hands and pointing** to justify a PRD for
[IDEA-078](../product/IDEAS.md)? The idea as written takes only the face from
the phone; the spike widens it to the upper body, because most people have no
headset to supply the rest (the user, 2026-11-10: phone capture is the main
entry point).

## Background (checked against the tree at `623e4645f986`)

- **The face already works from a camera.** `apps/capture/src/face/WebcamFace.ts`
  runs MediaPipe `FaceLandmarker` on `getUserMedia` and drives the avatar's
  ARKit-52 face; morphs are recorded and exported. `FaceDriver.update`
  stops that camera whenever `vrActive` is true.
- **`MockVrPose` is the wrong carrier.** It makes
  `XrTracking.isVrEmbodimentActive()` true, which stops the webcam, switches
  to first person and hides the head, turns the whole body with each head
  turn, crouches with the head, and rotates hand offsets by the head
  rotation. A camera source must not set `vrActive`.
- **Outside VR three gates skip tracked hands.**
  `systems/TrackedHandsSystem.ts` runs the desktop point action instead of
  `hands.update`; `systems/RecordingSystem.ts` records `handSources` only
  when `vrActive`; `HandEmbodiment.resolveTrackedHandWorldQuaternion` lets
  only `xr-hand` and `mock` set the wrist rotation from the palm.
- **Fingers need positions, not rotations.** `HandFingerRetargeter` reads
  joint rotations only after calibration, and calibration happens only
  through the `__captureHandCalibrationPose` automation hook. Headset takes
  run uncalibrated: each finger bone swings toward the next joint's
  position. MediaPipe's 21 positions per hand are therefore enough; the four
  finger metacarpals it lacks are read only on the XR path.
- **Nothing rotates the head bone outside the VR body solver.**
- **A lost hand is held forever** (`XrTracking.holdLastValidPose`).
- **`handSources` stays in memory.** Only `recorded` motion spans (frames
  whose source is `xr-hand`, `recording/handSpans.ts`) reach the GLB's
  `HOLOIM_meaning`.
- **`@mediapipe/tasks-vision` 0.10.17 is installed** with `PoseLandmarker`,
  `HandLandmarker` and `HolisticLandmarker`. Only the face model is in
  `apps/capture/public/mediapipe/`.

## Scope

**Included, in three slices:**

1. **Pipeline without models.** A pure converter from pose and hand
   landmarks to a head rotation and two hands of joint positions; a `camera`
   branch in `XrTracking.updateHandTrackingTargets`, active only behind
   `?input=camera` and only while no XR session presents; the three gates
   above opened for it; head and neck rotation; a mirror view; a hold
   timeout; the source value `camera-hand`; an automation hook that feeds a
   landmark stream; and the asserted check on a committed stream, through
   record, export and the viewer.
2. **Live camera.** Pose and hand models on the one stream the face uses,
   loaded only on camera start; a report-only run of the real models on a
   clip; the measurement report.
3. **Trial and recommendation.** A propped phone and a laptop, the report's
   numbers against the bars, and a go or no-go for the PRD.

**Excluded:** full-body capture (legs, locomotion); placing the author in a
real room (world tracking); the back camera; a handheld phone; replying from
inside the portal; designed UI for a camera mode; grabbing objects with
camera hands; hand traces and pointing links from camera hands (shadow
scoring only); iPhone performance tuning. The GLB and the API do not change.

## Acceptance criteria

- [ ] With `?input=camera` and a landmark stream, the avatar's head turn,
  both wrists and the fingers follow; the avatar faces the author as a
  mirror, so the author's right hand moves on the right of the screen and is
  the avatar's right hand.
- [ ] The body does not turn, crouch or walk with the head; the view stays
  third person and the head stays visible.
- [ ] A take recorded this way exports a GLB whose arm, finger, head and
  face tracks move, and it plays in `viewer-web`.
- [ ] Every camera-driven hand frame is recorded as `camera-hand`, never
  `xr-hand` or `mock`. Those frames are not `recorded` motion spans, so the
  GLB carries no hand traces or pointing links from them.
- [ ] A hand that leaves view holds for at most 0.5 s and then eases to
  rest; no arm freezes in mid-air.
- [ ] Entering VR releases the camera and the camera source.
- [ ] A session that never starts the camera downloads no pose or hand
  model.
- [ ] The report states, for the clip and for one propped phone: tracking
  rate; hand coverage and the longest gap; the point-pose score on the
  scripted point, open-hand and fist segments; jitter of the
  detector-filtered index ray at rest (p95, degrees); aim error at marked
  targets (degrees); and thumb-to-index distance in a pinch.
- [ ] The report ends with a recommendation against the bars below.
- [ ] The headset path is unchanged: `pnpm run verify:agent`, the hand
  replay and the face check pass.

### Bars (each tied to an existing consumer)

| Measure | Bar | Source |
|---|---|---|
| Point pose | Score of 0.6 or more on point segments; under 0.35 on open hand and fist | `POINT_SCORE_ENTER`, `POINT_SCORE_EXIT` in `recording/pointSegments.ts` |
| Index-ray jitter at rest | p95 of 3.5 degrees or less | `POINT_ANGULAR_TOLERANCE_DEG` in `recording/PointResolver.ts` |
| Aim error | 3.5 degrees or less resolves thin referents; up to 10 is reported as "large targets only" | Same |
| Hand coverage | 0.9 or more, and no gap over 0.3 s inside a point | `minXrHandCoverage` in `scripts/lib/hand-fidelity.ts`; `POINT_GAP_BRIDGE_SEC` |
| Pinch | Thumb to index under 3 cm when pinched | `PINCH_CLOSED` in `xr/pointPose.ts` |
| Tracking rate | 20 fps on a mid-range phone | Feel only; no code consumer |

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Camera source sets `vrActive`: webcam stops, first person, body turns and crouches with the head | Separate `camera` branch; `vrActive` stays false; criterion 2 asserts it |
| Hands swing around the head on a nod | Hand positions in the body's yaw-only frame, not the head's |
| Left and right swap (raw frames are not mirrored, so MediaPipe's handedness label is reversed) | Assign each hand to the nearest pose wrist; stream with one hand raised asserts the side |
| No metric depth | Scale by shoulder width to the avatar's; aim error and pinch in the report |
| Pose and hand models disagree on the wrist | Placement from pose world wrists, shape from hand world landmarks, joined at the wrist |
| Head yaw and roll from pose landmarks are poor | Head rotation from the face model's transformation matrix |
| Desktop idle animation overwrites arm IK outside VR (not verified in review) | Check first in slice 1; criterion 1 fails if it does |
| A hand lost over the face or out of frame freezes | Hold timeout in the camera branch |
| The asserted check depends on a clip that cannot be committed, or on nondeterministic inference | Asserts run on a committed landmark stream under the manual clock; the real-model run is report-only |
| Three models on a phone CPU | Stagger detection rates; measure; rate in the report |
| 640 by 480 crops hands at arm's length | Report coverage; try a wider request in slice 2 |
| Two `getUserMedia` calls for one camera | One shared stream for face, pose and hands |
| Camera hands counted as `xr-hand` spans, or grabbing objects | New value; `handSpans.ts` and `ObjectInteraction` `TRACKED_SOURCES` unchanged |
| Legacy finger retargeter reads rotations | Default retargeter only |
| A clip of a person committed to a public repository | Clips stay under ignored `output/`; only landmark streams are committed |
| Camera frames leaving the device | Tracking runs on the device; only avatar tracks are recorded |
| About 17 MB of models on every session | Lazy load on camera start |
| Camera denied or absent; hidden tab | Existing `WebcamFace` states and hold |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Fable 5) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Done 2026-11-10 |
| Implementer | Claude (Sonnet) subagent | `apps/capture/src/bodycam/**` (new); narrow edits to `xr/XrTracking.ts`, `xr/HandEmbodiment.ts`, `systems/TrackedHandsSystem.ts`, `systems/RecordingSystem.ts`, `face/WebcamFace.ts`, `face/FaceDriver.ts`, `types/contracts.ts`, `runtime/createCaptureRuntime.ts`, `runtime/automationHooks.ts`, `camera/CameraController.ts` and the canvas style (mirror view only); `apps/capture/scripts/ci-bodycam-playwright.ts` (new), its entry in `scripts/run-xr-checks.ts` and the `test:xr:bodycam` script in `package.json` |
| Independent verifier | Codex (`-p standard`) | Read-only verification; test artifacts only |

## Design decision

A distinct camera source inside `XrTracking`, beside the mock and XR
branches, filling the same per-joint position store and hand targets, so arm
IK, finger retargeting, recording and export are the headset's own. The rest
of the frame stays on the desktop path: rig, body, view.

**The mirror is a view, not the event (lead, 2026-11-10).** The take is
unmirrored: the author's right hand is the avatar's right hand. Only the
author's live view is flipped, as a selfie preview is, with the view camera
in front of the avatar, so the author sees its face and their right hand on
the right of the screen.

Changed by design review (2026-11-10): the first draft reused `MockVrPose`,
computed joint rotations, synthesized metacarpals, asserted on real-model
inference, and claimed a GLB change. All five were wrong; see Background.

Alternatives rejected:

- **XR device-level injection (as IWER replays do).** Needs an XR session;
  iPhone web has none.
- **A separate avatar driver beside `HandEmbodiment`.** Duplicates IK and
  retargeting; camera takes would drift from headset takes.

Open for the implementer to measure in slice 2: `HolisticLandmarker` against
separate pose and hand models.

Left to the PRD: whether camera motion is `recorded` or `inferred` in the
meaning layer (principle 7), and with what confidence.

## Open decisions for the user

1. **Model files: decided (the user, 2026-11-10).** Downloaded from Google's
   MediaPipe model storage
   (`storage.googleapis.com/mediapipe-models`, `float16/latest`) into
   `apps/capture/public/mediapipe/`, beside the face model:
   `pose_landmarker_full.task` (9,398,198 bytes, SHA-256 `4eaa5eb7…cec4ad`)
   and `hand_landmarker.task` (7,819,105 bytes, SHA-256 `fbc2a300…7cde1`).
2. **Ground truth: decided (the user, 2026-11-10).** The user records one
   clip on a propped phone's front camera, following the script below; it
   stays at `output/bodycam/clip.mov` (ignored) and is never committed. If
   the result is borderline, repeat it wearing the Quest, synced on a clap
   and scored by `scripts/lib/hand-fidelity.ts` against the headset's own
   hands.

### Clip script

Setup: phone propped upright at face height; the author about 1 m from the
lens, with head, shoulders and both raised hands in frame; one mark 50 cm to
each side of the lens at lens height. The author reports the three real
distances. Each pose is held for about 3 seconds, in this order:

1. Both open hands still at shoulder height, palms to the lens (jitter at rest).
2. Right hand raised alone (sides).
3. Right index points at the left mark, the right mark, then the lens (aim error).
4. Left index points at the right mark (aim error, other hand).
5. Right index touches the nose, then the right hand touches the left
   shoulder (the join between pose and hand models).
6. Right thumb and index pinch, facing the lens (pinch distance).
7. Both fists, then both hands open (finger curl).
8. Head turns left, right, then nods (head rotation).
9. Right hand leaves the frame for 2 seconds and returns (hold and release).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Follows, mirror, sides, body still | `test:xr:bodycam`: scripted landmark stream through `__setBodycamFrame`, manual clock | Pass (2026-11-10, re-run by a separate check runner): right wrist 111.5 px right of the left on a 960 px screen after the flip; face toward the view camera (dot -0.993); head turns +30 and -30 degrees; root yaw, root move and hips range 0; `vrActive` never true. `output/ci-bodycam/report.json` |
| Take exports and plays | Same check records and exports | Export: pass (arm tracks travel 175 degrees, fingers 72, head 18). **Playing in `viewer-web`: not run**; only the `RUN_E2E_PIPELINE` specs upload and play a take, so this goes to independent verification |
| Source value, no spans | Same check reads `handSources` from the recorder's frames and the GLB's `HOLOIM_meaning` | Pass: 1448 driven hand frames, 0 not `camera-hand`; sources in the take are `camera-hand`, `held`, `none`; `HOLOIM_meaning` absent |
| Hold timeout, VR entry, lazy load | Same check: stream gap; IWER session entry; network log | Hold: pass (frozen 0.533 s, then eases, recovers). Head on a stall: pass (largest step 1.87 degrees). VR entry: pass (source released, canvas unflipped). Lazy load: pending, slice 2 |
| Measurement report | Report-only run: Chromium with the clip as its camera, real MediaPipe; the live page on a propped phone | Pending |
| Headset path unchanged | `pnpm run verify:agent`, `test:xr:hands`, `test:xr:face` | Pass (2026-11-10, same re-run) |
| Proof video | Screen recording of the clip beside the avatar | Pending: `output/` only |

## Known limits after slice 1

- **Pointer input is mirrored against the picture** while the mirror view is
  on: mouse picking, the desktop point aim and screen holds read x from the
  unflipped canvas. Acceptable behind the flag; a designed camera mode needs
  a flip in the projection instead of CSS.
- **A hand at rest settles with the elbow out**, like a hand on a hip: the
  rest target is a fixed point below the shoulder. Slice 2 releases a rested
  arm to the idle animation instead.
- **The stream is scripted, not a person.** MediaPipe's axis convention and
  the head rotation's zero are assumptions until slice 2 runs the real
  models.
- A page without `?input=camera` is covered only by the unchanged hands and
  face checks.

## Physical-device limits

Tracking rate, heat and feel on a real phone, and iPhone Safari's camera
behaviour, need the user's devices. The landmark stream proves the pipeline;
a clip proves the numbers for that clip only.
