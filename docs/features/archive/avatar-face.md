# Feature brief: Face and expressions on avatars

**Lead:** Claude Code (Opus 5.5)  
**Status:** Complete (merged 2026-10-24)
**Layer:** event (the face is part of the recorded body; see
`docs/product/concepts/what-a-hologram-is.md`)

## User outcome

A recipient sees the author's face move on the avatar: blinks, gaze, the jaw
while speaking, smiles, brows, and the other expressions a camera can read.
The expression is recorded with the body, survives export → upload → render,
and plays in the feed, the portal, and AR. Any avatar that carries a standard
face rig (ARKit 52, VRM, Meta, Oculus visemes, Unity/Unreal ARKit-named rigs)
is driven through one canonical expression set; the shipped avatar gets a full
ARKit face.

## Scope

**Included:**

- **Canonical expression set** in a new workspace package `@holoim/avatar-face`:
  the 52 ARKit blendshape names as the canonical channels (the de facto
  superset; MediaPipe, ARKit, Unreal Live Link and most Unity rigs emit them),
  plus the 15 Oculus visemes and per-eye gaze (yaw, pitch).
- **Mappings** from the canonical set to and from VRM 0.x and 1.0 expression
  presets, Meta `XR_FB_face_tracking2` expressions, Oculus visemes, and
  Unity/Unreal facial rig naming (ARKit names with common prefixes and casing,
  Character Creator style `Eye_Blink_L`), with documented approximations
  where a target set lacks a channel (for example `mouthOpen` ← `jawOpen`).
- **Face binding** at avatar load: resolve each canonical channel to the
  avatar's morph targets (every mesh that has them: head, teeth, eyes) and the
  eye bones; unbound channels are reported, never silently dropped.
- **Face sources in capture**, blended per channel by priority:
  1. **Webcam** (desktop 2D and phone browsers): MediaPipe Face Landmarker
     gives ARKit-52 weights; opt-in camera permission, off in VR.
  2. **WebXR eye gaze** in VR on eye-tracking headsets: IWSDK
     `gazeTracking` (Quest Browser `gaze-tracking`, a `targetRayMode ===
     'gaze'` input) drives the eye bones.
  3. **Liveness** whenever a channel has no tracked source: voice-driven jaw
     and mouth from the microphone the recorder already opens, natural blinks,
     and gaze that follows the head with small saccades.
- **Synthesized ARKit blendshapes for the shipped avatar**: a reproducible
  Node build script (gltf-transform, no Blender) adds a tiered set of about 20
  position-only ARKit morph targets to `Wolf3D_Head` — eye blink and squint
  L/R, eye wide L/R, brows (inner up, down L/R, outer up L/R), jaw open, smile
  L/R, frown L/R, pucker, funnel, stretch L/R, cheek puff — so blinks and
  expressions read at feed scale today. The other ARKit channels bind through
  documented approximations (`tongueOut` has no tongue mesh and stays unbound). No suitably
  licensed ARKit avatar was found (three.js `facecap.glb` has no stated
  license; others are study-only or unclear).
- **Recording and export** through the existing morph path: the driven morph
  influences and eye-bone rotations are already captured per frame and written
  as GLB animation tracks; the viewer plays them through its `AnimationMixer`.
- **Proof video and checks**: a face replay check that drives the capture app
  from a recorded expression fixture and writes an mp4 of the face plus a
  numeric report, and a pipeline check that the exported GLB plays the same
  expression in the viewer.

**Excluded:**

- Native Meta face tracking (`XR_FB_face_tracking2`): WebXR exposes no facial
  expression data, so headset expressions beyond gaze wait for a browser API.
  The mapping table is ready for it.
- Phone-as-face-camera while a headset drives the body (IDEA-078, TODOS): this
  feature provides the face pipeline it needs, not the dual-device session.
- A captured face texture on the avatar head (PRD-008's second rendering).
- Provenance marking of face sources, and inferred emotion or enhancement.
- Quick Look USDZ face playback beyond what the converter already carries.

## Acceptance criteria

- [ ] `@holoim/avatar-face` defines the canonical set and the mappings above;
  the binder resolves each standard's names (with prefixes and casing) to
  canonical channels, using only documented approximations.
- [ ] The shipped avatar binds the tiered set and both eye bones, approximates
  the remaining ARKit channels, and reports what is unbound; an avatar
  with only `mouthOpen`/`mouthSmile` binds jaw, smile, and gaze and reports the
  rest as unbound; an avatar with no face binds nothing and nothing fails.
- [ ] In desktop 2D with the webcam on, tracked weights drive the avatar face;
  with no face in view the face falls back to liveness within 0.5 s, without a
  pop (weights ease, never jump).
- [ ] In VR with `gazeTracking` available, the avatar's eyes follow the WebXR
  gaze ray; without it, gaze follows the head with saccades. Verified in IWER
  emulation; physical Quest Pro check listed below.
- [ ] Speaking into the microphone opens the jaw in proportion to voice level;
  silence closes it; blinks occur at a natural rate (roughly every 2–6 s).
- [ ] A recorded expression replays in capture, exports, uploads, and plays in
  the viewer feed with the same morph weights (within 0.05) at sampled times.
- [ ] A proof video shows the face replay (blink, smile, jaw, brows, gaze
  left/right, visemes) on the shipped avatar, framed on the face.
- [ ] Body, hand, locomotion and pointing checks still pass; the avatar GLB
  grows by less than 1 MB, and the report lists export time and recorded face
  bytes per minute against the 25 MB upload limit.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Camera permission denied, no camera, or MediaPipe model fails to load | Webcam source reports unavailable; liveness drives the face; overlay shows state. Smoke check with a denied/fake camera. |
| Face leaves the frame or tracking confidence drops mid-recording | Per-channel ease back to liveness within 0.5 s; replay fixture includes a dropout. |
| Webcam and liveness both write a channel | Single blender with per-channel priority; liveness only fills untracked channels. |
| Voice drives the jaw while the webcam also tracks it | Webcam wins on jaw when tracked; voice only in its absence. |
| Mirroring: camera image is mirrored, so left/right swap | Fixed mapping (camera-left = author's right) proven by the fixture's left-only blink and look-left. |
| Avatar with different morph names, prefixes, or casing | Name normalization in the binder; per-standard fixtures in the package test. |
| Morph target on several meshes (head, teeth, eyes) | Binder drives every mesh carrying the name. |
| Eye bones also aimed by the body solver (`VrBodySolver` eye midpoint) | Face gaze applies after the body solve, as a local rotation on the eye bones only; body check still passes. |
| Synthesized shapes deform the wrong vertices (hair, teeth through lips) | Region masks from landmarks, bounded displacement, contact sheet review, and teeth/eye meshes handled explicitly. |
| Export drops tracks for meshes whose influences never change | Exporter already writes every bound morph; pipeline check reads weights back from the GLB. |
| Recording size or export time grows with 52+ channels on 4 meshes | Measure export time and GLB size in the report; resample like existing morphs. |
| Old recordings and old avatars | No contract change to `RecordingFrame`; avatars without faces bind nothing. |
| Two eye-tracking descriptor names across runtimes | IWSDK already requests both (`gaze-tracking`, `eye-tracking`). |
| `gazeTracking` required on a device without eye tracking fails the session | Requested as optional only. |
| Gaze input source treated as a pointer or controller | Verify IWSDK and `XrTracking` skip `targetRayMode === 'gaze'` (handedness `none`). |
| Replaying a recording while the webcam runs overwrites the replayed face | Replay suspends live face sources. |
| Eye bone pivot off the eyeball centre shifts the eye when rotated | Binder asserts the eye bone sits at the eye mesh centroid; gaze set absolutely each frame (rest × gaze), never accumulated. |
| MediaPipe GPU delegate missing (headless Chromium, many phones) | Fall back to the CPU delegate; WASM and model self-hosted, no CDN. |
| Hidden tab stalls the tracker | Hold the last value, then ease to liveness. |
| Lids pushed through the eyeball by a straight translation | Lids move along the eyeball sphere; build report asserts no lid vertex inside the sphere and 0 vertices moved outside each mask. |
| USDZ conversion with many more blendshapes | Run the converter on a face recording in the pipeline check. |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer | Claude Code (Opus lead, Sonnet subagents per module) | `packages/avatar-face/`, `apps/capture/src/face/`, capture wiring (`createCaptureRuntime.ts`, `BodyPoseSystem.ts` ordering, overlay toggle), `apps/capture/scripts/` face checks, avatar build script and asset |
| Independent verifier | Codex (different vendor), or a fresh Claude session if Codex is unavailable | Read-only verification; test artifacts only |

## Design decision

Reviewed by the `design-reviewer` subagent; its changes are folded in.

- **Frame order** in `BodyPoseSystem`: locomotion mixer, body solve, face
  apply (morph weights, then eye-bone rotations), then `captureFrame`, then
  render. Gaze rotates the eye bones about their own pivots, which leaves the
  eye positions `VrBodySolver` reads unchanged.
- **Gaze lives on the eye bones only.** Canonical `eyeLook*` becomes yaw and
  pitch per eye, clamped to about ±30° yaw and ±25° pitch; looking down or up
  adds a small lid weight. The single WebXR gaze ray is intersected about 2 m
  out (or at a scene hit) and both eyes aim at that point, which gives
  vergence. No eye morphs are added.
- **Webcam mirroring** is fixed by one rule at the source boundary (MediaPipe
  weights are image-relative). Only a real wink video can prove it; that is a
  physical check unless a licensed clip is supplied.
- **Synthesis method**: regions seeded from the eye-bone centres and from the
  existing `mouthOpen` and `mouthSmile` deltas (their non-zero vertices are
  the mouth, jaw and corners), smooth radial falloff restricted to the
  front-facing side, bounded displacement, a numeric build report, and a
  contact sheet. Teeth reuse their existing `mouthOpen` for `jawOpen`.
- **Provenance is excluded**: the user decided that body-read synthesis (IK
  locomotion, and here liveness) is part of the performance.

- ARKit 52 is canonical because every source this feature uses emits it and
  every other standard maps onto it with small, documented approximations.
- Expression is carried by the avatar's own morph tracks in the GLB, not a new
  data channel, so the viewer and the upload API change nothing.
- The webcam tracker is `@mediapipe/tasks-vision` with the `face_landmarker`
  model (about 4 MB), loaded only when the user turns the camera on.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Mappings and binding | `pnpm --filter @holoim/avatar-face test`: only the name resolutions the binder uses, chosen from the failure table | 8 tests pass; the face check binds 21 head targets plus teeth and eye legacy targets, both eye bones (sphere-fit pivot offset 3.6 mm, the cornea bulge) |
| Synthesized shapes | `pnpm --filter @holoim/capture run build:avatar-face` | 21 shapes pass (blink moves 75–77 vertices, max 10.9 mm; 0 vertices inside the eyeball); rebuild is byte-identical; avatar 1,257,168 → 1,827,328 bytes (+570 KB) |
| Face performance, export, proof video | `FACE_VIDEO=1 pnpm --filter @holoim/capture run test:xr:face`: a scripted ARKit performance (neutral, left and right winks, smile, jaw, brows up, frown, pucker, cheek puff, visemes aa and U, looks left/right/up/down) through the automation input in an IWER VR session, recorded and exported | every segment's targets within 0.05; visemes route to jaw and lips; lids follow a downward look; exported GLB weights match the avatar exactly (max error 0); export 1.1 s for 23.8 s; face animation 525 KB per minute; `output/ci-face/face.mp4`, `face-sheet.jpg`, `face-report.json` (proof video kept out of git) |
| Upload and render | `pnpm run test:smoke:pipeline` (capture-to-viewer spec) uploads a capture GLB with the new head targets and renders its facial meshes in the viewer | see Regressions; per-weight sampling in the viewer is not separately asserted: the viewer plays standard glTF morph animation, and the export side is checked weight-for-weight |
| WebXR gaze | IWER Quest Pro gaze sweep in the same check | gaze source `xr-gaze`; eyes turn with the ray (±15°), clamp at 30° for a 60° ray, look up for 12° up; release crossfades (largest step 0.05) |
| Liveness | 7 s after gaze drops, in the same check | 2 blinks, saccade range 6.1° |
| Webcam fallback | same check, Chromium fake camera (no face in view) and a denied camera | `no-face` (GPU delegate) and `denied` both leave liveness driving the face; button labels "no face in view" / "permission denied" |
| Regressions | `pnpm run verify:pr` (with `test:xr:capture`, which now includes `face`) | doctor, lint, typecheck, unit tests and builds pass; pipeline 6/6 (capture-to-viewer upload and render with the new head targets); portal; viewer XR 9/9; all 8 capture XR checks pass in 62 s in parallel. Knowledge atlas flaked once (0 cards rendered) and passed 7/7 on rerun |

### Independent verification

Codex (`-p deep`) verified commit `d7b9758` against this brief. Its sandbox
blocked Chromium, so it probed the source with synthetic rigs and mocked
browser APIs, and reported seven defects, all fixed:

1. Eye bones and eyeLook morphs both carried the gaze. `FaceRig.apply` now
   gives the gaze to one carrier: bones when both eyes have them, otherwise
   eyeLook morphs.
2. A combined blink beside per-eye blinks double-closed the lids. A target
   that only combines channels the same mesh shows one by one stays at 0
   (`suppressedTargets` in the report).
3. Morph-only rigs never moved their eyes and could not take WebXR gaze.
   They now get eyeLook weights from the gaze, aimed from the head bone.
4. Turning the camera off during startup re-enabled it and leaked the
   stream. Each start is invalidated by `stop()` and releases late arrivals.
5. Entering VR left the camera running. The driver now stops it.
6. A lost face took 0.57 s to reach liveness. The hold is now 0.2 s, plus
   the 0.25 s crossfade: 0.45 s.
7. The report omitted channels the avatar cannot show. It now lists
   `unroutableChannels` and `gazeBy`.

`apps/capture/src/face/face.test.ts` covers 1–5 and 7 with synthetic rigs;
the shipped avatar cannot reach them through the XR face check.

## Physical-device limits

- WebXR eye gaze on a physical eye-tracking headset (Quest Pro), including
  the eye-tracking permission prompt at session start: IWER emulates the gaze
  input only.
- Real webcam tracking in a phone browser.

Validated by the user on a laptop on 2026-10-24, through the live capture
site and a recording played in the live viewer: webcam tracking, left/right
on a real wink (`SWAP_SIDES` stays `false`), and the microphone-driven jaw
with real speech.
