# Feature brief: Shared XR interface and viewer VR/AR

**Lead:** Claude (Opus)  
**Status:** Implementing (approved 2026-10-24; step 1 spikes done, both GO)
**Layer:** view (see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

A recipient on a headset can step into holograms in VR, and a recipient on a
phone or headset can place them in their room in AR. They pick holograms from
a gallery of their feed, place several side by side, and control each like a
video — play, pause, restart, scrub — while moving, scaling and rotating it,
all without leaving the immersive session.

Capture and viewer present **one XR interface**, built the IWSDK way: the same
panels, components, follow behavior and interaction, differing only in the
actions each app supplies.

Product framing: on flat screens the screen is a portal; in a headset the
portal disappears and the recipient stands in the event. VR uses a minimal
neutral space. True scale is fact: life size means the recorded scale.

## Scope

**Included:**

- **IWSDK viewer scene.** `/vr/:id` and `/ar/:id` each mount an IWSDK `World`
  (`World.create(container)`, destroyed on exit), as capture does. The flat
  feed and portal stay React Three Fiber.
- **One XR interface for capture and viewer.** A shared workspace package
  (`@holoim/xr-ui-iwsdk`, replacing `xr-ui-three`/`xr-ui-r3f`) provides IWSDK
  `PanelUI` panels (UIKit) with shared components (button, toggle, timeline
  slider, label pill, status line, scale chip), `Follower` lazy-follow, and
  IWSDK's ray/touch/grab pointers. `xr-ui-core` keeps the app-agnostic action
  model. Capture's `VrRecordingPanel` and `VrHud` move onto it.
- **Entry.** Feed card shows "Step inside" (VR, when `immersive-vr` is
  supported) and "View in your room" (AR, unchanged rules). A Quest shows both.
- **VR space.** IWSDK environment with a neutral gradient dome and a soft floor;
  IWSDK locomotion (slide, snap turn, teleport).
- **Gallery.** Feed holograms appear as small live previews on a curved shelf
  around the viewer, paged through the feed cursor. Selecting one places it at
  recorded scale in front of the viewer and focuses it.
- **Several placed holograms.** Placed holograms stay where they are. Each has
  its own playback state and its own grab/scale/rotate. Selecting a placed
  hologram focuses it; the control panel binds to the focused one. Only the
  focused hologram's audio is heard. "Back to gallery" removes one from the
  space.
- **Controls for the focused hologram:** play/pause, restart, scrubbable
  timeline with elapsed/total, recenter, scale chip ("life size" reset), back
  to gallery, exit.
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

## Acceptance criteria

- [ ] "Step inside" appears only where `immersive-vr` is supported and enters
      an IWSDK VR world with the chosen hologram placed at recorded scale
      ~1.5 m ahead on a neutral floor; "View in your room" keeps today's rules.
- [ ] Holograms are placed at recorded scale (1.0) by default — the 1.85 m
      normalisation is removed — and the scale chip reads "life size".
- [ ] The gallery shows feed holograms around the viewer, pages past the
      loaded feed via the cursor, and selecting one places and focuses it
      without ending the session.
- [ ] At least four holograms can be placed at once; each keeps its own play
      state and transform; selecting one moves panel focus to it; only the
      focused one is audible.
- [ ] Every panel control works by controller ray, hand ray/pinch and hand
      poke in headset VR and AR, and by screen tap in phone AR.
- [ ] Pause freezes the focused hologram's animation and audio at the same
      clip time; play resumes there; restart returns both to 0; loops wrap
      both together.
- [ ] Scrubbing shows the pose at the chosen time, and the scheduled audio
      offset matches clip time within 50 ms (measured as
      `ctx.currentTime − startedAt + offset`; proves scheduling, not ear sync).
- [ ] Two-hand grab moves, rotates and scales (clamped); recenter restores
      default placement and recorded scale for the focused hologram.
- [ ] Removing holograms and paging the gallery returns renderer geometry and
      texture counts to the baseline for what remains in the space.
- [ ] Exit destroys the World and returns to the feed at the last focused
      hologram.
- [ ] Capture's panels are built only from the shared package and capture
      recording, refit and recenter pass the capture XR suite.
- [ ] Side-by-side IWER screenshots of capture and viewer panels show the same
      components, styling and follow behavior.
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
| Focus ambiguity when holograms overlap | Last selected wins; focused one shows a ring; panel shows its title |
| Audio of an unfocused hologram keeps playing | Focus change stops audio on the old one and starts the new one from its clock |
| Grab and panel pointer target the same input | IWSDK pointer priority (touch > grab > ray); panels sit above grab targets |
| GLB with a wrong root scale looks absurd at 1.0 | Scale chip makes it visible and reversible; log recorded-scale anomalies; no silent normalisation |
| Static hologram (no clip) | Timeline/play disabled, "still" state; static GLB fixture |
| Autoplay blocked | `AudioContext.resume()` inside the first XR select (feed resume does not carry over) |
| World not torn down on exit or route change (leaked render loop, XR session) | `world.destroy()` on unmount; e2e enters and exits twice and checks one canvas, no session |
| Duplicate `three` copies across packages | Structural flags, not `instanceof`; typecheck catches clashing `@types/three` |
| Panel out of reach (tall, short, seated) | `Follower` offset from head height; recenter re-seats it |
| Session ends unexpectedly | Same exit path as the Exit control |
| Capture recording regresses while its panels migrate | Capture XR suite before and after; migration is its own commit, last |

## Ownership

Implementation order (each step lands green before the next):

1. **Spikes** (decide go/no-go): phone AR tap on an IWSDK panel; IWSDK input and
   spatial UI inside capture without breaking recording or production builds.
2. **IWSDK viewer shell**: `/vr/:id` and `/ar/:id` mount a World with one
   hologram at recorded scale, AR hit-test/anchor placement ported,
   `HologramPlaybackSystem` with audio, exit/teardown.
3. **Shared UI package** `@holoim/xr-ui-iwsdk` and the focused-hologram panel
   in the viewer; grab/scale.
4. **Gallery and multiple placed holograms**, focus, feed paging, disposal.
5. **Capture migration** onto the shared package; retire `xr-ui-three` and
   `xr-ui-r3f`.

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, shared UI API, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Re-review of this revision before step 2 |
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
  interface is IWSDK-native: `PanelUI`/UIKit panels, `Follower`, IWSDK
  pointers and grab components. The capture-specific reasons IWSDK input, UI
  and audio were switched off (`docs/IWSDK_AI_WORKFLOW.md`,
  `archive/iwsdk-runtime-refactor.md`) are re-tested in the step 1 spike;
  audio stays app-side in both apps.
- **What stays app-side:** animation playback (IWSDK has none) and audio seek
  live in a viewer `HologramPlaybackSystem`; AR placement rules from
  `arPlacement.ts`.
- **Feed stays R3F.** The flat feed and portal are not XR; rewriting them buys
  nothing. Entering XR navigates to the IWSDK route.
- **Same behavior everywhere.** Capture's panel changes from head-locked to
  lazy-follow and gains ray/pinch alongside poke — intended changes that make
  the two apps identical.
- Alternatives rejected: plain-Three shared panel hosted in both IWSDK and R3F
  (hand-rolls what IWSDK provides); keeping the viewer on R3F with
  `@react-three/xr` (two stacks for one interface).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Spikes | Throwaway IWER runs (phone AR tap; capture with input + UI on) and a production build, 2026-10-24 | **Both GO**; results in "Step 1 spike results" below |
| VR entry, recorded scale, teardown | New IWER spec `xr-viewer.spec.ts` (Quest 3 profile) in `test:xr:viewer` | Screenshot + `xr-viewer-report.json`; pending |
| Gallery, multiple placed, focus, audio focus | Same spec on a seeded 12-item feed | Report with entity states + screenshot; pending |
| Playback, scrub, loop, audio scheduling | Same spec, clock and audio offsets read from the page | Drift numbers in report; pending |
| Grab/scale/rotate | Same spec, scripted controller grips | Transforms in report; pending |
| Memory after remove/page | Same spec | Geometry/texture counts in report; pending |
| AR placement + phone tap | Ported AR specs with IWER phone profile | Pass output; pending |
| Capture on shared panels | `pnpm run test:xr:smoke` + capture record/refit checks | Pass output + capture panel screenshot; pending |
| Same look in both apps | IWER screenshots of both panels via `preview.mjs` | Side-by-side sheet; pending |
| Pipeline compatibility | `pnpm run test:smoke:pipeline` | Pass output; pending |

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
  remove it in the same change that adds the shared panel. The default
  UIKit font lacks `·` and `×`; panel copy avoids them or the shared
  package ships a font that has them.

### Video verification loop

Every step, including each spike, ends with a real-time proof video of the
real workflow in IWER (headset view plus a spectator view where it helps:
entering, gallery, placing, grabbing, scrubbing, focus and audio switching,
exit; for capture, record → stop → export on the shared panels). The
implementer previews it as a contact sheet
(`node packages/tooling-testing/src/preview.mjs`), fixes what it shows, and
re-records until it is clean; the lead sends the final video to the user as
proof. Videos and their recording scripts stay in the ignored `output/`
directory or the scratchpad: never committed or linked from docs. Durable
evidence is the e2e specs and their `*-report.json`.

## Physical-device limits

IWER proves session, input, scheduling and memory behavior only. On devices:
Quest 3 VR comfort, frame rate with four placed holograms, panel reach and
readability, grab/pinch/poke feel, audio by ear, recorded-scale realism; Quest
passthrough AR; Android phone AR tap; capture panel feel after migration.
Record results here; until then they stay under Unverified in `HANDOFF.md`.
