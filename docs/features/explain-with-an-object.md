# Feature brief: Explain with an object

**Lead:** Claude Code (Opus)  
**Status:** Verifying (emulation complete 2026-10-24; physical-device evidence pending). Branch `feature/explain-with-an-object` is pushed and ready but not merged: it lands together with PRD-045.
**Layer:** Event (see `docs/product/concepts/what-a-hologram-is.md`)  
**PRD:** [PRD-043](../product/prds/PRD-043-explain-with-an-object.md) (IDEA-059)  
**Next:** [PRD-045](../product/prds/PRD-045-authoring-while-speaking.md) builds on the object API below.

## User outcome

An author in a Quest (or at a desktop) loads one supplied 3D model before
recording, picks it up, moves and turns it while explaining, and puts it down.
The recipient opens the hologram in the feed or portal and sees the object
move in the avatar's hand, in sync with body and voice. When paused, they
orbit around it to see it from the side the explanation needs.

## Scope

**Included:**

- **Load.** Capture loads one supplied **GLB** before recording, from
  `?object=<url>` or a file chosen in the overlay. It is placed in front of
  the spawn at its own size in meters. Draco, meshopt and KTX2 files, skinned
  models and files over 8 MB are refused with an overlay notice. (Capture has
  no decoders, a skin would export as a second skeleton, and exported textures
  are re-encoded as PNG, which works against the 25 MB upload limit.) A `.gltf`
  file is not accepted from the picker, because a single file cannot carry its
  `.bin` or textures.
- **Grab in XR.** A controller's squeeze (grip) button or a tracked-hand pinch
  grabs the object when the **avatar's** hand bone is within reach. The
  trigger is not used, because it already toggles recording on the VR HUD.
  Pinch has hysteresis: grab under 2 cm thumb–index distance, release over
  4 cm. Squeeze grabs above 0.6 and releases below 0.3. While held, the
  object follows the avatar hand bone's pose, with scale removed, times the
  offset captured at grab time. It is not parented to the bone: height fit
  scales the avatar, and a child would inherit that scale. A grab starts on
  the press itself: squeezing first and then reaching the object grabs
  nothing. If tracking is lost (no `xr-hand` or `controller` pose, or the
  input source disappears), the object freezes in place; after 0.5 s it is
  released there instead of swinging with the hand's fallback pose.
  Switching between controller and hand mid-hold releases the object, because
  the two thresholds mean different things.
- **Desktop equivalent.** `G` picks up the object when the avatar's right
  hand can reach it. A carry pose then drives the right arm with the same IK
  path the desktop point action uses, holding the hand in front of the chest
  and following body yaw and aim. The object attaches to that hand bone as in
  XR, so it never floats in front of an empty hand. `Q`/`E` turn it about the
  vertical axis, `Z`/`X` tip it, and `G` again puts it down where it is.
- **Recording.** Each simulation step, inside `AvatarRecorder.capture` (the
  same enable gate and `timeSec` as the avatar frames), the store records the
  object's transform **relative to the avatar model** (`avatar.matrixWorld⁻¹ ·
  object.matrixWorld`), plus hold spans (start, end, hand).
- **Export.** The export frame is not world space: the composer clones the
  avatar model and puts the recorded root on it, which drops the model's local
  offset under `avatarRoot`. So each object frame is written as
  `exportAvatar(frame) · relative(frame)`, in both normalized and world modes.
  This keeps the object's relation to the hand bone exact. Capture takes with
  a loaded scene use world mode (the one the checks exercise); the normalized
  mode is the fallback for a take without a world model. Both assume
  `avatarRoot` and its parents have unit scale, which holds today: height fit
  scales the avatar model itself. Each object becomes
  a wrapper node, `RecordedObject`, with position and rotation tracks in the
  single `RecordedMotion` clip. A clone of the model sits under it with its
  own transform, and the wrapper's rest pose is the first recorded pose. A
  root `HOLOIM_objects` extension (listed in `extensionsUsed` only) names the
  node, its origin, its presence spans and its hold spans. It stores the
  source as a display name and content hash, never a URL, because URLs can be
  signed or local.
- **Viewer.** The feed card and portal play the object through the existing
  mixer at full weight: one mixer plays every clip, and the object's tracks
  are in the top-ranked clip. The work:
  - leave object meshes out of bubble sphere clipping (today every mesh
    outside `RecordedBubbleSphere` is discarded);
  - scope the `Hips`/`Head` name lookups to `RecordedAvatar`, so a prop's
    bone names cannot capture the card framing;
  - make WebXR AR placement and scale ignore the object's bounds (today a prop
    below the feet lifts the avatar, and a long prop shrinks it);
  - find the object node through the extension, for probes and future UI.
    Playback itself does not depend on the extension.

  Card framing keeps following the body, and the held object is in frame
  because it is in the hand.
- **AR Quick Look / USDZ.** `tools/glb_to_usdz.py` converts the first clip and
  already writes TRS time samples for non-skinned animated nodes, so the
  object should animate with no converter change. The viewer spec converts
  the take and asserts that the object prim has time samples.

**Excluded:**

- multiple objects in the UI (the data model holds several);
- physics, collisions, two-handed scaling and articulated parts;
- object authoring tools;
- pointing at the object as a moving referent (a meaning-layer follow-up);
- the recipient trial (a research step after this ships);
- all of PRD-045: the tray, the summon gesture and removing menu motion from
  the body track. Its extension points are listed below.

## Acceptance criteria

- [ ] `?object=<url>` and the overlay file picker load a GLB into the capture
  scene before recording. A refused or failed load shows an overlay notice,
  and capture keeps working without an object.
- [ ] In IWER with controllers, squeezing with the avatar hand near the object
  grabs it. Moving and turning the controller moves and turns the object
  rigidly with the avatar's hand, and releasing leaves it in place. Squeezing
  out of reach grabs nothing, and the trigger never grabs.
- [ ] On desktop, `G` within reach picks it up into the right hand, and
  `Q`/`E`/`Z`/`X` rotate it. `G` puts it down. Out of reach, nothing happens.
- [ ] The exported GLB has one `RecordedObject` node whose tracks have as many
  keys as the avatar's, and a valid `HOLOIM_objects` extension with the take's
  hold spans. In the GLB, the object's pose relative to `RightHand` matches
  capture's while it is held (≤ 1 cm, ≤ 1°).
- [ ] A take without an object exports as today (no extra node, no
  extension), and existing GLBs without the extension still render.
- [ ] Uploaded through the real API, the feed/portal card plays the object. At
  sampled times its world transform in the viewer matches the GLB track
  (≤ 1 cm, ≤ 1°), it stays at a constant offset from the avatar's hand while
  held, and it is not clipped. A report JSON and screenshots are written.
- [ ] The USDZ converted from the take has time-sampled transforms on the
  object prim. If it does not, the limit is recorded here with evidence.
- [ ] `pnpm run verify:pr` passes locally.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Object track in a different frame from the avatar in the export (clone drops the model's offset under `avatarRoot`) | Sample relative to the avatar model and recompose against the exported avatar; the capture check compares object-to-`RightHand` in the GLB with capture |
| Object follows raw input while the avatar hand is IK-clamped or height-fit scaled | Reach test and attachment both use the avatar hand bone; checks assert a constant hand–object offset while held |
| Height-fit scale inherited by the object | Compose with bone pose with scale removed; never parent |
| Two writers of the object transform | `ObjectSystem` is the only writer; it returns early in AR spectator mode, like `TrackedHandsSystem` |
| Both hands grab, or the hand swaps mid-hold | First hand wins; the other is ignored until release |
| Tracking loss swings the object to the fallback hand pose | Freeze on loss; release in place after 0.5 s |
| Pinch or squeeze jitter at the threshold | Hysteresis on both |
| Holding across start or stop of a take | Hold spans are clipped to the take: one open at start begins at 0; one open at stop ends at the last frame |
| Trigger conflict with record toggle | Grab uses squeeze and pinch only |
| Unsupported or heavy model (Draco, KTX2, skinned, over 8 MB) | Refused at load with a notice, before a take |
| Prop bone names (`Hips`, `Head`) capture viewer framing | Viewer lookups scoped to `RecordedAvatar` |
| Exporter moves the live object out of the capture scene | Export uses a clone |
| Bubble clipping hides the object in the viewer | Viewer skips sphere clipping for object meshes; the object is never under `worldModel`, so capture's bubble never samples it |
| Prop changes AR placement or scale | AR bounds are measured without the object node |
| A second clip would play at 0.35 weight and be dropped by USDZ (first clip only) | Object tracks go in the one `RecordedMotion` clip |
| `extensionsRequired` would make the USDZ converter reject the file | `extensionsUsed` only |
| Private URLs leak into uploaded GLBs | Source stored as name and hash only |
| Older GLBs or viewers | Plain glTF nodes and tracks; the viewer ignores a missing or unknown-version extension |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, PRD-043, integration, handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Done 2026-10-24 (changes folded in above) |
| Contract | Lead | New `packages/objects` (`@holoim/objects`: extension schema and validator) |
| Capture | Lead | New `apps/capture/src/objects/` (registry, loader, grab input, carry pose), new `src/systems/ObjectSystem.ts` and its slot in `src/systems/index.ts`, `src/recording/` (object sample store, `GLTFObjectsPlugin.ts`, composer additions), the grab/carry keys in `InputController`, `runtimeConfig`, `contracts.ts`, `captureTextState`, the overlay file picker, automation hooks |
| Capture check | Lead | `scripts/ci-object-playwright.mjs`, `scripts/lib/object-take.mjs`, a generated prop fixture, the `object` entry in `run-xr-checks.mjs` |
| Viewer | Lead | New `apps/viewer-web/src/features/objects/`, the extension read and `RecordedAvatar` scoping in `feed/HologramCardCanvas.tsx`, the clipping exclusion in `hologram/useSphereClipping.ts`, the bounds exclusion in `ar/ARHologramModel.tsx`, `e2e/object.pipeline.spec.ts` (added to `test:e2e:pipeline`) |
| Check runs | `check-runner` subagent | Runs and summarizes checks |
| Independent verifier | Codex (`codex exec -s read-only`), a different vendor from the implementer | Read-only verification against this brief |

Files owned by other in-flight briefs are touched only where listed above.
`HologramCardCanvas.tsx` (portal and pointing are Verifying) gets one added
read and the scoped name lookups, with no change to their logic.
`InputController.ts` gets five keys. `DesktopPointAction.ts` is reused through
its IK call, not edited, unless a shared helper has to be extracted.

## Design decision

### Object model (built for PRD-045)

`SceneObjectRegistry` in `apps/capture/src/objects/` holds the take's
objects. Each `SceneObject` has:

- an `id` and a `name`;
- the loaded model under a wrapper `Object3D` in `worldGroup`, never under
  `worldModel`;
- a `source` (display name and hash);
- an `origin`: `'prepared'`, in the scene before the take (PRD-045 adds
  `'summoned'`);
- a `layer`: `'event'` (recorded and exported) or `'authoring'` (seen only by
  the author; never sampled or exported). "Chrome" is kept for the viewer's
  View layer.

PRD-043 loads one `prepared`, `event` object.

- `ObjectSystem` runs at priority 75, after `TrackedHandsSystem` (final arm
  pose) and before UI and `RecordingSystem`. It is the only writer of object
  transforms. It reads per-hand grab intents from a new `ObjectGrabInput`
  (controller squeeze and hand pinch from the XR input sources; nothing reads
  controller buttons today, and `XrTracking` reads only axes) and from the
  desktop `G` key. Mock input fields drive both in automation.
- `ObjectSampleStore` (in `src/recording/`) samples `event` objects
  relative to the avatar model, per object, from the first step each object is
  in the event. It also records presence spans (`[{ start, end }]`) and hold
  spans.
- Export: one wrapper node per event object, as above. An object present for
  the whole take, the PRD-043 case, gets no scale track. For an object present
  only part of the take, the PRD-045 path, the wrapper (unit scale, so the
  model's own scale is untouched) gets a **STEP** scale track, 0 outside its
  presence spans. Position and rotation outside those spans hold the nearest
  in-span pose, so nothing interpolates in from the origin.

**PRD-045 extension points:**

- **Tray.** A tray is a set of `authoring` objects shown at the hand.
- **Summon (to build in PRD-045; not in code yet).** A `registry.summon(trayId, timeSec)` should create a **new** `event`
  object: a new id, a cloned `Object3D` and `origin: 'summoned'`, with a
  presence span starting at `timeSec`. The tray item stays, so it can be
  summoned twice, and the sample store's per-object lists never shift
  mid-take. Dismissing an object closes its span; summoning again opens a new
  span.
- **Not covered by the registry.** It keeps the tray itself out of the
  recording, but **not** the author's arm and hand motion while operating the
  tray: `FrameCaptureStore` samples every bone each step. Removing
  hands-in-menu motion from the body track is PRD-045's own work, for example
  holding the arm's last event pose during `authoring` spans.
- **Before PRD-045 relies on the STEP scale track.** The converter maps
  scale 0 to a singular USD transform. PRD-045 must map zero-scale spans to
  `visibility` in `glb_to_usdz.py` and add the presence-span check to its
  viewer spec. PRD-043 never writes scale 0, and no check exercises the
  partial-presence export path yet.

### Alternatives considered

- Parent the object to the avatar's hand bone, so the bone tracks carry it:
  this needs no new track, but the object cannot be put down or handed over,
  and it inherits the height-fit scale. Rejected.
- Sample the object in world space and apply the root normalization: this
  misses the avatar model's local offset, which rotates with the root.
  Rejected after the design review.
- Bake the object into the scene bubble as a mesh sampled every frame: files
  get huge, and the bubble is static. Rejected.
- Put the object in a separate animation clip: the card would play it at 0.35
  weight and USDZ would drop it. Rejected.

### Review changes (design review, 2026-10-24)

The review led to these changes:

- relative-to-avatar sampling and recomposition at export;
- a bone pose with scale removed instead of parenting;
- the reach test on the avatar bone;
- freeze-then-release on tracking loss;
- hysteresis;
- a desktop carry pose that drives the arm;
- squeeze and pinch only, with no trigger;
- GLB-only loading with refusal rules;
- a name-and-hash source;
- an exporter clone;
- `RecordedAvatar`-scoped lookups;
- a wrapper node with a STEP scale and presence spans instead of
  `appearsAt`;
- `summon` creating a new object;
- `authoring` instead of `chrome`;
- body-track exclusion named as PRD-045 work.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result (2026-10-24) |
|---|---|---|
| Load, grab, move, rotate and release in XR; reach and trigger negatives | `pnpm --filter @holoim/capture run test:xr:object`: IWER controllers in programmatic mode, scripted squeeze, move and turn | Pass. `apps/capture/output/ci-object/report.json` (`iwer-object-bracket`): squeeze out of reach and trigger on the object grab nothing; squeeze grabs; object moved 0.144 m and turned 93.8° with the avatar hand while the controller moved 0.34 m (height fit and arm IK shorten the hand's travel); hand-to-object pose constant over 91 held steps (0 at the report's 0.1 mm / 0.001° precision); released object drift 0 m. Screenshots `iwer-object-bracket-{1-grabbed,2-moved-turned,3-released}.png` |
| Desktop grab and carry | Same check, desktop phase with real `G`, `Q`, `W`, `S` keys and the overlay picker | Pass. Same report (`desktop-object-bracket`): the picker refuses a Draco-flagged GLB with a notice and loads the bracket; `G` picks it up into the right hand (carry weight 1, 0.024 m from the hand bone); `Q` turned it 45°; walking carried it 3.2 m; `G` put it down (0 m drift while walking away); `G` out of reach does nothing |
| Export contract and hand relation in the GLB | Same check parses each GLB without a renderer, validates `HOLOIM_objects`, and composes `RightHand` and `RecordedObject` at every held key | Pass. One `RecordedObject` node with 183/183 (IWER) and 229/229 (desktop) keys, same as the avatar; no scale track; extension in `extensionsUsed` only; one right-hand hold of the expected length; object pose relative to `RightHand` matches capture's within the report's 0.1 mm / 0.001° precision (108 IWER keys). The IWER take loads the object through `?object=` |
| No-object takes unchanged; old GLBs render | Same check exports a desktop take before any object is loaded; the existing `test:e2e:pipeline` specs upload older-style exports | Pass. `noObject`: 0 object nodes, no extension, `extensionsUsed` = `KHR_lights_punctual` only. Pipeline specs: see the repo gate |
| Viewer playback matches the track | `e2e/object.pipeline.spec.ts` (in `test:e2e:pipeline`) records the IWER take in `beforeAll`, uploads it through the API, pauses the card and seeks five keys | Pass. `output/object-viewer/report.json`: object pose in the card against the GLB, relative to the recording root, within 1 µm / 0.011° at every key; grip in the hand constant (≤ 0.025°); object meshes never bubble-clipped while the avatar's are; orbiting the paused card leaves the recorded-frame reading unchanged (a sanity check only). Screenshots `output/object-viewer/{0..4}-*.png`, `5-orbited-mid-move.png` |
| USDZ | The same spec opts in to Quick Look, waits for the API's async conversion, and reads the object prim with `pxr` | Pass. Prim `n82_RecordedObject` has 269 time samples; it moves 0.1439 m and turns 93.31° between the grabbed and moved keys, matching the GLB (0.1439 m, 93.31°). No converter change was needed |
| Repo gate | `pnpm run verify:pr` | Pass (2026-10-24): doctor, checks, unit tests, builds, pipeline e2e (7, including `object.pipeline.spec.ts`), portal (6), capture XR checks and mocked viewer XR (9). The knowledge Atlas suite passes (7) against this tree's own server; in the gate run it reused another checkout's server on port 4176 and read that checkout's docs. The first gate run caught the object picker overflowing the 320×180 `recording` viewport; the picker now shares the shortcut row |

### Independent verification (2026-10-24)

Codex, the planned different-vendor verifier, hit its usage limit
mid-review, so a fresh read-only `feature-dev:code-reviewer` verified the
tree against this brief. It found no high-severity defect and confirmed the
export frame math. Findings and resolution:

- A lost controller dropped the object at once instead of freezing it for
  0.5 s. Fixed: the grab intent survives a missing input source, and
  `ObjectInteraction` treats a missing source as tracking loss.
- A squeeze-to-pinch switch mid-hold applied pinch hysteresis to a squeeze
  state. Fixed: switching the input kind releases.
- Grabs start on the press only. Now stated in Scope.
- The brief over-claimed precision, the tested export mode and an existing
  `summon`. Wording corrected.

## Physical-device limits

IWER proves the deterministic grab, record, export and render path. It does
not prove grab feel, reach distance, pinch reliability with real hand
tracking, or comfort. A Quest take with a real supplied model is required
before the PRD's recipient trial, and Quick Look playback on a real iPhone is
unverified. No check exercises pinch grabs (the IWER take uses controllers),
the over-8 MB and skinned-model refusals, the normalized (no world model)
export mode, or WebXR AR placement with a held prop.
