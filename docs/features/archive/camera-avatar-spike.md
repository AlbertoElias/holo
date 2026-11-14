# Feature brief: Camera-driven avatar (evaluation spike)

**Lead:** Claude (Fable 5)  
**Status:** Implementing (slices 1 and 2 built and re-run independently, 2026-11-10; first numbers from the user's clip, 2026-11-11: hand coverage and point detection meet the bars; ray jitter meets the bar only with a wrist-to-tip ray, which the aim clip must confirm; head readings are correct, and a turn past the face model's range now keeps its yaw from the pose; **aim error is unresolved**, and a lens-only aim clip is recorded for it (2026-11-14); then slice 3)
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
| Hold timeout, VR entry, lazy load | Same check: stream gap; IWER session entry; network log | Hold: pass (frozen 0.533 s, then eases, recovers). Head on a stall: pass (largest step 1.87 degrees). VR entry: pass (source released, canvas unflipped). Lazy load: pass (no `.task` request before the camera starts; face, pose and hand models load with status 200 after; with Chromium's test-pattern camera nothing throws and no hand is driven) |
| Measurement report | `pnpm --filter @holoim/capture run bodycam:report <clip> [config.json]`: every clip frame through the real models (frame-stepped), no assertions; `--realtime --headed` for the rate | Tool built. **No person has been measured.** On the avatar's own video as a stand-in (384 frames): pose found in 378; hands in 3 to 17, so coverage, point score, jitter, pinch and aim are unexercised; face in 0 in these runs. Rate on an M1 Max with a real GPU: 42.7 landmark frames/s (says nothing about a phone) |
| Headset path unchanged | `pnpm run verify:agent`, `test:xr:hands`, `test:xr:face` | Pass (2026-11-10, same re-run) |
| Proof video | Screen recording of the clip beside the avatar | Pending: `output/` only |

## Known limits after slice 1

- **Pointer input is mirrored against the picture** while the mirror view is
  on: mouse picking, the desktop point aim and screen holds read x from the
  unflipped canvas. Acceptable behind the flag; a designed camera mode needs
  a flip in the projection instead of CSS.
- **A rested arm now fades back to the idle animation** (slice 2); checked
  only through the scripted lost-hand segment.
- **Hands have never been seen working on real model output.** A rendered
  avatar is a poor subject: too few hands were found to verify the hand and
  pose world axes or the pitch sign. Side assignment by nearest pose wrist
  was right in 22 of 23 found hands.
- **Head tracking on real output is unresolved.** An early real-time run
  found the avatar's face in about half the frames, with yaw signs matching
  its turns (about -18 and +29 degrees for a 30 degree turn each way) and a
  zero of about -8 degrees pitch. The later frame-stepped and headed runs
  found no face at all, unexplained. Check this first on the user's clip.
- **Headless Chromium runs the models on software GL** at 2 to 6 frames/s,
  so only the frame-stepped mode gives accuracy numbers, and only a headed
  run or a device gives a rate.
- Not compared: `HolisticLandmarker`; a camera request wider than 640 by 480.
- A page without `?input=camera` is covered only by the unchanged hands and
  face checks.

## Results on the user's clip (2026-11-11)

One 80 s clip (iPhone front camera, portrait, propped; 2,411 frames at 30 fps),
frame-stepped on an M1 Max GPU. The clip stays in ignored `output/bodycam/`.
Distances were estimated, not measured (about 1 m, 0.5 m, 0.5 m). The clip has
no aim at the lens. Report only; nothing here is a check.

| Measure | Result | Bar | Reading |
|---|---|---|---|
| Body found | 2,411 of 2,411 frames | - | Good |
| Hand coverage while the hand is in view | 1.00 in every pose segment, longest gap 0.03 s | 0.9 | Meets |
| Sides (step 2) | right hand 66 of 66 frames, left 0 | - | Right: the user confirmed the brace is on the left wrist, so the clip is unmirrored |
| Pose model against the hand model's own label | agree on 2,127 of 2,211 hands | - | The "label reads the opposite" note in the report is wrong on this clip |
| Point score while pointing | median 1.0; 0.6 or more in 95 to 100% of frames | 0.6 enter | Meets |
| Point score on open hands, fists, pinch | 0 | under 0.35 | Meets |
| Pinch distance | median 1.8 cm, min 1.3 cm (open hand 6.6 to 9.7 cm) | 3 cm | Meets |
| Index ray jitter while pointing | p50 2.1 to 5.3 deg, p95 5.7 to 20 deg | 3.5 deg tolerance | Misses |
| Index ray jitter, open hand at rest | right p50 1.4, p95 3.1 deg; left (wrist brace) p50 3.0, p95 8.6 deg | 3.5 deg | Borderline |
| Aim error | 26, 41 and 46 deg median on the three aims | 3.5 deg | Not established: far beyond what rough distances explain, so either the ray axes or geometry in the report are wrong or the pointing did not follow the assumed mark layout |
| Head found | face 2,242 of 2,411 frames; the other 169 by the pose fallback (2026-11-11) | - | The face model lost the turn to the author's left (3.7 s, a full profile) and a hand crossing the face (2 s); see Head below |
| Head rotation | turn to the author's right reads +62 deg yaw; facing the lens (66 to 68 s) reads yaw -2, pitch -1 to +1 | - | Correct: the 16 to 24 deg pitch seen elsewhere is the author looking down at the screen or hands; see Head below |
| Hand leaves and returns | lost within the segment, back at 0.92 coverage, 0.2 s gap | - | Works |

Tracking rate was not measured on this clip (frame-stepped). Open after this
run: the aim geometry and ray axes (an aim at the lens is the clean test), the
head zero and left-turn loss, jitter filtering, and anything on a phone.

**Ray axes checked (2026-11-11).** The report now prints each aim's mean index
ray and mean fingertip-to-target direction (x image right, y down, z away from
the lens). The ray's signs match the picture on every pose: toward the author's
right for the right mark (x -0.57), toward the left for the left mark
(x +0.88), up for open hands (y -0.83), toward the lens for the pinch facing it
(z -0.99, about 8 deg off the lens axis). So the axes are right, and the model
can report a ray along the lens axis. The aim error is all one way: the finger
reads 34 to 67 deg off the lens axis where the assumed layout expects 17 to
22 deg. That is either the author pointing more sideways than marks 0.5 m
beside the lens at 1 m, or the hand model flattening depth on a hand seen
side-on; this clip cannot tell them apart.

### Ray jitter study (2026-11-11)

The report's `rayJitterStudy` section, re-measured on the same clip's saved
landmarks (`--from-landmarks`). Jitter here is the p95 deviation of the
filtered ray from the raw ray's own centred 1 s moving mean, inside each
segment trimmed by 0.3 s at each end. The old figure (deviation from the
whole segment's mean) also counted the hand still moving into the pose and
its slow drift; it stays in the report beside the new one. Lag still counts
as error, so very long filters score worse. Step lag is a synthetic 40 degree
aim change settling to within 3.5 degrees at 30 frames per second. Aim uses
the clip's rough, unmeasured mark layout, so it only ranks the rays.

| Ray, filter | Worst pointing hold p95 | 3a / 3b / 4 | Worst open-hand rest | Step lag | Aim median 3a / 3b / 4 |
|---|---|---|---|---|---|
| knuckle to tip, none | 7.9 | 7.9 / 4.7 / 3.6 | 8.9 | 0 s | 26 / 41 / 46 |
| knuckle to tip, 0.09 s (the headset path today) | 5.2 | 5.2 / 5.0 / 2.4 | 7.0 | 0.20 s | 26 / 41 / 46 |
| knuckle to tip, 0.25 s (best of its ray) | 4.7 | 4.7 / 3.5 / 2.3 | 4.3 | 0.60 s | 25 / 41 / 46 |
| line fitted through the four index points, 0.25 s | 3.9 | 3.9 / 3.5 / 2.4 | 4.3 | 0.60 s | 26 / 43 / 47 |
| **wrist to tip, 0.09 s** | **3.4** | 3.4 / 2.8 / 1.1 | 2.2 | 0.20 s | 9 / 30 / 30 |
| wrist to tip, One Euro 1 Hz, beta 0.5 | 3.3 | 2.4 / 3.3 / 0.9 | 1.7 | 0.20 s | 9 / 30 / 30 |
| wrist to tip, 0.25 s | 2.6 | 2.6 / 2.0 / 1.1 | 2.0 | 0.60 s | 9 / 30 / 30 |
| eyes to tip (pose model), 0.15 s | 3.9 | 2.3 / 3.9 / 3.9 | 6.8 | 0.37 s | 59 / 54 / 44 |

Reading:

- **Jitter can meet the bar, but not with the headset's ray.** Knuckle to
  tip misses with every filter tried, at best 4.7 degrees at three times
  today's lag; a fitted line is no better. Wrist to tip meets 3.5 degrees
  with today's 0.09 s filter and lag, and holds at 2.6 at 0.25 s.
- **Wrist to tip is a different direction**, 18 to 24 degrees from the
  knuckle ray. In the overlay it tilts up from the visible finger. The marks
  sit at lens height, above the hand, so that may be nearer the real aim. On
  the rough layout it reads 9 to 30 degrees of aim error against 26 to 46
  for knuckle to tip. Which ray is right is the aim question, so the measured
  clip decides between them and the report measures both on it.
- Low-pass longer than 0.25 s gets worse (lag behind the hand's drift).
  One Euro is no better than a plain low-pass here. A ray from the eyes
  through the fingertip rests on the pose model's depth, its weakest axis,
  and is worse at both jitter and aim.
- Settling from the right mark to the left mark takes 1.5 to 1.8 s with
  every ray and filter, mostly the hand's own move (1.53 s unfiltered); a
  0.25 s filter adds 0.1 to 0.25 s.
- Limits: one author, one clip, every frame through the models at 30 fps on
  an M1 Max GPU. A phone runs the hand model less often, which this does not
  test. A different ray for camera hands would be a PRD decision; the
  headset path is unchanged.

### Head (2026-11-11)

Re-measured from the saved landmarks (`--from-landmarks`), with face crops of
the clip checked by eye.

- **No zero offset.** The report's "facing the lens" figures came from
  segments where the author was not facing the lens. Crops at the frames with
  16 to 28 deg pitch show the author looking down at the screen or the hands;
  where the author does face the lens (66 to 68 s) the face model reads yaw
  -2 and pitch -1 to +1. The yaw differences between segments are real head
  turns. An off-axis perspective error was ruled out too: the nose sits 1 to
  3 deg from the image centre. The report now gives the head's median yaw and
  pitch per segment instead of one "facing" figure.
- **The left-turn loss was a turn past the face model's range.** The face
  is tracked down to -54 deg yaw at 55.9 s, lost from 55.93 to 59.57 s, and
  back at -42 deg. The pose kept the nose and ears throughout: the nose sat 1.3
  to 2.4 ear spans from the ear midpoint (a full profile), against 1.0 to 1.3
  on the right turn that the face model held at +62 deg. Nothing covered the
  face (no hand in frame).
- **Fix: head yaw from the pose when the face is lost.**
  `headYawFromPose` in `convert.ts` reads yaw from the nose's offset from the
  ear midpoint over the ear span (-53 deg per span, clamped to 90 deg), with
  pitch and roll level. Against the face model on all 2,242 face-tracked
  frames it fits with r 0.96, a median error of 2.4 deg and a p95 of 8.2 deg.
  It joins the face model's reading without a jump: -54 then -52 deg as the
  face is lost, and -44 then -42 deg as it returns. All 169 face-lost frames
  get a yaw: -90 deg for the left turn, 3 to 15 deg while the hand crossed the
  face. Before this, the avatar's head eased back to straight ahead within
  0.4 s and stayed there for the rest of the turn.
- Limits: the slope was fitted on this author and clip. Pitch is not read
  from the pose, so a lost face holds the head level. The fallback runs only
  when the face model finds no face, so the face model's own range is
  unchanged.

**Next steps, in order** (a fresh session on a standard-tier model can take
these from this brief; the clip and `clip.json` are in `output/bodycam/`, the
saved landmarks in `apps/capture/output/bodycam-jitter/landmarks.json`):

1. Settle aim on the lens-only aim clip (below). Measured 2026-11-14: fails
   3.5 deg (see "Aim clip result"); the go/no-go must weigh that. The report's aim study
   (2026-11-11) measures the knuckle and wrist rays, each as the hand model
   gives it and perspective-corrected (turned by the line of sight to the
   hand in the picture, in case the model reads the finger relative to its
   own view of the hand). On the first clip's rough layout the correction
   helps the knuckle ray on one aim (26 to 15 deg) and hurts the wrist ray
   (10 to 20 deg); the two crossing aims miss by 29 to 45 deg, almost all of
   it in yaw. Rough geometry cannot tell tracking error from layout error, so
   the new clip aims only at the lens, whose direction needs no measurement.
   Pick the ray, and whether to correct it, on that clip.
2. Real-time rate and a trial on a phone, independent verification, then the
   go/no-go.

**Aim clip protocol (lens only, 2026-11-14).** Measured marks were too much
setup while the user travels, so every hold points the index fingertip at
the phone's lens. The direction from the fingertip to the lens is the
reverse of the camera's line of sight to the fingertip's image point, so it
needs only the field of view (default: iPhone 15 Pro main camera, 1x, 4K
portrait, 45.7 by 73.7 deg; `camera` in the config overrides it). Distance,
lens height and room layout drop out. A segment with `"target": "lens"` uses
it; the fingertip's image point is the hand model's landmark 8, falling back
to the pose's index point. The take: phone propped upright, rear camera 1x,
author 1.5 to 2 m away facing it, each hold about 3 s with the hand dropped
between. Right hand: straight ahead (arm out at shoulder height), out to the
right (arm about 45 deg right, finger turned back in), across the body
(hand in front of the left shoulder), high (above the head, pointing down),
low (at the hip, pointing up). Then the left hand, mirrored. The clip is
`output/bodycam/aim.MOV` (ignored, never committed or copied outside
`output/`; 47.8 s, 4K, 59.94 fps, rotation -90). The user gave no hold
times: find the ten holds from the tracking (point score at or above 0.6,
sustained, per hand, in order), write a config with one `lens` segment per
hold, and re-measure with `--from-landmarks`.

**Aim clip result (2026-11-14): fails the 3.5 deg target by a wide margin.**
Frame-stepped run (all 1,434 frames, GPU) in
`apps/capture/output/bodycam-aimclip/`; holds in `output/bodycam/aim-holds.json`;
re-measured in `apps/capture/output/bodycam-aimclip-holds/report.json`.

- The point score cannot find the holds. It passes 0.6 only for a moment as
  each hand rises, then falls to about 0 for the rest of the hold. A finger
  aimed into the lens is foreshortened, and the hand model reads it as curled.
  The holds were found from where the pose wrist sits still instead (image
  speed under 0.06 per s), and were checked by eye on a 1 fps sheet. The
  author did them in the order straight, out, high, low, across, not the
  protocol's order. Right: 4.25-5.6, 6.75-9.0, 10.25-12.8, 15.0-17.6 and
  19.25-22.6 s. Left: 24.0-26.15, 27.0-30.9, 32.25-35.3, 36.75-40.6 and
  41.5-44.4 s.
- The left straight and left out holds have almost no hand-model frames. The
  left out hold sits at the frame's edge.
- Median error in deg (signed yaw/pitch). With score 0.35 or more, only 38
  frames qualify, in four holds:

  | Hold (n at 0.35) | knuckle | knuckle corr. | wrist | wrist corr. |
  |---|---|---|---|---|
  | R1 straight (22) | 14.7 (-14/1) | **8.6** (-8/1) | 25.9 (-24/10) | 20.2 (-17/10) |
  | R2 out (3) | 21.7 | 32.0 | 32.0 | 23.0 |
  | R5 across (10) | 15.6 (0/15) | 24.0 (11/22) | 31.7 (-28/8) | 24.2 (-19/15) |
  | L5 across (2) | 20.2 | 8.2 | 21.8 | 32.9 |
  | pooled, median / p95 | 15.2 / 22.5 | 8.8 / 33.7 | 26.3 / 32.8 | 20.9 / 28.7 |

  With no score floor (513 frames, eight holds), the knuckle ray flips
  (median 88 deg, p95 126 deg). On the high, low and across holds it points
  away from the lens: 92 to 123 deg raw, 97 to 143 deg corrected. The wrist
  ray holds better: 36.9 deg median and 55 p95 raw, 29.9 and 40.6 corrected.
  Its yaw is within 1 deg on average, and its pitch errs about 11 deg upward.
- Verdict: no ray comes near 3.5 deg. The best is the corrected knuckle ray,
  8.6 deg on the one hold the hand model reads as a point. Single-camera hand
  tracking cannot read where a finger aims along the camera's own axis.
  Aiming at the viewer likely needs another cue (head or eye-to-fingertip,
  not measured here), or pointing kept off the lens axis.
- Report fixes: the signed yaw is now wrapped to plus or minus 180 deg (the
  lens sits near yaw 180, where the raw difference read 336 to 346 deg). The
  aim study now gives every hold at score floors 0.35 and 0, plus pooled
  median and p95.

Done on 2026-11-11: ray jitter and the head (above), and the script's own server start.
Two script faults found on this first long clip are both fixed. A whole clip
handed to the browser through `route.fulfill` exceeded the 100 MB
control-pipe limit and killed the browser; the capture server now serves the
clip from its build directory. The script's own server start timed out in
`waitForServer` although the server was up, because the poll's own `fetch`
refused the test build's self-signed certificate. The script now sets
`NODE_TLS_REJECT_UNAUTHORIZED=0` in its own process, as `run-xr-checks.ts`
does, and a run with the variable unset started its server and measured
every frame.

## Running the report on the clip

From `apps/capture`, with the clip at `../../output/bodycam/clip.mov`:

```
pnpm run bodycam:report ../../output/bodycam/clip.mov ../../output/bodycam/clip.json --video
```

`clip.json` holds the three distances and the segment times read from the
clip: `{ "distances": { "authorToLensM", "leftMarkM", "rightMarkM" },
"segments": [{ "label", "startSec", "endSec" }] }`. Add `--hflip` if the
clip was saved as a mirrored selfie preview. The aim-error geometry (marks in
the lens plane, "left" meaning the author's left) is the implementer's
reading of the script and has not been exercised.

Every run writes `landmarks.json` beside `report.json`: the models' output
for every frame. Re-measure it in about 2 s, without the browser or the
models, after changing only the measuring code:

```
pnpm run bodycam:report ../../output/bodycam/clip.mov ../../output/bodycam/clip.json --from-landmarks output/bodycam-jitter/landmarks.json --out output/bodycam-remeasure
```

## Physical-device limits

Tracking rate, heat and feel on a real phone, and iPhone Safari's camera
behaviour, need the user's devices. The landmark stream proves the pipeline;
a clip proves the numbers for that clip only.
