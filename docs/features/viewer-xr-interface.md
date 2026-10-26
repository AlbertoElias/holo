# Feature brief: Shared XR interface and viewer VR/AR

**Lead:** Claude (Opus)  
**Status:** Implementing (approved 2026-10-24; steps 1–5 done; step 6: IWSDK is the `/ar/:id` default, R3F kept behind `?shell=r3f`)
**Layer:** view (see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

A recipient on a headset can step into holograms in VR, and a recipient on a
phone or headset can place them in their room in AR. They pick holograms from
a gallery of their feed, place several side by side, and control each like a
video — play, pause, restart, scrub — while moving, scaling and rotating it,
all without leaving the immersive session.

Capture and viewer present **one XR interface**, built the IWSDK way and laid
out as the styleguide places things (§1.2, §6, §9): glyph controls at each
hologram's foot, a periphery status line that holds state only, and a hand
dock; the same components and interaction in both apps, differing only in the
actions each supplies.

Product framing: on flat screens the screen is a portal; in a headset the
portal disappears and the recipient stands in the event. VR uses a minimal
neutral space. True scale is fact: life size means the recorded scale.

## Scope

**Included:**

- **IWSDK viewer scene.** `/vr/:id` and `/ar/:id` each mount an IWSDK `World`
  (`World.create(container)`, destroyed on exit), as capture does. The flat
  feed and portal stay React Three Fiber.
- **One XR interface for capture and viewer.** A shared workspace package
  (`@holoim/xr-ui-iwsdk`, replacing `xr-ui-three`/`xr-ui-r3f`) provides three
  pieces built on IWSDK UI and pointers (ray, touch, grab):
  - **Foot controls**: one glyph control set at each placed hologram's foot,
    on the chip (styleguide §5.1, §6, §9.2).
  - **Periphery status line**: the only thing that follows the head (lazily,
    IWSDK `Follower`, upper edge of view). It shows state such as
    "Recording 0:12" and never holds a control (§1.2).
  - **Hand dock**: glyphs on the non-dominant hand (palm or wrist) in a
    headset, and the bottom dock on a phone (§1.2, §9.1).

  `xr-ui-core` keeps the app-agnostic action model. Capture's
  `VrRecordingPanel` and `VrHud` are retired: Record moves to the hand dock as
  a glyph only, and "Recording 0:12" goes to the status line. There is no
  head-locked or head-following control panel in either app.
- **Entry.** Feed card shows "Step inside" (VR, when `immersive-vr` is
  supported) and "View in your room" (AR, unchanged rules). A Quest shows both.
- **VR space.** The blue-hour room (styleguide §9.1): IWSDK gradient dome and
  image-based light from `tokens.json` ground colours, and a soft floor; each
  hologram lights its own stage. IWSDK locomotion (slide, snap turn,
  teleport). AR uses the same image-based light over the camera image.
- **Gallery.** Feed holograms appear as small live previews on a curved shelf
  around the viewer, paged through the feed cursor with the existing
  `fetchHolograms(cursor)` (no API change). Selecting one places it at
  recorded scale in front of the viewer and focuses it.
- **Several placed holograms.** Placed holograms stay where they are. Each has
  its own playback state, grab/scale/rotate and foot controls; every foot
  control acts on its own hologram. Two kinds of focus, kept apart:
  - **Audio focus**: the hologram whose body or foot control was last
    selected. Only it is heard. A head turn never changes it.
  - **Spark focus**: the hologram nearest the head's forward ray (§8.2). It
    carries the sparks and nothing else.

  "Back to gallery" removes one from the space.
- **Controls at each hologram's foot** (styleguide §1.2, §6):
  - **Always there:** Play/Pause with its timecode, small and close to the
    edge; the only always-there glyph (Free and Return are excluded below).
    It dims to 40% after 4 s unused and returns to full when something comes
    near: a ray hovering the chip, a hand within 0.3 m of it, or the head's
    forward ray within 15° of it. Quest Browser exposes no gaze, so the head
    ray stands in for it.
  - **On reach:** restart, scrubbable timeline with elapsed/total, recenter,
    scale chip ("life size" reset) and back to gallery appear on the same
    triggers and leave afterwards.
  - **Size and pose:** sized for a 1.75 m reference distance (`tokens.json`
    apx are angular). Hit areas follow §6.1 per input and are never under
    56 apx for a ray or 44 apx for touch at that distance. The chip's world
    size ignores the hologram's grab scale, so a 0.1× hologram keeps
    full-size controls. Its position is fixed to the hologram, 2 cm above
    the anchor and in front of the feet, outside the hologram's pointer box.
    In a headset its yaw faces the viewer only when the hologram is placed
    or recentered, never per frame. On a phone it also turns (yaw only)
    every frame to face back along the phone's view, without moving.
  - **Chip per target (§5.2, §9):** VR rows are bare against walls and take
    the chip at 72% (0.3 s fade in, 2 s hold) in front of a lit floor. AR
    always shows the chip, 97% on Quest passthrough and 88% on Android
    Chrome, never opaque. On an Android phone, flat sizes and 44 apx touch
    targets, not 2.5×.
  - **Labels:** glyphs only within arm's reach. The timecode and labels
    follow §7.3: readable 1 m away or more, faded within 1 m of the
    hologram.
- **Exit and the dock.** Exit sits in the hand dock in a headset (pending
  user decision: §1.2 lists Record, ink and undo there, not Exit). On a
  phone, IWSDK has no `dom-overlay`, so the bottom dock is a screen-space
  strip attached to the camera in the §9.3 thumb zone, inside the safe-area
  insets of §6.1; it is the one exemption from the no-head-follow criterion
  (on a phone the screen is the hand), and it is pending user confirmation
  with Exit. Android back and the system exit take the same exit path. With
  controllers only, the dock sits on the non-dominant controller; handedness
  defaults to right and gets a setting.
- **Move / scale / rotate.** IWSDK `TwoHandsGrabbable` (move, rotate, scale)
  with scale clamped to 0.1×–2× recorded scale; any non-1.0 scale is shown on
  the chip and reversible.
- **AR.** IWSDK `immersive-ar` with hit-test and anchors; placing from the
  gallery uses the hit-test floor point. The pure placement logic in
  `arPlacement.ts` is reused; the R3F `ARHologramModel` state machine becomes
  an IWSDK system.
- **Playback.** An app-side `HologramPlaybackSystem` owns each hologram's clip
  clock and `AnimationMixer` (IWSDK has no animation system) and drives that
  hologram's audio, so pause, seek, restart and loop keep them in sync.

**Excluded:**

- Flat-screen portal behavior (`portal-view.md`).
- iOS Quick Look (native viewer; no app controls).
- Capture-time environment in VR; meaning-layer UI in XR; multi-viewer
  sessions; phone `immersive-vr`.
- Switching between AR and VR mid-session.
- Synchronized playback across holograms.
- The Free and Return glyphs: Follow mode is not built in XR, so Play/Pause
  is the only always-there glyph.

## Acceptance criteria

- [ ] "Step inside" appears only where `immersive-vr` is supported and enters
      an IWSDK VR world with the chosen hologram placed at recorded scale
      ~1.5 m ahead on a neutral floor; "View in your room" keeps today's rules.
- [ ] In the IWSDK shells, holograms are placed at recorded scale (1.0) by
      default, with no 1.85 m normalisation, and the scale chip reads "life
      size". The R3F AR view keeps its normalisation until step 6 retires it.
- [ ] The gallery shows feed holograms around the viewer, pages past the
      loaded feed via the cursor, and selecting one places and focuses it
      without ending the session.
- [ ] At least four holograms can be placed at once; each keeps its own play
      state, transform and foot controls, and the foot chips never overlap.
      Selecting one gives it audio focus, and only it is heard. A head turn
      moves the sparks but never the audio.
- [ ] Foot controls work by controller ray, hand ray/pinch and screen tap
      (phone AR), and by poke where they are within reach. The hand dock
      works by poke and ray; the phone bottom dock by screen tap.
- [ ] Nothing interactive follows or locks to the head in a headset: the
      periphery status line is the only head-following element and holds
      state only (the phone bottom dock is the stated exemption).
- [ ] The always-there glyph dims to 40% after 4 s unused and returns on
      ray hover, a hand within 0.3 m or the head ray within 15°; the probe
      reports control opacity and the dim timer.
- [ ] Pause freezes that hologram's animation and audio at the same
      clip time; play resumes there; restart returns both to 0; loops wrap
      both together.
- [ ] Scrubbing shows the pose at the chosen time, and the scheduled audio
      offset matches clip time within 50 ms (measured as
      `ctx.currentTime − startedAt + offset`; proves scheduling, not ear sync).
- [ ] Two-hand grab moves, rotates and scales (clamped) while the hologram
      stays standing on its ground: horizontal moves, yaw-only turns, scale
      about its base, base height within 5 mm of the ground throughout (the
      user, 2026-10-24); recenter restores default placement and recorded
      scale for that hologram.
- [ ] Removing holograms and paging the gallery returns renderer geometry and
      texture counts to the baseline for what remains in the space.
- [ ] Exit destroys the World and returns to the feed at the last focused
      hologram.
- [ ] Capture's XR UI is built only from the shared package (Record in the
      hand dock, "Recording 0:12" on the status line, no head-locked panel),
      and capture recording, refit and recenter pass the capture XR suite.
- [ ] Capture and viewer use the same foot-control, status-line and
      hand-dock components: the probes report equal glyph size (apx), stroke
      width and chip opacity per target, and an IWER contact sheet shows both.
- [ ] `/ar/:id` deep links work; AR placement, recenter and bubble specs pass
      (ported as needed); export → upload → render pipeline smoke passes.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Phone AR needs tap input but IWSDK has no DOM overlay | Spike (step 1): screen/transient-pointer input reaching IWSDK pointers on the in-world panel. If it fails, decision returns to the user before going further |
| Enabling IWSDK InputSystem and spatial UI in capture breaks recording (it was removed for CDN controller models and double ray ownership; UIKitML is stripped in production builds) | Spike (step 1) in capture: local controller/hand models, input visuals off, pointers only; record/replay determinism re-checked; production build check that panels survive |
| IWSDK `AudioSystem` has no seek and uses wall-clock ramps that broke capture replay | Viewer audio stays app-side, driven by `HologramPlaybackSystem`; IWSDK audio stays off in both apps |
| Many placed holograms exceed Quest frame or memory budget | Cap placed count (start at 4, tune on device); gallery previews are paused low-LOD clones; IWER reports draw calls and geometry counts |
| Gallery and placed entities share one cached GLTF (AssetManager clone) and disposal corrupts the source | Dispose only per-clone materials and mixers; evict cache keys only when no entity uses them |
| Double select on a gallery item while it loads | Load keyed by id; duplicate placement ignored |
| Hologram fails to load or 404s | Gallery tile shows an error state; nothing else changes |
| Focus ambiguity when holograms overlap | Audio focus is the last selected; spark focus is the head ray (§8.2); each foot control acts only on its own hologram, so neither focus decides what a control does |
| Neighbouring holograms' foot chips overlap | Each new placement is offset by at least the chip width plus a 30 apx gap; tested with four placed |
| Foot chip under the real floor or hidden by it (AR floor error, fallback at y = 0, depth occlusion) | Chip 2 cm above the anchor; chrome is exempt from depth occlusion when step 6 ports it |
| Poking the palm dock collides with a two-hand grab by the same hand | The dock hides while the non-dominant hand grabs |
| Scrubbing on a phone needs the pointer to move every frame (spike 1, not exercised) | Step 3 checks a held-tap scrub through the screen-input bridge |
| The same upload renders at different sizes in `/vr` (recorded scale) and the R3F `/ar` (1.85 m normalisation) | Accepted until step 6 retires the R3F view; the IWSDK AR shell is already at recorded scale |
| Audio of an unfocused hologram keeps playing | Focus change stops audio on the old one and starts the new one from its clock |
| Grab and foot-control pointer target the same input | IWSDK pointer priority (touch > grab > ray); the foot chip sits in front of the feet, outside the hologram's grab volume and pointer box |
| GLB with a wrong root scale looks absurd at 1.0 | Scale chip makes it visible and reversible; log recorded-scale anomalies; no silent normalisation |
| Static hologram (no clip) | Timeline/play disabled, "still" state; static GLB fixture |
| Autoplay blocked | `AudioContext.resume()` inside the first XR select (feed resume does not carry over) |
| World not torn down on exit or route change (leaked render loop, XR session) | `world.destroy()` on unmount; e2e enters and exits twice and checks one canvas, no session |
| Duplicate `three` copies across packages | Structural flags, not `instanceof`; typecheck catches clashing `@types/three` |
| Controls out of reach (tall, short, seated) | Foot controls move with their hologram, which can be recentered or grabbed closer; the hand dock is always within reach |
| Session ends unexpectedly | Same exit path as the Exit control |
| Capture recording regresses while its UI migrates | Capture XR suite before and after; migration is its own commit, last |

## Ownership

Implementation order (each step lands green before the next):

1. **Spikes** (decide go/no-go): phone AR tap on an IWSDK panel; IWSDK input and
   spatial UI inside capture without breaking recording or production builds.
2. **IWSDK viewer shell**: `/vr/:id` and `/ar/:id` mount a World with one
   hologram at recorded scale, AR hit-test/anchor placement ported,
   `HologramPlaybackSystem` with audio, exit/teardown.
3. **Shared UI package** `@holoim/xr-ui-iwsdk` (foot controls, periphery
   status line, hand dock) and the viewer's foot controls; grab/scale.
4. **Gallery and multiple placed holograms**, focus, feed paging, disposal.
5. **Capture migration** onto the shared package (Record to the hand dock,
   status on the status line). `xr-ui-three` and `xr-ui-r3f` stay (the user,
   2026-10-25): main's redesign uses them for the flat feed, ARChrome and
   capture's Halo. The exported GLB has no UIKit or font nodes, and its node
   and channel counts match before and after the migration.
6. **IWSDK AR by default** (added 2026-10-24, decision A): port bubble
   clipping, aura and depth occlusion to the IWSDK AR shell, port the AR
   specs (with `hand-tracking-fidelity.md`), then make it the `/ar/:id`
   default and retire the R3F immersive view.

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, shared UI API, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Re-review done 2026-10-24 before step 3 (foot controls, hand dock, decision A); findings applied |
| Implementer | Claude (Sonnet) subagents, one step at a time | `apps/viewer-web/src/features/xr/` (new), `features/ar/`, `app/router.tsx`, `feed/HologramCard*.tsx` (triggers), `hologram/useGltfAudio.ts` (shared audio clock); `packages/xr-ui-iwsdk/` (new), `packages/xr-ui-core/`; step 5: `apps/capture/src/ui/`, `apps/capture/src/runtime/captureStage.ts`; new spec `apps/viewer-web/e2e/xr-viewer.spec.ts` |
| Independent verifier | Codex (different vendor) | Read-only verification; test artifacts only |

**Overlaps:**

- `portal-view.md` is merged and live; its brief stays Verifying only for
  device checks, so its files are free to edit on top of `main`.
- `hand-tracking-fidelity.md` owns viewer AR checks: coordinate before porting
  `hologram-feed.spec.ts` or `ar-bubble.spec.ts`.
- `room-scale-body-motion.md` owns `tooling-testing/xr-env` and touches capture
  runtime wiring: check before steps 2 and 5.

## Design decision

- **IWSDK for both immersive scenes.** Capture already runs on an IWSDK World;
  the viewer's immersive routes become IWSDK Worlds too, so the shared
  interface is IWSDK-native: UIKit-based foot controls and hand dock, a
  `Follower`-driven status line, IWSDK pointers and grab components. The capture-specific reasons IWSDK input, UI
  and audio were switched off (`docs/IWSDK_AI_WORKFLOW.md`,
  `archive/iwsdk-runtime-refactor.md`) are re-tested in the step 1 spike;
  audio stays app-side in both apps.
- **What stays app-side:** animation playback (IWSDK has none) and audio seek
  live in a viewer `HologramPlaybackSystem`; AR placement rules from
  `arPlacement.ts`.
- **Feed stays R3F.** The flat feed and portal are not XR; rewriting them buys
  nothing. Entering XR navigates to the IWSDK route.
- **Controls where the styleguide puts them (user decision, 2026-10-24).**
  Controls sit at each placed hologram's foot as glyphs (§9.2); the periphery
  status line is the only thing that follows the head and holds no control;
  capture's Record moves to the non-dominant hand dock. This replaces the
  earlier plan of one lazy-follow panel bound to the focused hologram, which
  §1.2 forbids. Capture loses its head-locked panel and gains ray/pinch
  alongside poke, which makes the two apps identical.
- Alternatives rejected: one lazy-follow panel for the focused hologram
  (head-following controls break §1.2); plain-Three shared panel hosted in
  both IWSDK and R3F (hand-rolls what IWSDK provides); keeping the viewer on
  R3F with `@react-three/xr` (two stacks for one interface).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Spikes | Throwaway IWER runs (phone AR tap; capture with input + UI on) and a production build, 2026-10-24 | **Both GO**; results in "Step 1 spike results" below |
| VR entry, recorded scale, teardown | IWER spec `xr-viewer.spec.ts` (Quest 3 profile) in `test:xr:viewer` | **Pass** 2026-10-24: scale 1, on the floor 1.50 m ahead, two enter/exit visits with equal renderer counts; screenshot + `output/test-results/xr-viewer-report.json` |
| Gallery, multiple placed, focus, audio focus | Same spec on a seeded 12-item feed (`/uploads/missing-5.glb` answers 404) | **Pass** (step 4): the shelf shows the 10 items the card carried (one feed fetch); four placed at recorded scale, base on the floor, feet 4–6 cm above it, upright, at least the chip width + 30 apx apart, every body clear of the shelf and every foot chip in sight from the eyes; a fifth select returns `full`; the 404 tile reads "Couldn't load" and selecting it changes nothing; a paused hologram holds its clock while the others play; a ray on a body moves focus, ring and foot controls, and only the focused one is heard (audio within 11 ms of its clip); a double select is ignored while loading; "Older" fetches with cursor `10` (Runner 7–12); exit returns to the focused one's card; phone AR places two on the floor 1.0 m apart and a tap moves focus without pausing; `gallery` and `arGallery` in the report, screenshots `vr-gallery-four`, `ar-phone-two` |
| Playback, scrub, loop, audio scheduling | Same spec, clock and audio offsets read from the page | **Pass** (steps 2–3): clip clock 1.00× wall clock; ray pause holds clock and audio; a held-trigger scrub lands within 5% of the aimed time with the pose at that time; resume, restart and a phone timeline drag reschedule audio within 50 ms; `vrControls` and `ar.phoneControls` in the report |
| Grab/scale/rotate | Same spec, scripted controller grips | **Pass** (step 3): two-hand grip grab spreads, carries, lifts and turns it; uniform scale, clamped at 2× ("200%"), base on the floor (0 mm) and upright at every step; scale chip "life size" resets scale in place; recenter 1.50 m ahead at recorded scale; `vrControls.grab` in the report |
| Memory after remove/page | Same spec | **Pass** (step 4): after sending two back and paging out and back, 74 geometries and 180 textures, as at the baseline (UIKit text buffers that grew are counted apart, 33 → 35); the cache keeps only models in use (`gallery.renderer`, `gallery.cacheAfter`) |
| AR placement + phone tap | `xr-viewer.spec.ts` on `/ar/:id` (`?shell=iwsdk` before step 6) with an emulated phone (mono, no controllers, screen taps) | Step 3 **pass**: phone foot controls at flat sizes (16/36 apx, 44 apx touch, chip 0.88), a tap on the play glyph pauses without moving the hologram, a 30-frame finger drag on the timeline scrubs within 5%, and Exit in the bottom dock (16 CSS px, bottom centre) leaves; IWSDK shell **pass** (step 2), opened from the feed card at `/?shell=iwsdk`: stands on the floor 1.8 m ahead and anchors, lit like VR (mean luminance of the hologram's pixels 67 in AR vs 71 in VR; the unlit build read 19 and fails the 30 threshold), tap on the hologram pauses and resumes, tap on the floor moves it (0 mm miss) and re-anchors; porting `hologram-feed`/`ar-bubble` waits for the bubble decision below |
| Capture on the shared UI | `pnpm run test:xr:smoke` + capture `run-xr-checks.ts ui recording mock-vr hands body height marks` | **Pass** (step 5), results in "Step 5 results" below; `output/ci-capture-ui/ui-report.json` |
| Same look in both apps | IWER screenshots of both apps' hand dock, status line and aim rays via `preview.mjs` | Side-by-side sheet (step 5), see "Step 5 results" |
| Nothing interactive follows the head | Same spec: turn the head and read control world positions | **Pass** (step 3): foot controls moved 0 m on a head turn while the status line (no interactive parts) followed; `vrControls.headTurn` |
| AR on the IWSDK default (step 6) | `hologram-feed.spec.ts`, `ar-bubble.spec.ts`, `redesign.spec.ts` in `test:xr:viewer`, read from `__HOLOIM_XR_VIEWER__` and the dev placement observer | **Pass** (step 6): hit-test placement on the floor in front (base on IWER's surface within 0.1 m, under 0.5 m), recenter by ray on the foot row places again in front, Exit from the left-hand dock returns to the feed; no hit test → the floor 1.8 m ahead, reason `hit-test-unavailable`; clipping, the cloche, aura, a pinned rim and the scale chip in `ar-bubble`; left-handed puts the dock on the right hand; the R3F view's own controls test runs on `/?shell=r3f` |
| Recorded floor (B-022) in the IWSDK shells | `xr-viewer.spec.ts` "B-022" tests on a ledge fixture (`terrainGltf`: author's floor 1 m above the lowest terrain) | **Pass** (step 6), VR and phone AR: the author's floor on the floor (< 1 cm), cloche foot on it (< 5 cm), the drop still 1.00 m below and inside the bubble (unclipped); with the old lowest-point rule both fail (author 1.6 m up) |
| Pipeline compatibility | `pnpm run test:smoke:pipeline` | **Pass** (step 6) `bubble-capture.pipeline` on the IWSDK default: AR cloche foot and placement at 0.000, recorded floor −0.024, feet +0.036 (`output/bubble-rendering/capture/floor-report.json`); full suite below |

### Step 1 spike results (2026-10-24)

Throwaway code, reverted after the runs; nothing from it is merged. Both runs
used IWER 2.6 with IWSDK 1.0.1 and are emulation evidence only.

**Spike 1: phone AR tap on an IWSDK panel: GO, with an app-side bridge.**

- Setup: a minimal IWSDK `World` in `immersive-ar` (spatial UI on) with one
  `PanelUI` button 0.85 m ahead, in a 390×844 page. IWER has no phone
  profile, so the page emulated one: mono view, controllers and hands
  disconnected, and each tap delivered the way Chrome Android does without
  `dom-overlay`: a transient input source (`handedness: 'none'`,
  `targetRayMode: 'screen'`, ray from the viewer through the tap point) that
  fires `selectstart`, then `select` and `selectend` inside an XR frame, then
  is removed.
- IWSDK alone: **no.** `XRInputManager.assignInputSource` keeps only `left`
  and `right` sources, so a screen source never drives an IWSDK pointer.
  Result: 4 taps, 4 XR `selectstart` events, 0 panel `pointerdown`, 0 `click`.
- With a ~30-line bridge: **yes.** On `selectstart`/`selectend` from a
  `screen` or `transient-pointer` source, read the target-ray pose from the
  event's frame, place an object under `world.player` there, and drive a
  `@pmndrs/pointer-events` ray pointer (`move` then `down`/`up` then `exit`)
  into the scene, the event system `PanelUI` already uses. Result: 3 of 3
  taps on the button gave `pointerdown` + `click` and showed the pressed
  state; a tap on empty space gave nothing.
- Notes for step 2: pointer-events treats a press longer than 300 ms as no
  click (`clickThresholdMs`), so the bridge sets the threshold it wants for
  phones; scrubbing the timeline by dragging needs the bridge to also
  `move` the pointer every frame while the source exists (not exercised);
  IWSDK does not request `dom-overlay`, so no DOM UI is available in phone
  AR. Real Android Chrome tap delivery is unverified (Physical-device limits).

**Spike 2: IWSDK input and spatial UI inside capture: GO.**

- Change tried in `captureStage.ts`: `spatialUI: true` and `InputSystem` kept
  registered (`AudioSystem`, `EnvironmentSystem`, `LightSystem`,
  `GazeSystem` still removed; locomotion, physics, grabbing still off). A
  `PanelUI` panel with `Follower` (target `world.player.head`, `PivotY`) and
  `RayInteractable` + `PokeInteractable` had a Record/Stop button calling
  `recording.toggle()`.
- No CDN models: IWSDK's visual adapters load controller and hand GLBs from
  `cdn.jsdelivr.net/npm/@webxr-input-profiles` even with visuals toggled off.
  Replacing each adapter's `assetLoader` with one that returns an empty
  scene leaves input tracked with no visual and no request: 0 requests to
  the CDN in the run (two `[xr-input]` console warnings name the URL that
  was declined). Capture keeps its own avatar hands.
- Recording input stays capture's: IWSDK only dispatches pointer events;
  capture still reads three's controllers and hands. In IWER (Quest 3) the
  right controller ray clicked Record, recording ran through a head turn
  (the panel lazy-followed), and a second click stopped and exported a
  2.5 MB GLB (`RecordedMotion`, 141 channels, 10 skins). No console errors.
- Determinism: with the change, `run-xr-checks.mjs recording mock-vr hands
  body` passed, and all 14 hand and body replay outputs (`*-samples.json`,
  `*-report.json`) were byte-identical to a clean checkout of this branch.
- Production build: `vite build` with capture's empty UIKitML kits and
  lucide subset still parses and instantiates a panel of plain
  `div`/`span` (all three element ids found, 10 meshes). Horizon kit
  components and lucide icons beyond the subset stay unavailable, so the
  shared package builds from UIKit primitives or widens the boundary in
  `vite.config.ts`. The one console error in the served build (a JSON
  request answered with HTML) also occurs on the clean build.
- Notes for steps 3 and 5: IWSDK pointers live under `world.player`, but
  capture moves its own `cameraRig`, so the spike copied the rig's world
  pose to `world.player` before each `world.update` (a float32 entity
  transform; only pointers and `Follower` read it, recording does not). The
  old `VrHud` conflicts with IWSDK input: its proximity touch and its own
  controller `select` both toggled recording when its head-locked pill
  crossed the controller or the ray, so the spike disabled it; step 5 must
  remove it in the same change that adds the hand-dock Record. The default
  UIKit font lacks `·` and `×`, and the styleguide's "Paused · 0:08" needs
  `·`, so the shared package (not either app) ships an MSDF font that has
  them.

### Step 2 results (2026-10-24)

- **Routes (decision A, accepted by the lead 2026-10-24).** `/vr/:id` is
  IWSDK only: a `World` (`features/xr/`) with the hologram at recorded scale
  (no 1.85 m normalisation; the R3F AR view keeps it until it is retired).
  `/ar/:id` stays on the R3F view by default; the IWSDK AR shell is opt-in
  at `/ar/:id?shell=iwsdk`. Porting bubble clipping, aura and depth
  occlusion, then making the IWSDK shell the `/ar/:id` default, is a later
  step; the existing AR specs assert those effects.
- **Feed triggers.** Both use styleguide §6 glyphs: "View in your room" is
  the viewfinder cube, and "Step inside" is the doorway (a door frame on a
  threshold with a figure in it, chosen by the user 2026-10-24). "Step
  inside" shows only when `immersive-vr` is supported. Exiting returns to `/` and scrolls to the
  hologram that was opened. Step 2 has no head-following controls.
- **Placement.** VR places the hologram 1.5 m ahead on the floor, facing the
  viewer. AR ports the R3F hit test (a downward-tilted viewer ray, plane and
  mesh entities, upward surfaces only, then an anchor) with one change: hits
  more than 0.5 m above the local floor are skipped, because a recorded
  person at true scale stands on the floor. Without a usable hit after
  3.5 s, it stands on the local floor (y = 0) 1.8 m ahead (the R3F view's
  minimum forward distance) and is anchored there. In IWER's `office_small`
  the first upward hit is a 1.3 m desk 0.86 m ahead. The R3F rule puts the
  hologram on it, with everything above its feet out of a phone's view; the
  IWSDK shell falls back to the floor 1.8 m ahead.
- **Playback.** `HologramPlaybackSystem` drives the mixer from one clip clock
  and starts KHR_audio at that clock (IWSDK `AudioSystem` unregistered).
  The spec builds an audio fixture by appending a tone to `avatar.glb`.
- **Input.** The screen-input bridge (`screenInputBridge.ts`) drives a
  pointer-events ray pointer from phone taps. IWSDK pointers only intersect
  entities in `scene.interactableDescendants`, so the hologram carries
  `RayInteractable`. Its pointer target is an invisible body-sized box: a
  three.js skinned-mesh raycast missed the avatar entirely, and per-frame
  ray tests on skinned triangles are costly.
- **Lighting.** The blue-hour image-based light (`IBLGradient`) lights the
  hologram in both modes; only VR adds the dome and floor. AR first shipped
  without it and the hologram rendered as a black silhouette. The spec now
  measures the hologram's own pixels (those that change when it is hidden
  for a frame) and requires a mean luminance above 30.
- **Opt-in carries over.** With `/?shell=iwsdk`, the feed's AR trigger opens
  `/ar/:id?shell=iwsdk`, and exit returns to `/?shell=iwsdk`. On phones the
  "Step inside" label stacks under the AR glyph, clear of the card badge.
- **Probe.** Development builds expose `window.__HOLOIM_XR_VIEWER__.snapshot()`
  (placement, scale, clip time, audio offset, renderer counts), which the
  spec reads.
- **Decided by the user (2026-10-24):** controls follow the styleguide
  (foot controls, status line, hand dock; scope and design decision
  rewritten); the copy stays "View in your room" / "Step inside", and the
  styleguide's §6 glyph table now says so, including the user's doorway
  drawing for "Step inside". The feed and the Quick
  Look link use `XR_ENTRY_LABEL`.
- **Still open:** the IWSDK shell's skip of
  surfaces over 0.5 m (the R3F view still uses the first upward hit); the
  feed's trigger chrome predates the styleguide.
- **Limits:** the viewer's `@iwsdk/vite-plugin-dev` 0.5.3 still bundles
  IWER 2.3; IWSDK locomotion is off. Emulation evidence only.

### Step 3 results (2026-10-24)

- **Package.** `@holoim/xr-ui-iwsdk` builds the foot controls, the periphery
  status line and the hand dock from IWSDK's UIKit (`UIKit.Container`,
  `Text`, `Content`) and pointer events, driven by the action model and
  labels in `@holoim/xr-ui-core`. Sizes come from `tokens.json` per target
  (`vr`, `ar-quest`, `ar-phone`); glyphs are stroked meshes, because UIKit's
  `Svg` fills paths and ignores strokes.
- **Foot controls.** A chip at the hologram's front edge, turned to the
  viewer only when it is placed or recentered. The always-there row is Play
  (in its ring) with "Paused · 0:06" when paused. The on-reach row is
  restart, the timeline with elapsed/total, recenter and the scale chip.
  The on-reach row shows on ray hover, a hand within 0.3 m or the head ray
  within 15°, holds 2 s, and the chip dims to 40% after 4 s unused.
- **Phone sizes.** Flat sizes are CSS pixels of the phone's image (§9.2),
  computed from the XR view's projection (the page camera's read 7.5 px for
  a 16 px glyph). The foot chip scales with its distance from the phone, so
  it keeps that size wherever the viewer stands.
- **Status line.** Follows the head lazily, holds no pointer target, and
  shows only "Paused · t" in step 3.
- **Hand dock.** Exit on the left grip, its poke target at least 20 mm, and
  hidden while that hand grabs. On a phone, a bottom-centre strip fixed to
  the camera.
- **Grab.** `TwoHandsGrabbable` on headsets only. IWSDK's handle denies ray
  pointers on the hologram and stays bound once added, so a phone never gets
  one. Its transform is replaced (`twoHandGrab.ts`) so the hologram stays
  standing on its ground (the user, 2026-10-24): the base moves with the
  hands' midpoint horizontally, turns by their yaw, scales uniformly about
  itself (0.1×–2×), and keeps its height. In AR, release hit-tests straight
  down under the new spot and re-anchors there; without a hit within 1 s it
  anchors where it was let go. The AR path has no emulated check yet
  (the phone has no grab; the spec has no AR headset run).
- **Input.** Phones are detected by `session.interactionMode ===
  "screen-space"` (Chrome Android) or a single view. IWER always reports
  two views, so the spec sets the mode. The screen-input bridge already
  moved the pointer every frame, so a held finger drags the timeline with
  no change.
- **Spec changes.** Grips, not IWER hands, drive the grab. Clips are
  stretched to 8 s so restart and loop checks do not alias with polling.
  Emulated phone taps release on the next frame: emulated frames take
  about 150 ms, and pointer-events treats a press over 300 ms as no click.
- **Phone placement.** On a phone the on-reach row shows while the chip
  sits in the lower half of the screen. The spec frames the whole body: the
  phone looks at 45% of the hologram's height, so crown and feet stay on
  screen with the controls showing. The timeline shrinks (down to 48 apx) until
  the reach row fits 16 px gutters. At 390 px the spec asserts left ≥ 16 and
  right ≤ 374.
- **Phone dock shade.** The bottom dock sits on the §5.2 shade: deep sea 70%
  to 50% at 60% to clear, across the screen width and 24% of its height. It
  takes no pointer.
- **Standing on the ground.** A skinned person's bounds follow bone
  matrices a fresh clone has not computed, so `normalizeSceneAtOrigin` left
  the fixture 1.04 m above the floor. The viewer re-stands it on its posed
  vertices (`standOnFeet`), and the spec asserts the lowest bone sits on the
  ground after placement and through the grab. The R3F
  `ARHologramModel` uses the same normalisation and likely floats too
  (follow-up).
- **Design decisions (lead, 2026-10-24).**
  - The scale chip reads "62%".
  - Figtree replaces Inter. The OFL TTFs (Regular 400, Medium 500, from
    erikdkennedy/figtree) are generated into MSDF atlases with
    `@zappar/msdf-generator` (printable ASCII plus "·×–—…") in
    `packages/xr-ui-iwsdk/src/fonts/` with `OFL.txt`. Each weight loads as
    its own asset on first use. Figtree set the elapsed/total label wider
    than Inter, so labels never wrap (`wordBreak: "keep-all"`).
  - The "·" is drawn as a dot.
  - The chip tilts half-way toward the eyes.
  - The timeline track is gold at 40% under a gold fill (closest tokens).
  - Exit sits in the hand dock and the phone bottom dock.
  - The phone dock uses the §5.2 shade.
  - A small chip at about 2 m is fine.
  - A ray click on the hologram no longer pauses it in a headset; the play
    glyph does.
  - Restart returns to 0 and keeps the play state.
- **Glyphs.** The user approved the pause, restart, recenter and exit
  drawings (2026-10-24). They are in styleguide §6 path for path.
- **Limits.** The grounded grab and the uniform-scale patch rely on IWSDK's
  internal `Handle` component. Emulation evidence only.

### Step 4 results (2026-10-25)

- **Gallery shelf.** Two curved deep-sea boards, 1.2 m from the viewer's
  spot at 0.9 m high, at the sides (boards 75°–135° either way; tiles at
  85°, 105° and 125°), so the space in front stays free. Six tiles a page,
  each a small paused preview (0.28 m, posed a third of the way into its
  clip) with its title on a chip above it. "Newer" and "Older" at the
  wings' ends page the feed (text labels: there is no paging glyph).
  Paging past the loaded feed fetches the next page with its cursor. The
  card hands its loaded feed and cursor to the viewer in router state; a
  deep link fetches the first page.
- **Placing (the lead, 2026-10-25).** The first hologram stands 1.5 m
  ahead and fixes the stage. Each next one takes the nearest place, on
  arcs from the stage's distance outward (0.25 m apart), centre first, right
  before left, where, seen from the stage's origin, it is fully visible,
  hides no placed hologram, stands at least the chip width (or both
  footprints) + 30 apx from each, and stays clear of the wings. With the
  fixture's arms-out figures (about 1 m apart) three fit 1.5 m out; the
  fourth stands about 3.5 m out, 66° right. The viewer can grab-move any
  of them. In AR the same place is hit-tested straight down and anchored.
  At most four (`MAX_PLACED_HOLOGRAMS`).
- **Focus.** The last hologram selected (a ray or tap on its body, or on
  arrival) has focus: the one set of foot controls binds to it and faces the
  viewer, a gold floor ring (1.4% of its diameter, 4 cm beyond its
  footprint) marks it, and only it is heard. Focus moving stops the old
  one's audio and starts the new one's from its own clock. Each keeps its
  own play state, transform and grounded two-hand grab. On a phone a tap on
  the focused hologram pauses or resumes it; on another, it focuses it.
- **Phone row off-centre (the lead, 2026-10-25).** With the focused
  hologram off the screen's centre, the reach row is drawn in perspective
  and would cross the screen's edge. Each frame it slides along its chip
  until its projected edges sit half a pixel inside the 16 px gutters, and
  slides back when there is room. The spec frames the focused hologram right
  and left of centre (`arGallery.offCentre`).
- **Back to gallery (the user, 2026-10-25).** Selecting a placed
  hologram's tile again sends it back: the tile shows its title, muted,
  without its preview while it is placed. No new glyph. When the focused
  one leaves, focus returns to the one focused before it.
- **Disposal.** Models load once into a reference-counted cache shared by
  previews and placed clones. A clone disposes only its own skeletons and
  mixer; the cache disposes a model's geometry, materials and textures when
  its last user releases it. A failed load is not cached and marks its tile.
  A select of a tile that is loading, or a second select within 400 ms, is
  ignored.
- **Renderer counts.** UIKit grows text buffers when labels first show and
  keeps them, so the spec counts geometries under the UI roots apart and
  compares the rest, after showing the controls once before the baseline.
- **Open.** The fifth select is refused silently. The dark boards barely
  show against the floor. Emulation evidence only.

### Step 5 results (2026-10-25)

- **Merged main first (the user, 2026-10-25: "Merge main, port
  VrChrome").** Main's ui-redesign is the authority for shared visuals.
  Kept from this branch: the IWSDK shell, `xr-ui-iwsdk`, and the doorway,
  restart, recenter and exit glyphs. Pause is the filled bars, and the AR
  entry is "View in your room", next to "Step inside" (the user).
  `xr-ui-iwsdk` reads its colours and glyphs from `@holoim/design-tokens`.
- **Capture's headset chrome on `xr-ui-iwsdk`.** `VrChrome` keeps its
  public API and snapshot. It builds:
  - Record/Stop on the non-dominant hand dock, 4 cm off the wrist joint or
    grip;
  - the bare periphery status line ("Recording 0:12"), with no chip in
    either app (the user);
  - the world panel with "Refit height" and the handedness row, opened
    level 1.5 m ahead, where they stay (the user: off the hand dock);
  - main capture's gold aim line in both apps. IWSDK's own ray and cursor
    are hidden (the user).
  IWSDK's pointers dispatch every chrome event. The old HUD's own select
  binding and poke commit are gone. Recording input stays capture's own.
  The poke rules, pulses, tick, 0.5 s "pressing chrome" release, hit rules,
  draw order and `holoimChrome` flag carry over unchanged. The poke
  distances are still slice 4's, open to revisit.
- **IWSDK in capture.** `spatialUI` is on and `InputSystem` stays. Its
  controller and hand visual adapters get a loader that returns an empty
  scene, so no model loads from the CDN: the production build made no
  request off its origin. Audio, Environment, Light and Gaze stay removed.
  Each frame copies the camera rig's world pose to `world.player` before
  `world.update`. Under the manual clock, `world.update` runs outside any
  XR frame, where IWSDK would disable its pointers. A step without a frame
  keeps the last input sample, and the frame loop samples on each XR frame.
- **Found on the way.**
  - IWSDK's TransformSystem moves any entity whose parent is not an
    entity back under the level. The dock therefore follows capture's
    wrist (a plain three object) by copying its pose. The status line,
    panel and dock live under IWSDK's level and are marked and hidden with
    the rest of the chrome.
  - Capture now dedupes IWSDK, UIKit, pointer-events and three, as the
    viewer does. Two copies registered `LevelTag` twice.
  - The production bundle crashed at startup with a TDZ error: rollup put
    the design packages in a chunk that the xr chunk and the debug chunk
    imported from each other. three and the design packages now get leaf
    chunks.
- **Kept, not retired.** `xr-ui-r3f` serves the feed's card canvas,
  ARChrome and R3F AR. `xr-ui-three` serves the Halo (`HeadsetHolds`) and
  `xr-ui-r3f`.
- **Checks (2026-10-25, after merging main at de8a3f8).**
  - Capture `run-xr-checks.ts ui recording mock-vr hands body height
    marks`: all pass.
  - The 14 hand and body replay outputs (`*-samples.json`,
    `*-report.json`) are byte-identical to the merged tree before the port.
  - `pnpm run test:xr:smoke`: 23 of 23 pass.
  - `pnpm run verify:agent` and `pnpm --filter "@holoim/capture..." run
    build` pass. The production bundle, served by `vite preview` with IWER
    injected, shows the wrist dock, the panel rows and the rays, with no
    page error and no request off its origin.
- **Viewer specs on main's redesign.** Main hides a card's reach controls
  until a pointer reaches the card, so `xr-viewer.spec.ts` now calls
  `reachFor` before "Step inside" and "View in your room", and lets the
  portal settle first. The phone reach row's gutter fit is polled until it
  settles; a fixed 300 ms wait read a frame early under the full suite.
- **Same look.** A side-by-side IWER sheet compares the viewer's hand dock,
  aim rays and status line ("Paused · 0:00") with capture's ("Recording
  0:04"). The gold rays, cream on a hit, the bare status type and the dock
  rings match. The dock contents differ by design: recenter and exit in the
  viewer, Record in capture.
- **Decided in step 6 (the user):** XR keeps "62%" / "life size"
  (`scaleChipLabel`), not main's "1:4".

### Step 6 results (2026-10-25)

- **Floor (B-022) in the IWSDK shells.** Merged `bug/viewer-floor`.
  `standOnFeet` and `hologramScene.ts` now take the RecordedAvatar origin as
  the floor and leave the rest of the scene where it is; only a GLB with no
  RecordedAvatar falls back to its lowest point. A gallery tile still fits
  the whole recording. Terrain below the author's floor stays drawn and
  inside the clip sphere. New `xr-viewer.spec.ts` checks for VR and phone
  AR use a ledge fixture whose drop falls 1 m below the author.
- **Scale chip:** "62%" / "life size" stays in XR (the user), not main's
  "1:4". The R3F fallback keeps its "1:" label.
- **AR bubble ported.** `HologramBubble` (one per placed hologram) and
  `HologramBubbleSystem` bring the R3F view's look to both IWSDK shells:
  - sphere clipping (`applySphereClipping`, moved out of the React hook,
    0.2 m falloff);
  - the aura (`BubbleAura`, a plain three class the R3F wrapper reuses);
  - the burnt-globe cloche from `@holoim/xr-ui-three`, fitted with its foot
    on the recorded floor, sparks on the hologram nearest the head ray
    (8.2), soot from light estimation in AR and the ground grey in VR (9.1);
  - in AR, depth occlusion (`depthSensing: gpu-optimized`) through IWSDK's
    own `DepthSensingSystem`: each placed hologram is a `DepthOccludable`,
    chained after the clipping patch. IWSDK turns three's depth-sensing
    mesh off, so the R3F view's prepass draws nothing there (the first
    port did, and the proof video showed it). The controls are not
    occludable, so a real table never hides them. Under IWER the shell
    does not ask for depth (its emulated depth stalls software GL); dev
    `?depth=on` forces it.
  The cloche and aura take no pointer events, so the body box still gets
  taps and grabs. IWSDK's audio listener is removed: under a frozen page
  clock its ramps threw.
- **VR floor.** The VR room's floor plane sits 1 cm under y = 0, so a
  take's recorded ground at its floor draws instead of z-fighting it.
- **Routing.** `/ar/:id` opens the IWSDK shell; `?shell=r3f` (on the feed or
  the route) opens the R3F view, a temporary fallback. Exit goes to `/`.
- **Placement reason.** The AR placement state now says why:
  `hit-test`, `hit-test-timeout` or `hit-test-unavailable`.
- **Left-handed.** The IWSDK hand dock follows the feed's handedness
  setting (the R3F wrist did; the IWSDK dock was always on the left).
- **Specs ported.** `ar-bubble.spec.ts` (4), the AR cases of
  `hologram-feed.spec.ts`, the left-handed case of `redesign.spec.ts` and
  `bubble-capture.pipeline.spec.ts` assert the same things against the
  IWSDK shell. The R3F controls case in `redesign.spec.ts` runs on
  `/?shell=r3f`. In IWER's `office_small` the default level gaze meets a
  1.3 m desk or the walls first, so the hit-test case looks down at open
  floor, as a placing user does.
- **R3F view kept.** The `?shell=r3f` fallback still needs `ARView` and its
  components, so nothing is retired yet.
- **Checks (2026-10-25).** `pnpm run verify:agent` passes.
  `test:xr:viewer` passes 25 of 25. `test:smoke:pipeline` passes 10 of 10.
  In `verify:pr`, doctor, `check:all`, every unit suite and `build:all`
  pass, as do `test:portal` (6) and `test:xr:smoke` (25). The knowledge
  atlas e2e did not run cleanly: a day-old knowledge dev server from the
  main checkout holds port 4176, and Playwright reused it (main's docs, so 3
  of 7 fail). Its `check:docs` passes.
- **Decided after step 6 (the user, 2026-10-25).**
  - **Pinch on the phone: yes.** Two fingers on the screen rescale the
    focused hologram about its feet, between 10% and 200% (the headset
    grab's limits), snapping to life size within 4%. Each finger is an XR
    screen input (the shell has no DOM overlay); a second finger cancels the
    first one's press, so neither taps. `xr-viewer.spec.ts` pinches in to
    about half and back out to "life size" on the emulated phone.
  - **Floor only (surfaces over 0.5 m skipped): kept**, unless the user says
    otherwise.
  - **VR's floor stays solid:** recorded terrain below the author's floor
    stays under it in VR.
  - **The floor fallback no longer lands in walls or furniture.** Placement
    now casts a fan of rays (slopes 0.35, 0.7, 1.2 and 2 below the view)
    and stands on the first floor hit at least 0.6 m ahead, so it finds
    the floor in front of a desk instead of the desk. When no ray finds
    floor, the estimate stands 0.5 m short of the nearest thing the rays
    met, between 0.6 and 1.8 m ahead. The trade-off: in a cramped room it
    stands closer than a phone can frame (a 1.6 m figure needs about
    1.4 m), and the viewer steps back or pinches. In IWER's
    `office_small`, straight ahead it now stands 0.6 m away, not 1.8 m
    (inside the desk, against the wall).
- **The phone's reach row turns to face the phone (the user, 2026-10-25).**
  After a phone walked about 2 m round, the row was seen at an angle: its
  ends differed by about 150 px in height (the brief then turned it only on
  place, recenter or focus; the bubble work did not change that). Now, on a
  phone only, the chip turns (yaw only) every frame to face back along the
  phone's view, so its rows stay level on screen. It stays where it was
  placed; it never follows the viewer. Facing the phone's position was not
  enough, because the chip stands in front of the feet, off the line of
  sight: that still left a 70 px skew. Headsets keep the place, recenter
  and focus rule. The styleguide (§9.2, placement) records the exception.
  `xr-viewer.spec.ts` walks the phone 2 m round on the IWSDK default route
  and asserts that the row's ends are within 10 px of level (measured
  0.0 px), that it stays inside the 16 px gutters (16.5–373.5 of 390 px),
  and that the chip has not moved.

### Video verification loop

Every step, including each spike, ends with a real-time proof video of the
real workflow in IWER (headset view plus a spectator view where it helps:
entering, gallery, placing, grabbing, scrubbing, focus and audio switching,
exit; for capture, record → stop → export from the hand dock). The
implementer previews it as a contact sheet
(`node packages/tooling-testing/src/preview.mjs`), fixes what it shows, and
re-records until it is clean; the lead sends the final video to the user as
proof. Videos and their recording scripts stay in the ignored `output/`
directory or the scratchpad: never committed or linked from docs. Durable
evidence is the e2e specs and their `*-report.json`.

## Physical-device limits

IWER proves session, input, scheduling and memory behavior only. On devices:
Quest 3 VR comfort, frame rate with four placed holograms, foot-control and
hand-dock reach and readability, grab/pinch/poke feel, audio by ear, recorded-scale realism; Quest
passthrough AR; Android phone AR tap; capture hand-dock feel after migration.
Record results here; until then they stay under Unverified in `HANDOFF.md`.
