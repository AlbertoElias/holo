# Feature brief: AR recording (the phone as a camera-only author)

**Lead:** Claude (Opus)  
**Status:** Approved (the user, 2026-10-25, with the recommended answers to Q1 to Q3); in progress: slices 1 and 2a built and checked locally (pushed on `feature/ar-recording`, flag off); independently verified by Codex (`codex exec -p deep -s read-only`, 2026-10-26): slice 1 passed; slice 2a's defects were fixed in `a686aa9` (a microphone stream leaked by overlapping requests, a Record guard blind to the export's occlusion test, an admission point the bubble could thin away, a take begun on a hidden page) and `8a019ff` (the held microphone kept until the next frame after the session's end, a pending start that a hide and restore did not cancel, Recenter allowed while a start was pending, a guard walking draw groups unlike the export, and check assertions that could pass a truncated path or an audio extension with no payload). Codex's re-check of `8a019ff` confirmed every runtime fix and found no new defect; its two remaining inspector gaps (a bubble moved by a node `matrix`, audio bytes declared but absent from the BIN chunk) were fixed in `39c8afe`, and the lead reproduced both mutations in memory against `phone-a.glb`: each now fails `assertCameraTake` and the real take passes. Codex re-checked `39c8afe` (2026-10-26): both fixed, no new defects, verdict "ship slices 1 and 2a behind the flag, off by default"; slice 0 waits for `feature/viewer-xr-interface`, slices 3 and 4 for its step 5
**Layer:** event (the author's camera, voice and the set over time) and
meaning (a held mark whose `from` is the camera); see
`docs/product/concepts/what-a-hologram-is.md`

## User outcome

An author with an Android phone opens capture, taps "View in your room"
(AR), and sees capture's set standing in their real room at true scale. They
walk around it with the phone, talk, and record a take. To say "this", they
touch and hold the thing on the screen: the mark is cast from the phone's
camera through the finger. Nobody performs: the take holds the set, the
author's voice, the path their camera took and the marks they held. It
uploads and plays in the feed, the portal, Quick Look and the AR viewer like
any other hologram, with the author's camera shown where it stood.

The user decided on 2026-10-25 that such a take is a hologram (recorded in
the concept page in the same change as this brief).

## Background (moved from `TODOS.md`, 2026-10-25)

Split out of slice 5 of [`ui-redesign.md`](ui-redesign.md) on 2026-10-25,
when phone AR marks turned out to need AR recording first. What the
queue entry recorded, checked against the tree at `5f9d376`:

- **Capture's AR is a spectator.** `frame.arSpectator` is set in
  `apps/capture/src/systems/XrSessionSystem.ts:37` for any passthrough blend
  mode (`runtime/xrEntry.ts:66`), so a Quest in passthrough counts as AR too.
  Fourteen systems return early on it, recording included
  (`RecordingSystem.ts:18`); `XrSessionSystem` itself skips head pose and
  body tracking. `xr/ArSpectator.ts` clears the background and moves
  `worldGroup` so the set stands 2.2 m ahead of the viewer, on the floor,
  for 36 frames. No AR take can exist.
- **Export assumes a performer.** `RecordingSession.stopAndExport` throws
  `No avatar to export`; `AvatarRecorder.capture` returns without an avatar;
  `GltfExportComposer` throws without bone tracks and composes the bubble and
  objects against the avatar's root track. Bubble samples and the clipped set
  are in world space. The XR camera pose is never stored as a track.
- **`HOLOIM_meaning` v0 cannot say the camera.** `from` is
  `{ bone, node }.strict()` with a required VRM bone
  (`packages/meaning/src/meaning.ts:41`), and `PointResolver` refuses a hold
  without a hand bone (`'avatar has no hand bone for from'`).
- **No touch reaches capture in AR.** IWSDK 1.0.1's `launchXR` accepts no
  `dom-overlay` (`XRFeatureOptions` has no such key; `mergeXROptions` drops
  unknown ones), capture's `TouchInput` ignores touches while presenting, and
  `HeadsetHolds` drops sources whose handedness is not left or right.

## Scope

**Included:**

- **Camera author mode.** A capture AR session that is handheld makes the
  author a camera. "Handheld" is one shared check,
  `isHandheldSession(session, { strict })` in `@holoim/xr-ui-iwsdk`, used by
  capture and the viewer alike; capture calls it strict: only
  `XRSession.interactionMode === 'screen-space'` counts, and anything else,
  `undefined` included, keeps today's spectator. In camera mode the idle
  performer is hidden and the systems a camera author needs (recording, the
  camera, screen input, chrome, diagnostics) stop returning early; in every
  other AR session, Quest passthrough included, nothing changes. Camera mode
  sits behind a capture flag, off by default, until slice 4 is verified, so
  no partial slice reaches live phones.
- **One frame for the whole take.** Everything a camera take exports is
  expressed in the set's frame by one `inverse(worldGroup.matrixWorld)`: the
  clipped set, the bubble, the objects, the camera, and every mark's ray and
  hit. Where the set was placed in the room never enters the take.
- **What a camera take records.** Per frame: the XR camera's pose and the
  screen holds. Once per take: the vertical field of view from the
  projection matrix (`2·atan(1/P[5])`; phone projections are off-centre and
  three's `ArrayCamera.fov` is stale, so it is never read per frame).
  Microphone audio as today, with the stream kept open in camera mode
  (`AudioRecorder` releases it after its permission check and asks again at
  Record). Event objects are recorded where they stand; a camera author
  cannot grab them.
- **The export.** A GLB with no skin and no `RecordedAvatar`:
  - the set's world model clipped to a bubble pinned at the set's origin
    (`RecordedBubbleSphere` static, so the feed's motion, read relative to
    it, keeps the camera's path);
  - the event objects;
  - `RecordedAuthorCamera`, a node animated by the take's clip (translation
    and rotation, so every camera take has a clip and a duration), with its
    `yfov` in the node's `extras`, a plain node and not a glTF camera
    (Q2);
  - `KHR_audio`, `HOLOIM_objects` as today, and `HOLOIM_meaning` v1 when it
    holds a camera mark.
- **Touch in phone AR without `dom-overlay`.** Taps and holds arrive as
  WebXR transient input sources (`targetRayMode` `screen` or
  `transient-pointer`, handedness `none`, ray from the camera through the
  finger), as Chrome delivers them without a DOM overlay. They are read
  through the screen-input bridge the viewer XR interface built
  (`apps/viewer-web/src/features/xr/screenInputBridge.ts` on
  `feature/viewer-xr-interface`), moved into `@holoim/xr-ui-iwsdk` and
  extended for holds (slice 0). No `requestSession` shim.
- **Phone AR chrome for capture.** The shared package's phone bottom dock
  (styleguide 9.2, 9.3) carries Record/Stop and Exit, and Recenter between
  takes; "Recording 0:12" shows on the periphery status line. Record stays
  hidden until the set's placement has settled (the 36 frames), and is
  refused when the set has nothing drawn (Q3). Built on capture's migration
  to `@holoim/xr-ui-iwsdk` (viewer XR interface, step 5), never on capture's
  retiring XR chrome.
- **Hold to mark "this" from the camera.** Touch and hold the look surface
  (not the dock) 300 ms within 22 apx, the redesign's phone rule, timed with
  `performance.now()` and with the slop measured on the screen (the ray's
  direction in the viewer's space, projected), so walking while holding does
  not cancel it. The mark's ray is the touch source's target ray, from the
  camera through the finger, read every frame while held. It resolves
  against the set's meshes and objects only, and becomes a `recorded` link
  with `from` the camera node.
- **`HOLOIM_meaning` v1**, through the meaning owner (contract below). v0
  files keep loading everywhere.
- **The viewer shows the author's camera.** In the feed and the portal, a
  camera take frames the set, plays and loops at the take's duration, shows
  the author's camera where it stood (form: Q1), and draws each camera link
  from the camera to its referent. The feed's framing and the AR viewer's
  anchor stop picking any node named `Hips` or `Head` when there is no
  `RecordedAvatar`.

**Excluded:**

- Recording in Quest passthrough AR. A headset in AR has a body to record; a
  performer in passthrough is its own feature. It stays a spectator.
- iPhone. Safari has no WebXR AR session, so AR recording is Android Chrome
  only; the iPhone keeps capture's flat phone recording.
- The Halo in phone AR (stop, undo and redo of a held mark there). Deferred
  by the design review; queued in `TODOS.md` after this feature. Until then
  a wrong mark in phone AR is fixed by retaking.
- Recording the real room. Marks resolve only against what the take holds
  (the set and its objects); a hold on a real wall or the real floor lands on
  nothing and makes no link. Room capture is IDEA-077
  ([`phone-reality-capture.md`](../product/concepts/phone-reality-capture.md)).
- Summoning, placing or grabbing objects as a camera author.
- Hit-test or anchor placement of the set; it keeps `ArSpectator`'s
  placement, and Recenter.
- Using the recorded camera path as the viewer's camera (Follow). It is the
  author's presence, never the view (principle 3); a later Follow may offer
  it as a suggested viewpoint.
- Any viewer-api or contract change. Whether a take has a performer is read
  from the GLB (`RecordedAuthorCamera`).
- Changing the Quick Look globe or the cloche fit: both keep fitting what is
  drawn, the set (see Q1).
- Meaning UI in the viewer's XR routes (`viewer-xr-interface.md` excludes it).

## The `HOLOIM_meaning` v1 contract change

Owned by the meaning owner (`packages/meaning/**`) as its own reviewed
change, landed before any writer emits v1.

**What v1 adds.** One new form of a link's `from`:

```jsonc
// v0 and v1: a performer's bone
"from": { "bone": "rightIndexDistal", "node": 12 }
// v1 only: the author's camera
"from": { "camera": true, "node": 31 }
```

- `camera` is the literal `true`; `bone` and `camera` never appear together.
- `node` is the author camera node, `RecordedAuthorCamera`, animated by the
  take's clip. Its world position at a time is where the author's camera
  was; its −Z axis is where it looked. The schema checks the extension
  alone, as v0 does; the writer asserts the node is the camera node.
- **How `from` grows.** Each new kind of author presence is another
  exclusive sibling form, marked by its own literal key, added under a
  version bump. Every form keeps `node`, so a reader that knows no forms can
  still draw from the node.
- Everything else is unchanged: `to`, `span`, `provenance` (a camera link is
  `recorded`; nothing infers from a camera, and a camera link with
  `inferred` provenance is rejected), motion `spans` (a camera take writes
  none; `bones` keeps `min(1)`).
- Root: `version: 1`. v1 stays exact (strict objects, unknown keys and kinds
  rejected).

**Version is a feature level.** A file's `version` is the lowest level whose
exact schema accepts it. The writer validates its record against the v0
schema first and writes `version: 0` when it passes, otherwise v1; a v2 will
inherit the same rule, with no hand-written "has a camera" test. Performer
takes therefore keep writing v0, which keeps them readable by viewer
bundles cached from before v1.

**Readers.** `validateHoloimMeaning` accepts version 0 or 1 and returns one
type whose `from` is the union; a v0 record parses with the exact v0 schema,
so a v0 file with a `camera` key is still rejected. Every reader handles the
camera form: `apps/viewer-web/src/features/meaning/meaningLinks.ts` and
`PointingHighlights.tsx` (resolve `from` by node, as today; a camera `from`
draws from the camera presence), and capture's scorers
(`scripts/lib/pointing-score.ts`, `held-mark-takes.ts`,
`pointing-desktop-take.ts`), which read `from.bone` today. Unknown versions
are dropped with a warning, as now: the take still plays without its marks.

**Compatibility.** v0 files load unchanged in every reader. A v1 file in a
reader built before v1 (a cached viewer bundle) loses its marks with a
warning and still plays; the viewer and API deploy together, so this lasts
one cache lifetime. `HOLOIM_meaning` stays in `extensionsUsed` only, so the
USDZ converter and any glTF tool ignore it.

## Acceptance criteria

- [ ] With the flag on, in an emulated handheld AR session (IWER device
      config `interactionMode: 'screen-space'`, mono view, no controllers or
      hands, alpha-blend), capture hides the performer, Record appears in
      the bottom dock once placement settles, and Stop exports the take. In
      Quest passthrough AR (`world-space`) capture is still a spectator and
      records nothing. With the flag off, phone AR is unchanged.
- [ ] The export has no skin and no `RecordedAvatar`; it has
      `RecordedAuthorCamera`, animated along the scripted camera path within
      1 cm and 1°; a static `RecordedBubbleSphere`; `KHR_audio` when the
      microphone was granted; no chrome, bridge or presence nodes. Recorded
      under two set placements in the room, the camera path, the set's node
      positions, the object tracks and each link's `to.point` agree within
      1 cm.
- [ ] A 1 s touch hold on an object makes exactly one `recorded` link with
      `from: { camera: true, node }` naming `RecordedAuthorCamera` and `to`
      that object's node, spanning the hold (backdated to the touch); a hold
      on empty real floor makes none and the report says "no referent"; a
      one-frame tap does not mark, and a hold that starts on the dock never
      marks.
- [ ] `HOLOIM_meaning` is version 1 in the camera take and version 0 in
      every performer take; `GLTFMeaningPlugin` emits identical JSON to
      `main`'s for a fixed performer draft; performer exports keep `main`'s
      node and channel counts.
- [ ] Uploaded through the real API with Quick Look on: the feed card frames
      the set, playback time advances and loops at the take's duration,
      audio plays, the author's camera shows where it stood, and the link
      draws from it to the object during its span; the USDZ converts; `/ar`
      places the set at recorded scale on the floor, anchored on the set and
      not on any `Hips` node.
- [ ] Every v0 fixture and every existing pipeline, portal and marks check
      passes unchanged.
- [ ] Mic denied: the take records and exports without `KHR_audio`, and the
      status line says so. The session ending, or the page hiding, mid-take
      stops and exports it.

## Failure cases considered

| Failure case | Prevention or evidence |
| --- | --- |
| A headset in AR (Quest, Android XR) is taken for a phone and records a bodiless take | Strict `isHandheldSession`: `screen-space` only. The AR check runs a Quest passthrough session and asserts no take; both headsets are on the device list |
| Chrome on Android leaves `interactionMode` undefined, or delivers no `screen` sources without `dom-overlay` | The feature would silently never appear: the slice 0 device spike checks both on a real phone before any capture code is written |
| The set's placement offset leaks into the take | One `inverse(worldGroup.matrixWorld)` for every exported thing; the check records under two placements and compares the camera, set nodes, objects and `to.point` |
| The bubble follows the camera and the feed's motion, read relative to it, loses the path | `RecordedBubbleSphere` pinned at the set's origin in camera takes |
| The hidden idle avatar, the dock, the status line, the bridge's ray object or the presence marker reaches the export | Export composes from the set and the camera track only; the check lists node names and asserts no skin |
| A dock tap or a drag on chrome becomes a mark | The bridge keeps per-source state with a real "began on chrome" flag (not "hit anything that listens"); only look-surface sources hold. Checked by a hold that starts on the dock |
| A second finger during a hold overwrites the ray or presses twice | Per-source state in the bridge; a hold follows its own source and ignores others until it ends |
| Walking while holding cancels the hold | Slop measured on the screen, not in the world |
| Emulated frames (about 150 ms each) blur the 300 ms hold boundary | The checks use 1 s holds and one-frame taps only; the boundary and slop are device checks |
| Tracking is lost (phone covered, fast motion) and poses go NaN | Non-finite poses are skipped, never written; the hold bridges gaps as touch holds do today |
| Record pressed while the set is still settling, or Recenter during a take | Record hidden until the 36 placement frames end; Recenter hidden while recording (styleguide 8.5) and refused mid-take |
| A take with nothing in it but a moving camera; `normalizeRootMotion` recentres it | Record refused when the set has nothing drawn (Q3), read as "nothing of the set within the take's 6 m bubble around the camera and the set origin at Record" (lead, slice 2a): the export clips to that bubble, so a set that is drawn but out of reach (capture's default scene from its spawn) would otherwise fail at export |
| Awaiting the microphone uses up the user activation and `requestSession` is rejected | `requestSession` is called in the entry tap; the microphone is asked for in parallel (or on an earlier step), never awaited before it. Denied → silent take with a notice (checked) |
| Back button, system exit or the page hiding mid-take | Stops and exports the take, as Stop does (checked for session end and `visibilitychange`); an unload mid-export loses the take, as on any device today |
| A hold lands on the real room | No link; the report says "no referent"; nothing is invented |
| v0 files stop loading, or performer exports change | v0 parsed by the exact v0 schema; the writer's feature-level rule keeps performer takes at v0; the plugin's JSON and the export counts compared with `main`; every existing suite |
| A cached pre-v1 viewer meets a v1 file | Marks dropped with a warning, take plays (current reader behaviour, unchanged) |
| A take with no clip freezes meaning time at 0 in the feed | The camera track is the clip; the pipeline spec asserts playback time advances |
| A prop's `Hips` or `Head` node takes over framing or the AR anchor | `HologramCardCanvas` framing, and `normalizeSceneAtOrigin` in `features/hologram/hologramScene.ts` (it centres on `RecordedAvatar`, then any `Hips` or `mixamorigHips`, and both the R3F AR view and the IWSDK shell call it; the shell then grounds on the lowest point, checked on `feature/viewer-xr-interface` 2026-10-25), use the set when there is no `RecordedAvatar` |
| The USDZ converter or Quick Look trips on the camera node | The converter reads only meshes and animates rigid nodes; the pipeline spec converts the real take with Quick Look on |
| A wrong `local-floor` estimate on the phone puts the set in or above the floor | Device check (Physical-device limits) |
| Phone frame rate drops while recording | Device check |

## Ownership

| Role | Owner | Files or modules |
| --- | --- | --- |
| Lead | Claude (Opus), this brief | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review; done 2026-10-25 |
| Meaning owner | One agent, slice 1 only | `packages/meaning/**`; the reader updates in `apps/viewer-web/src/features/meaning/meaningLinks.ts` and capture's scorers |
| Implementer | Claude (Sonnet) subagents, one slice at a time | Slice 2a: `apps/capture/src/systems/*` (camera-mode gates), `xr/ArSpectator.ts`, `runtime/xrEntry.ts`, `recording/*` (new camera track store, `RecordingSession`, `AudioRecorder`, `GltfExportComposer`), new `scripts/ci-ar-record-playwright.ts`. Slice 2b: `apps/viewer-web/src/features/feed/HologramCardCanvas.tsx` framing, `features/hologram/hologramScene.ts` (`normalizeSceneAtOrigin`, the anchor both AR views share), new `e2e/camera-take.pipeline.spec.ts`. Slice 3: capture's phone AR dock wiring in `apps/capture/src/ui/` after step 5. Slice 4: new `apps/capture/src/xr/ScreenHolds.ts`, `PointSampleStore`, `PointResolver`, `GLTFMeaningPlugin`, the viewer's presence marker |
| Viewer XR interface lead | `feature/viewer-xr-interface` | Owns `packages/xr-ui-iwsdk/**` and the phone dock. Agreed 2026-10-25: slice 0's package and helper changes are made here, under that lead's review, after `feature/viewer-xr-interface` lands on `main` (they ping when it merges) |
| Independent verifier | Codex (a different vendor) | Read-only verification; test artifacts only |

## Design decision

**A camera author, not a hidden performer.** The take says truthfully that
nobody performed: no skin, no avatar, and a camera node that is the
author's presence. Rejected: recording an invisible avatar driven by the
phone pose (it would invent a body, against principle 7, and make every
reader guess which avatars are real).

**The camera as a node animated by the clip.** The track gives every camera
take a clip, which the feed's playback clock and meaning spans need; the
USDZ converter animates rigid nodes and ignores the rest. Rejected: a camera
path inside `HOLOIM_meaning` (it is event, not meaning, and readers that
skip the extension would lose the author).

**Screen input sources instead of `dom-overlay`.** Chrome on Android
delivers touches in immersive AR as transient `screen` input sources whose
target ray already runs from the camera through the finger, which is the
mark's ray. The viewer XR interface's step 1 spike proved the bridge from
those sources to IWSDK pointers in IWER, and its phone dock is built on it.
Rejected: patching `navigator.xr.requestSession` to add `dom-overlay`
(capture's phone AR chrome would split from the shared package, and IWER
2.6 drops `dom-overlay`, so it could not be tested). Real delivery on a
phone is the riskiest assumption, so a device spike checks it first.

**Handheld decided by `interactionMode`, failing closed,** through one
shared check so capture and viewer never disagree about what a phone is.

**The set's frame for everything.** A camera take lines up with the set it
was recorded in, whatever the room.

**Version as a feature level.** Performer takes keep writing v0, so cached
readers keep their marks; only camera takes carry v1.

**Fit what is drawn.** The cloche and the Quick Look globe keep fitting the
set; the author's camera is drawn by the viewer and may stand outside the
dome, as the author stood outside the set. No converter change.

**A flag until it is whole.** Camera mode hides the performer, so it stays
off on `main` until marks are verified; slices can then ride along with
other merges safely.

**No API change.** The viewer tells a camera take by its
`RecordedAuthorCamera` node.

Design review (Opus `design-reviewer`, 2026-10-25), adopted: one set frame
for every exported thing and the two-placement comparison widened to it;
the flag; the slice 0 device spike and an Android XR headset on the device
list; the bubble pinned at the set and the fit left to what is drawn; the
plugin-JSON and count comparison in place of byte identity of live takes;
version as a feature level and the growth rule for `from`; `yfov` once from
the projection; `RecordedAuthorCamera`; the AR viewer's anchor; per-source
bridge state, a real chrome flag, screen-space slop and wall-clock holds;
the shared handheld check; IWER's own `interactionMode` config, 1 s holds
and one-frame taps; `requestSession` in the tap and the open mic stream;
Record hidden while placing and refused on an empty set; the phone AR Halo
cut; no `exercise_usdz.py` change; slice 2 split. Surfaced to the user as
Q1 to Q3 below.

### Decisions (the user, 2026-10-25)

The user approved the brief on 2026-10-25 with answer A to each question
below; the B and C options are kept for the record.

- **Q1. How the viewer shows the author's camera.** (A, chosen) a small
  filled mark in the author's identity hue with their initial (styleguide
  2.4), Presence material, at the camera node and turned the way it looked;
  a camera link's ink starts there; the dome keeps fitting the set, so the
  mark may stand outside it. (B) no mark; a camera link lights only its
  referent, with no ink line. (C) as A, but the dome also holds the camera
  path: the author's walk is inside the hologram, the set is smaller in the
  feed card, and Quick Look needs the presence baked into the GLB as a mesh
  so both fit the same points. Codex reviews screenshots of the chosen form
  against the styleguide before the user sees it.
- **Q2. A plain node or a glTF camera.** (A, chosen) `RecordedAuthorCamera`
  is a plain node with `yfov` in `extras`: presence only. (B) it carries a
  glTF perspective camera: standard and readable by any tool, but tools such
  as Blender or Babylon's sandbox offer it as the view, against "never the
  view".
- **Q3. A camera take with no set.** (A, chosen) refuse Record when the
  set has nothing drawn: a voice and a moving point is not much of an event.
  (B) allow it: the take is the voice and the author's path alone.

## Slices

Each lands green before the next. Slices 1 and 2a do not wait for slice 0;
slices 3 and 4 wait for viewer XR step 5.

0. **Device spike and shared input** (this feature, reviewed by the viewer
   XR interface lead). The device spike can run any time; the package and
   helper changes wait until `feature/viewer-xr-interface` is on `main`,
   since that branch changes `xr-ui-iwsdk`, `screenInputBridge.ts` and
   `xr-viewer.spec.ts` constantly.
   - A bare test page on an Android phone in Chrome (served over the repo's
     HTTPS setup or the live deployment): `interactionMode`; `screen`
     sources with no DOM overlay; the target-ray pose updating every frame
     while a finger is held; whether a second finger makes a second source;
     `selectstart` timing; the microphone prompt beside `requestSession`
     from one tap. Needs the user's phone; results go in this brief. If
     `screen` sources do not arrive, the decision returns to the user before
     slice 2a.
   - The screen-input bridge moves from `apps/viewer-web/src/features/xr/`
     into `@holoim/xr-ui-iwsdk` with per-source state (down, ray every
     frame, up, began on chrome), and `isHandheldSession` joins it.
   - The IWER phone emulation used by `xr-viewer.spec.ts` (mono view,
     controllers and hands off, transient screen sources inside XR frames,
     `interactionMode` through IWER's device config) becomes a helper in
     `packages/tooling-testing`.
   Built 2026-10-26 (package and helpers; the device spike is pending):
   `ScreenInputSystem` in `xr-ui-iwsdk/src/screenInput.ts` keeps the
   viewer's taps, drags and pinch and adds a `ScreenTouch` per finger
   (`downAt`, `downRay`, `ray` refreshed every frame and kept at the last
   finite pose, `beganOnChrome`, `hitObject`, `pinched`) with
   `onTouchStart`, `onTouchMove` and `onTouchEnd(touch, { cancelled })`
   (cancelled when pinched or when the session ends); `beganOnChrome` reads
   `CHROME_FLAG` on the hit or its ancestors, and the package's dock, foot
   controls, status line and world panel now carry the flag at their roots.
   `screenDistancePx` gives the slop on the screen.
   `isHandheldSession(session, { strict: true } | { strict: false, monoView })`
   in `handheldSession.ts`; capture calls it strict, the viewer non-strict
   with its one-view fallback. `@holoim/tooling-testing/iwer-phone` (tap,
   hold, drag, pinch, head pose, `interactionMode`) serves both
   `xr-viewer.spec.ts` and `test:xr:ar-record`. Checks: `verify:agent`,
   `xr-ui-iwsdk` `verify:full`, `tooling-testing` `verify:fast`,
   `test:xr:ar-record` (pass, 103 s), capture `ui` (pass), and
   `xr-viewer.spec.ts` (8 of 8 pass). A throwaway spec confirmed the touch
   records in viewer phone AR (a hold on the hologram is not chrome; holds on
   Play and on the dock's Exit are; a drag refreshes `ray` and keeps
   `downRay`; both pinch fingers end cancelled); slice 4's check makes it
   permanent.
1. **`HOLOIM_meaning` v1 (meaning owner).** Schema, the normalising reader,
   reader updates, the feature-level writer rule, isolated tests from the
   list below. No behaviour changes. Can start now.
2. **Camera takes,** behind the flag.
   - **2a. Capture.** Camera mode, the hidden performer, the set frame, the
     camera track and `yfov`, the pinned bubble, the open mic stream and
     `requestSession` in the tap, session-end and hidden-page export, Record
     refused on an empty set. Started and stopped through capture's existing
     control bridge (`recording.toggle()`) until slice 3. Ends with the AR
     check's recording phases and a GLB inspection report. A local phone
     emulation helper stands in until slice 0's lands.
     Built 2026-10-25: the flag is `?arCamera=1`; `isHandheldSession` is
     `apps/capture/src/xr/handheldSession.ts` until slice 0 moves it;
     `frame.arCameraAuthor` beside `arSpectator`; `CameraTrackStore` and
     `CameraRecorder` feed `GltfExportComposer.exportCameraTakeToGlbBlob`;
     Record and Stop through `window.__toggleRecording()` (and the `R` key);
     the check's helpers are the phone emulation (since slice 0
     `@holoim/tooling-testing/iwer-phone`; its `interactionMode` patches
     IWER's private device state) and `scripts/lib/camera-take-glb.ts`. A camera author cannot place objects,
     so an object is in a camera take only if it was placed before AR. Found
     on the way: B-024 (the bubble clip drops a large floor, in performer
     takes too); the viewer floor fix on `bug/viewer-floor` grounds on
     `RecordedAvatar`, so 2b needs its own floor rule for camera takes.
   - **2b. Viewer.** Framing and the shared AR anchor
     (`normalizeSceneAtOrigin`) without `RecordedAvatar`; re-read how ground
     is defined first, since a fix for "scene floor sits mid-height" was in
     flight on `main` on 2026-10-25; the
     camera-take pipeline spec without marks (feed, playback clock, audio,
     USDZ, `/ar`).
     Built 2026-10-26: `isCameraTake` (a `RecordedAuthorCamera` node and no
     `RecordedAvatar`) in `hologramScene.ts`; for a camera take the set's
     origin is the recorded floor (`normalizeSceneAtOrigin` leaves it,
     `recordedFloorY` reads it, the shell's `standOnFeet` skips it), and the
     feed framing, the R3F AR height, the shell's hit box and footprint and the
     gallery tile preview use `drawnBounds` (the drawn set and objects, without
     the bubble sphere, the author camera or chrome). Lead's reading: files
     that are neither performer nor camera takes keep today's `Hips` fallback,
     so generic uploads are unchanged. `camera-take.pipeline.spec.ts` (in
     `test:e2e:pipeline`) records its own camera take in `beforeAll` through
     `apps/capture/scripts/lib/camera-take-recording.ts`, as the pointing spec
     does.
3. **Phone AR chrome.** Record/Stop, Exit, Recenter (between takes) and the
   status line from the shared phone dock. Needs viewer XR step 5.
4. **Hold to mark from the camera.** `ScreenHolds` feeds `PointSampleStore`
   aim holds with input `screen` and the source's target ray in the set
   frame; the resolver casts them against the set only and builds camera
   `from`s; the writer emits v1. The viewer's presence marker (Q1) and camera
   link ink. The flag comes off in the merge that lands this slice.
5. **Device checks** on an Android phone (Physical-device limits).

### Isolated tests for slice 1 (contract only)

The meaning record is a shared contract, so slice 1 keeps the package's
isolated tests, chosen from these failure modes: a v0 file with a bone
`from` stops validating; a v0 file with a `camera` key validates; a v1
camera `from` is rejected; `camera: false`, or `camera` beside `bone`,
validates; version 2 or a missing version validates; a camera link with
`inferred` provenance validates; the normaliser changes a v0 record's
content; the writer's rule writes v1 for a record the v0 schema accepts, or
v0 for one with a camera `from`.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
| --- | --- | --- |
| Device assumptions | Slice 0 spike page on an Android phone in Chrome | Results recorded in this brief; pending (needs the user's phone) |
| Camera mode on a phone, spectator on a Quest, flag off unchanged | `test:xr:ar-record` (new, `scripts/ci-ar-record-playwright.ts`, in `test:xr`): IWER with the phone helper enters capture AR from `#ARButton`; further phases enter Quest passthrough AR, and phone AR with the flag off | `output/ci-ar-record/ar-record-report.json` (mode, performer hidden, takes). Slice 2a, 2026-10-25 (`apps/capture/output/ci-ar-record/`, 12 phases after the verifier's pass, about 102 s, pass): phone with `?arCamera=1` is a camera author (`interactionMode` `screen-space`, performer hidden, restored on exit); Quest 3 passthrough (`world-space`) and the phone without the flag stay spectators with the performer visible, no microphone held and no camera take; on the default scene Record is refused ("Nothing to record: no part of the set is near.") and nothing downloads. With the flag on, Quest passthrough and a phone with `interactionMode` unset refuse Record ("Only a phone records in AR; a headset in passthrough watches."); Record while the set settles is refused; every phase counts exactly its expected downloads. Six phases fail on the code before `8a019ff` |
| Camera take export | Same check: Record, a scripted camera walk (`xr_set_transform` on the head) under two set placements, Stop; reads the GLB | Report: skins, node names, per-placement differences of the camera path (cm, degrees), set nodes, objects and `to.point`, `KHR_audio`. Slice 2a, 2026-10-25: 0 skins, no `RecordedAvatar`, `RecordedAuthorCamera` with `extras.yfov` 1.5708 (IWER's 90°) and 192 keys over 3.18 s, static `RecordedBubbleSphere` at the set origin, `KHR_audio`, no chrome nodes; every one of the 30 scripted steps is matched by the exported path within 0.00 cm and 0.03°, rotation at its own keys, over the whole duration (3.18 s against 3.2 s); `KHR_audio` carries a 22.5 kB source; non-finite head poses mid-walk are skipped (60 finite keys of 78 steps); Recenter mid-take is refused and leaves the set frame unchanged; a second placement 1.04 m away (no rotation: `ArSpectator` places by position only) gives 0 cm and 0° differences in the camera path, set nodes and the placed object's track (one `RecordedObject`, still in the set frame). `to.point` waits for slice 4 |
| Hold to mark from the camera | Same check: a 1 s hold on an object, a one-frame tap, a 1 s hold on empty floor, a 1 s hold that starts on the dock | Report: links with `from`, `to`, spans; the "no referent" entry; pending |
| Versions and performer exports | Same check plus the existing `test:xr:pointing` and `test:xr:marks`; the plugin's JSON for a fixed performer draft against `main`'s | Versions per take; JSON comparison; node and channel counts. Slices 1 and 2a, 2026-10-25: the plugin's JSON is identical to `main`'s (see the v0 row); `test:xr:recording`, `test:xr:pointing` and `test:xr:marks` pass on the final tree, and the performer path through `SceneBubbleSampler` is unchanged when no frame is given. After `8a019ff` (2026-10-26), `test:xr:marks` on this branch and on `origin/main` (a detached worktree) gives the same node, channel, skin and mesh counts and byte-identical `HOLOIM_meaning` JSON (version 0) for all four performer takes (controllers, desktop, hands, phone: 86 nodes, 141 channels). Camera takes write no `HOLOIM_meaning` until slice 4 |
| Pipeline | `camera-take.pipeline.spec.ts` (new, in `test:e2e:pipeline`): records a camera take in the running capture app, uploads it through the real API with Quick Look on | Feed screenshot, playback times across a loop, link draw window, USDZ status `ready`, `/ar` anchor and placement numbers. Slice 2b, 2026-10-26 (`output/camera-take/report.json`, 2 tests pass): the set is centred in the card (offset −0.008, +0.011 of the viewing box, tolerance 0.05) with the dome's foot at the set origin; the 3.18 s clip wraps 3 times in 9 s, at most 0.2 ms off the wall clock; one audio source plays; USDZ `ready` (`model/vnd.usdz+zip`); `/ar` at scale 1, placed on the floor, model and bubble sphere at the group's origin; the gallery tile preview is 0.28 m tall (the tile's height) standing on the origin. The same take with an object's nodes renamed `Hips` and `Head` frames and anchors identically. On the code before 2b the card's floor sat at 1.01 m and the AR model rose 6 m. The rest of `test:e2e:pipeline` (10), `test:e2e:portal` (9), `hologram-feed` and `ar-bubble` (11) pass. Link draw window: slice 4 |
| v0 still loads | Slice 1 package tests; `test:smoke:pipeline`, `test:portal`, `test:xr:marks` unchanged | Slice 1 (2026-10-25): `pnpm --filter @holoim/meaning run verify:full` passes 47 tests chosen from the slice 1 failure list (v0 bone file valid; v0 with `camera` rejected; v1 camera valid; `camera: false` and `camera` beside `bone` rejected; version 2, a string version and a missing version rejected; camera with `inferred` rejected; a v0 record returned deep-equal; the writer picks v0 for bone-only and v1 for a camera `from`). `encodeHoloimMeaning` on a fixed performer draft, keys shuffled, gives JSON identical to `main`'s `assertHoloimMeaning` (scratch comparison against `origin/main`'s `meaning.ts`). Suites: pending (`verify:pr`) |
| Mic denied, session end and hidden page mid-take | `test:xr:ar-record` phases with the permission denied, with `xr_end_session` mid-take, and with the page hidden | Slice 2a, 2026-10-25: mic denied → `micPermission` `denied`, notice "No microphone: this take is silent.", a valid take without `KHR_audio`; the session ending and the page hiding mid-take each export one take that passes the inspector; `hidden-at-start` (the page hides while Record waits for the microphone) records nothing, downloads nothing and leaves one live microphone track from one shared `getUserMedia` request; so do a hide and restore, and a session end, while the microphone is pending, and Recenter is refused meanwhile; after the session's end the held microphone's tracks are ended with no further frame. That phase fails on `31953ac` (a take begins hidden, 2 live tracks, 3 requests) and passes after `a686aa9` |
| Proof video | Real-time IWER recording of the phone AR take (dock, walk, hold) and its playback in the feed | Under ignored `output/`, previewed with `preview.mjs`, sent to the user; never committed |

`pnpm run verify:agent` in the edit loop; `pnpm run verify:pr` before the
merge to `main`, per `AGENT_CONTRACT.md`.

## Physical-device limits

IWER proves session, input and export behaviour only, and it has no phone
profile: the phone is emulated (mono view, transient screen sources,
`interactionMode` from the device config), with frames about 150 ms apart.
On an Android phone in Chrome, record in this brief: touch delivery as
`screen` sources without `dom-overlay`; the 300 ms hold versus a tap and the
22 apx slop, standing and walking; the microphone prompt beside
`requestSession`; the `local-floor` height against the real floor; camera
path quality and drift over a walk round the set; frame rate while
recording; dock reach and readability in the thumb zone; the exported take
in the feed and in Quick Look on an iPhone. On a Quest and an Android XR
headset in AR: capture stays a spectator. Until then they stay under
Unverified in `HANDOFF.md`.
