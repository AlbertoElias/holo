# Feature brief: Self-resolving pointing

**Lead:** Claude Code (Opus)  
**Status:** Verifying (emulation complete 2026-10-23; physical-device evidence pending)
**Layer:** Meaning (read); see `docs/product/concepts/what-a-hologram-is.md`

Product decision, targets, and trial: [PRD-022](../product/prds/PRD-022-self-resolving-pointing.md)
(approved 2026-10-22, amended after this brief's design review). This brief
owns scope, acceptance, and evidence while the feature is in flight.

## User outcome

While the author of a hologram points, the thing they pointed at lights up in
the feed portal on phone and desktop, with a faint ray from their fingertip.
In a headset the author just points with tracked hands; on desktop they hold
the point action and the avatar's arm aims where they aim. When capture is
unsure, nothing lights up.

## Scope

**Included:**
- Capture, headset: detecting a deliberate point from tracked XRHand joints
  (`source === 'xr-hand'` only) while recording, keeping a filtered per-frame
  fingertip ray and pose score with the take.
- Capture, desktop: a held point action (right mouse button while
  pointer-locked, F as a trackpad fallback). While held, mouse Y drives an aim
  pitch over the first-person range in both views; the aim ray starts at the
  avatar's eyes; a crosshair (chrome, never recorded) is drawn where that ray
  lands; the arm aims through `ArmIkSolver` with a fixed index-extended finger
  pose; the aim ray is recorded per frame.
- Capture, export: segmenting points, resolving them against the bubble's
  clipped meshes (and, for headset points, avatar bone capsules), and writing
  the v0 meaning-layer record as an optional root glTF extension, plus an
  inferred motion span for the synthesized desktop arm.
- A shared workspace package holding the extension schema and a VRM 1.0
  humanoid bone table with Mixamo aliases, used by both apps.
- Viewer-web: reading the extension in the feed card, showing the referent
  highlight and fingertip ray during each span, styled by provenance, with a
  highlights toggle in the portal controls.
- E2E evidence: a headset replay fixture, a synthetic IWER pointing take, a
  scripted desktop take, and the real export → upload → render pipeline.

**Excluded:** gaze; controller points; desktop pointing at the author's own
body; author review or dismissal of links; highlights in the headset viewer,
immersive AR, and Quick Look (they ignore the extension); the Follow camera
(PRD-030); styling inferred motion on the avatar, provenance inspection, and
the "unedited" badge (PRD-018); a second mark kind; re-resolving exports made
before this feature; segmentation beyond the bubble's per-object meshes (a
tree made of several cones highlights the cone that was hit).

## The record (v0)

Root extension `HOLOIM_meaning`, `version: 0`, listed in `extensionsUsed`
only, written only when the take has marks or spans (takes without points
export byte-identical to today):

```jsonc
{
  "version": 0,
  "marks": [{
    "kind": "link",
    "anchor": {
      "from": { "bone": "rightIndexDistal", "node": 41 },
      "to":   { "node": 7, "point": [0.02, 0.31, -0.10], "radius": 0.15 }
      // or   { "bone": "leftHand", "node": 33, "point": [...] }
    },
    "span": { "start": 2.84, "end": 4.10 },          // seconds from the first frame
    "provenance": { "value": "inferred", "confidence": 0.86 } // or { "value": "recorded" }
  }],
  "spans": [{
    "kind": "motion",
    "bones": ["rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand"],
    "span": { "start": 1.2, "end": 2.0 },
    "provenance": { "value": "inferred" }
  }]
}
```

Bones carry the humanoid name (meaning) and the node index (lookup). Points
are local to the anchor's node or bone. `radius` is present only for hits on
large undivided geometry (floor, walls).

## Acceptance criteria

Headset (emulated replay):
- [ ] Replaying `headset-open-fist-pinch-point-wave-reach.json` through the
  real WebXR input path, recording, and exporting yields exactly one link per
  labelled point segment, with `from` on the pointing hand's fingertip and
  provenance `inferred` with a confidence in (0, 1]. (This fixture was recorded
  in a real room, so what its ray hits in the replay scene is arbitrary: it
  proves timing and silence, not the referent.)
- [ ] The same export has no link during the open, fist, pinch, wave, or
  reach segments.
- [ ] Each link's span starts within 0.5 s of the labelled deliberate start
  and ends within 0.5 s of the labelled end.
- [ ] A synthetic IWER take in a generated test scene (loaded with `?scene=`)
  that points at a named target for 1 s, then at the avatar's own other hand,
  then at a second named target ("this one … and that one" in one held
  point), then into empty sky, yields links on target 1, the humanoid hand
  bone, and target 2, in that order, and nothing for the sky.
- [ ] A point shorter than the dwell threshold yields no link.

Desktop (scripted take):
- [ ] Holding the point action shows the crosshair where the aim ray lands and
  moves the avatar's arm to aim along it, in both first- and third-person
  views, including above eye level; releasing (mouseup, keyup, blur, page
  hidden, or pointer lock lost) ends the hold and returns the arm to its
  locomotion pose. The crosshair is not in the export.
- [ ] A scripted take that holds the point action on target A, releases,
  turns, then holds on target B yields two links, A then B, with provenance
  `recorded`, and two inferred motion spans covering the arm during each hold.
- [ ] Holding the point action at the sky yields no link and no span-linked ray.
- [ ] The real binding (right button under pointer lock) is exercised at least
  once, not only the mock-input hook.

Record and compatibility:
- [ ] The extension matches the schema above, is in `extensionsUsed` and never
  in `extensionsRequired`.
- [ ] A take without points exports without the extension, and every existing
  export renders unchanged in the feed (existing pipeline specs pass).
- [ ] A GLB with the extension uploads through viewer-api and downloads
  byte-for-byte, and converts to USDZ as before.

Viewer:
- [ ] During each link's span the referent shows the highlight and a faint
  ray from the animated `from` fingertip to the hit point; outside every span
  nothing shows. Visibility follows the primary action's time, so it is right
  after looping, pausing, and resuming.
- [ ] Inferred links use the lighter inferred style; recorded links are plain.
- [ ] The highlight stays on the referent at any portal orbit and zoom, and
  fades at the bubble edge like the rest of the scene.
- [ ] The highlights toggle hides and shows them, has an accessible name, and
  works by keyboard; it resets when the card becomes inactive, like other
  portal state.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Relaxed or half-curled hand reads as a point | Pose score needs index extension and the other three curled; hysteresis and a dwell; fixture's open, wave, and reach segments stay silent |
| Pinch reads as a point | Pinch distance excludes a point; fixture's pinch segment stays silent |
| Both hands point at once | Each hand segments separately; `from` names the hand |
| Controller input reads as a point | Only `xr-hand` samples count |
| Tracking dropout or jitter splits one point into many | Gaps under a hold-over time bridge; ray filtered before resolution |
| "This one … and that one" in one held point | A new segment starts when the referent changes and stays changed for the dwell |
| Ray hits the pointing arm or hand | That arm's chain and fingers excluded from capsules |
| Finger ray drifts a few degrees off a thin object | Angular tolerance around the ray when choosing the referent |
| Ray flickers between neighbours | Majority within a segment; confidence falls with disagreement; below threshold, no link |
| Every ray from inside hits the bubble sphere, lights, or unexported geometry | Cast only against the clipped bubble meshes (`collectSceneBubbleGroup` returns a source → clipped map) and capsules, never `RecordedBubbleSphere`, lights, or the source scene |
| No world model, so root motion is normalized | Scene anchors skipped; body anchors only |
| Recorded frames hold only local bone transforms | Pose an avatar clone per frame at export for capsules (or store ~20 humanoid world positions live) |
| Spans offset from playback time | Spans subtract `frames[0].timeSec`, as `exportWorker.ts` does |
| Node indices unknown before export | Resolved in an `afterParse` plugin from the writer's `nodeMap` |
| Rig bone names differ by avatar or prefix (`mixamorig`) | VRM humanoid name table with Mixamo aliases in the shared package |
| Viewer's `cloneSkeleton` breaks the loader's node map | Map node index to object by walking the original and clone in parallel |
| Desktop third-person camera pitch (0.18–0.72 rad, looking at the eyes) cannot aim up and always hits the head or floor | Separate aim pitch while held; eye-origin aim ray; avatar excluded from desktop resolution |
| Right-click opens the context menu | `preventDefault` on `contextmenu` |
| Hold ends without a mouseup (blur, tab hidden, pointer lock lost) | All end the hold and the span at that frame |
| Locomotion clips don't animate the arm, so it stays raised after release | Check before implementing; restore the pre-hold pose if so |
| No XRHand joints on desktop for the finger retargeter | Fixed index-extended finger curl per rig |
| Recording stops while a point is held | Span closes at the take's last frame |
| Replayed input written back as a new fixture by the dev recording sink | Query flag turns the input-recording sink off for replay checks |
| Labels file replayed as a recording | Labels live in a separate directory from `fixtures/input-recordings` |
| Old viewer or third-party glTF viewer meets the extension | Optional, `extensionsUsed` only |
| viewer-api or USDZ conversion rejects the extension | Confirmed in review: viewer-api stores bytes unchanged; `glb_to_usdz.py` rejects only unsupported `extensionsRequired`; pipeline check proves it |
| Highlight cost or clipping on phone cards | Raise emissive on the clip-patched per-mesh material clones `useSphereClipping` already makes (every child mesh of a multi-material node), restore after; no post-processing, no hull that escapes the clip; a small bone-attached glow for body parts |
| Highlight leaks to another card | State per card, reset on deactivate |
| `mixer.time` counts past the loop | Visibility uses the primary action's `time` |

## Ownership

Implementation is split into small tasks, each a separate agent on the
model tier in `AGENTS.md`, with one owner per file:

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, PRD-022, integration, handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Done 2026-10-22 |
| Contract | One Standard-tier agent, first | New shared package: extension schema, humanoid table |
| Capture, headset detection and resolution | One Deep-tier agent | `src/xr/` point detection, `src/recording/` (point-sample store, segmenting, resolution, meaning exporter plugin, `SceneBubbleSampler` map) |
| Capture, desktop action | One Standard-tier agent | `src/input/InputController.ts`, a new desktop point module, the IK call in the systems slot after the camera, `src/ui/` crosshair |
| Capture, checks | One Standard-tier agent | `run-xr-checks.mjs` `pointing` entry, IWER generator and test scene, desktop take script and hooks, labels |
| Viewer | One Standard-tier agent | `apps/viewer-web/src/features/meaning/` (new), the extension read in `feed/HologramCardCanvas.tsx`, the toggle in `features/portal/PortalControls.tsx`, `e2e/pointing.pipeline.spec.ts` (added to `test:e2e:pipeline`) |
| Check runs | `check-runner` subagent | Runs and summarizes checks |
| Independent verifier | A different vendor from the implementer (for example Codex) | Read-only verification; test artifacts only |

## Design decision

Detect live, resolve at export, store once, and render in the viewer
without recomputing.

- **Headset.** The GLB keeps only retargeted avatar bones, so detection reads
  tracked XRHand joints during recording; `AvatarRecorder.capture` fills a
  point-sample store with the same `timeSec` as the frames. `GltfExportComposer`
  runs on the main thread (the worker only flattens frames) and already holds
  the clipped bubble group, so resolution runs there before `exporter.parse`:
  segment (dwell, hysteresis, gap bridging, split on referent change), cast
  with an angular tolerance against clipped bubble meshes and capsules from an
  avatar clone posed per frame, and keep links above the confidence threshold.
  Spans are backdated to when the pose began, since resolution is offline.
- **Desktop.** The held action records the eye-origin aim ray, which decides
  the referent; the arm only shows it. Links are `recorded`; the arm frames
  become an inferred motion span. The IK runs in the hand-tracking system's
  slot (after the camera, before recording) only outside VR.
- **Record.** As above, written by an `afterParse` exporter plugin that uses
  `nodeMap`, like `GLTFAudioPlugin.ts`.
- **Point-sample store (capture API).** `AvatarRecorder.pointSamples`
  (`apps/capture/src/recording/PointSampleStore.ts`) holds one take's point
  evidence; it is cleared with the recorder, ignores writes while not
  recording, and is read once by `PointResolver` at export. Every `timeSec`
  is the simulation time of the step (`CaptureFrame.elapsedSec`, the value
  `RecordingSystem` passes to `AvatarRecorder.capture`), so samples line up
  with frames; systems before `RecordingSystem` write in the same step.
  - Headset (written by capture itself): `RecordingSystem` passes
    `c.tracking` to `capture`, and `PointDetector` (`src/xr/`) writes
    `recordHandSample({ timeSec, side, score, origin, direction })` for each
    `xr-hand` frame with a filtered index-fingertip ray (world space) and a
    pose score in [0, 1] (`src/xr/pointPose.ts`).
  - Desktop point action, on each step while held:
    `recordAim({ timeSec, side, origin, direction })` with the eye-origin aim
    ray (world space, unit direction; `side` is the hand that shows it and
    becomes `from`); `endAim(timeSec)` on the step the hold ends (release,
    blur, page hidden, pointer lock lost; harmless when no hold is open);
    and, while synthesized arm motion is visible including any blend back,
    `recordInferredMotion(timeSec, bones)` with the VRM bones it drives
    (for example `rightShoulder`, `rightUpperArm`, `rightLowerArm`,
    `rightHand`). Aim writes more than 0.25 s apart, or on another side,
    start a new hold; stopping the recording closes an open hold at its last
    sample. Each hold of at least 0.2 s becomes `recorded` links (cast
    against the clipped scene only, split on referent change like headset
    points, none for the sky); each contiguous motion run becomes one
    `inferred` motion span.
  - Resolution thresholds (`src/recording/pointSegments.ts`,
    `PointResolver.ts`): enter at score 0.6, hold above 0.35, bridge gaps
    under 0.3 s, dwell 0.4 s, spans backdated to score 0.1; a referent
    change must hold 0.4 s to split; cone of rays to 3.5° (a thin object in
    front of a floor or wall wins over it); confidence = agreement × mean
    pose score × ray quality, links kept at 0.5 or more; `radius` 0.15 m on
    meshes whose bounds exceed 1.5 m. `AvatarRecorder.getLastPointReport()`
    returns what the latest export decided (pose segments, holds, runs with
    referent, agreement, confidence, and why a run was dropped) for checks.
- **Viewer.** A per-card hook reads `gltf.userData.gltfExtensions` as
  `useGltfAudio.ts` reads `KHR_audio`, maps node indices through a parallel
  walk of original and clone, and a highlight component raises emissive on the
  referent's clip-patched material clones, adds a ring for large surfaces, a
  bone glow for body parts, and a thin line from the fingertip.

Alternatives considered: recomputing links in the viewer (needs raw hand data
the GLB lacks; repeats work on every device); detecting from exported avatar
finger bones (loses fidelity); an outline post-processing pass or hull mesh per
card (cost on phones; hulls escape the bubble clip); a centre crosshair ray
from the third-person camera (cannot aim up; always hits the head or floor);
reading mouse-look as gaze (rejected in the PRD).

Review changes, 2026-10-22: eye-origin aim with its own pitch on desktop and
no desktop body pointing; `from`/`to` anchor and confidence inside provenance;
no link and no ray for a sky hold (PRD amended); headset fixture used only for
timing and silence, with referents proven on a synthetic take in a generated
scene; casting limited to clipped meshes; emissive on existing clip clones
instead of hulls; segment split on referent change; controller points out of
v0; harness traps (labels directory, input-recording sink, pipeline script
list) recorded above.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Headset timing and silence | New `pointing` check in `run-xr-checks.mjs`: replay `headset-open-fist-pinch-point-wave-reach.json` through the real input path, record, export; labels written from the contact sheet before tuning, kept in `fixtures/pointing-labels/` | passed 2026-10-23: 2 links (both hands, at the labelled times) against a generated room scene; open, fist, pinch, wave, reach silent. `output/ci-pointing/headset-open-fist-pinch-point-wave-reach-report.json`, `-sheet.jpg`. Referents are not scored on this take (it has no intended referent) |
| Referents: targets, own body, change mid-point, sky, too brief | Same check, synthetic IWER take from `generate-iwer-pose-fixture.mjs` in a generated test scene | passed 2026-10-23: TargetA, leftHand, TargetB, TargetA resolved; sky and too-brief silent. `output/ci-pointing/iwer-pointing-targets-report.json`, `-sheet.jpg` |
| Desktop action, both views, release paths, two recorded links, spans, sky | Same check, scripted desktop take via new mock hooks (`point`, aim) plus one real right-button hold under pointer lock (confirm early that headless Chromium grants it) | passed 2026-10-23: 2 `recorded` links (A, B), 3 `inferred` arm spans, no link for the sky hold. Headless Chromium rejects pointer lock, so the check uses a real CDP right-button hold with a simulated `pointerLockElement`. `output/ci-pointing/desktop-pointing-targets-report.json`, `-sheet.jpg` |
| Upload, render, styles, orbit, loop, toggle | `e2e/pointing.pipeline.spec.ts` records the real exports itself in `beforeAll`, against the running capture app (`E2E_CAPTURE_URL`), with no committed GLBs: the scripted desktop take (recorded style) and the IWER replay take (inferred style; scene objects and the author's hand), through the same shared helpers as the capture check (`lib/pointing-desktop-take.mjs`, `lib/pointing-iwer-replay.mjs`), which also score them. Each is uploaded → feed, with a dev-only highlight probe; expected links are read from the export's own `HOLOIM_meaning`. A hand-built GLB stays only for what the exports lack: a large-surface ring, a mixed recorded/inferred scene pair, and the no-extension old recording | passed 2026-10-23, 4 tests in 1.4 min: screenshots in `output/pointing-viewer/` (`desktop-recorded-*`, `iwer-inferred-*`: outside span, each span midpoint, orbited, toggled off; hand-built `0-`…`7-`), takes in `output/pointing-viewer/takes/` |
| Old GLBs unchanged; USDZ conversion | `pnpm run test:smoke:pipeline`; conversion of a GLB with the extension | passed 2026-10-23: pipeline suite (6 tests) including the no-extension recording; USDZ conversion of a GLB carrying `HOLOIM_meaning` succeeds, Quick Look treating it as an optional extension |
| Repo checks | `pnpm run verify:agent` in the loop, `pnpm run verify:pr` before merge | passed 2026-10-23 on the integration branch, and again after merging `main` |
| Precision and recall targets; recipient trial | Physical headset takes with author-labelled points; PRD-022 trial | pending (device) |

## Independent verification

2026-10-23, Muse (Meta), a different vendor from the Claude implementers; Codex
ran out of quota part-way after confirming the schema and USDZ conversion and
flagging that the viewer e2e then used a hand-built GLB (since replaced by live
capture exports). Muse found no defect above Low, no threshold or label
weakened, and correct provenance in every producer. Its four Low findings
were fixed in `6f13a25d1e8d`: confidence is now required on inferred links, the
resolver applies the full 0.4 s dwell to sub-runs, the viewer probe samples
after applying, and the hand-built fixture's purpose is documented. Its
sandbox could not launch Chromium, so the browser runs above were made by the
lead on the same tree.

## Physical-device limits

IWER replay proves detection, resolution, export, and rendering on recorded
and synthetic input. It does not prove the PRD's precision and recall targets
on fresh real-world pointing, tracking noise during points, or phone rendering
cost. Required physical evidence: at least three new Quest recordings with 20
or more author-labelled points (intended referent named by the author),
scored against PRD-022's targets; the feed highlight viewed on a real phone;
and the recipient trial. Only one real headset recording exists today, and it
has no intended referent in the replay scene.
