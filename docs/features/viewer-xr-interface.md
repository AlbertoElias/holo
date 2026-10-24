# Feature brief: Shared XR interface and viewer VR/AR

**Lead:** Claude (Opus)  
**Status:** Reviewed (awaiting user approval)
**Layer:** view (see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

A recipient on a headset can step into a hologram in VR, and a recipient on a
phone or headset can place it in their room in AR. In both, they control the
recorded event the way they would a video — play, pause, restart, scrub — move,
scale and rotate it, and go to the next or previous hologram in their feed
without leaving the immersive session.

Capture and viewer present **one XR interface**: the same panel, components,
placement and interaction, differing only in the actions each app supplies.

Product framing: on flat screens the screen is a portal; in a headset the
portal disappears and the recipient stands in the event. VR therefore uses a
minimal neutral space. True scale is fact: life size means the recorded scale.

## Scope

**Included:**

- **One XR interface for capture and viewer.** Shared packages own the panel,
  its components (button, toggle, timeline slider, label pill, status line),
  placement (lazy-follow anchor), hover/press feedback, the input router
  (controller ray + trigger, hand pinch, hand poke) and the grab/two-hand
  manipulator. Both apps get identical look and behavior; capture supplies
  record/stop, refit and recenter, the viewer supplies the actions below.
  Capture's `VrRecordingPanel` and `VrHud` migrate onto the shared panel.
- **VR entry.** New `/vr/:id` route starting an `immersive-vr` session. The
  feed card shows a VR trigger when `immersive-vr` is supported, alongside the
  existing AR trigger (a Quest shows both: AR is passthrough, VR is the neutral
  space).
- **VR space.** Soft neutral floor and horizon; hologram at recorded scale on
  the floor about 1.5 m in front of the viewer.
- **Viewer actions** in both `/vr/:id` and `/ar/:id`: play/pause, restart,
  scrubbable timeline with elapsed/total, previous/next hologram, recenter,
  exit, and a scale chip showing the current scale with "life size" reset.
- **Phone AR** keeps the DOM overlay for the panel (tap). It uses the same
  action model and state from `xr-ui-core`, not the Three rendering.
- **Playback.** One clock drives the animation mixer and audio together. AR
  gains audio (it has none today).
- **Move / scale / rotate.** Grab to move, two-hand grab to scale and rotate
  about the vertical axis; one-finger drag / two-finger pinch on phone AR.
  Default is recorded scale (1.0); any other scale is a labelled, reversible
  choice clamped to 0.1×–2× recorded scale.
- **Feed browsing in XR.** Previous/next swaps the hologram inside the same
  session in feed order, preloading neighbours and fetching the next cursor
  page when needed; the URL is replaced so exit returns to the right card.

**Excluded:**

- Flat-screen portal behavior (`portal-view.md`).
- iOS Quick Look (native viewer; no app controls).
- Capture-time environment in VR; meaning-layer UI in XR; multi-viewer
  sessions; phone `immersive-vr`.
- Switching between AR and VR mid-session.

## Acceptance criteria

- [ ] On a device reporting `immersive-vr`, the feed card shows the VR trigger;
      activating it enters VR with the hologram at recorded scale on a neutral
      floor ~1.5 m ahead. Devices without it show no VR trigger; AR trigger and
      Quick Look rules are unchanged.
- [ ] AR and VR place the hologram at recorded scale (1.0) by default — the
      current 1.85 m normalisation is removed — and the scale chip reads
      "life size".
- [ ] In headset VR and AR the panel appears within reach, lazily follows the
      viewer, and every control works by controller ray + trigger, hand pinch
      at a distance and hand poke up close. In phone AR every control works by
      tap on the DOM overlay.
- [ ] Pause freezes animation and audio at the same clip time; play resumes
      there; restart returns both to 0; looping wraps both together.
- [ ] Scrubbing shows the pose at the chosen time, and the scheduled audio
      offset matches clip time within 50 ms (measured as
      `ctx.currentTime − startedAt + offset` — proves scheduling, not ear sync).
- [ ] Grab moves the hologram; two-hand grab scales (clamped) and rotates about
      the vertical axis; recenter restores default placement and recorded scale.
- [ ] Next/previous swaps to the neighbouring hologram without ending the XR
      session, shows loading inside the panel, crosses page boundaries via the
      feed cursor, and is disabled at either end of the feed.
- [ ] After browsing 10 holograms and returning, renderer geometry and texture
      counts return to within the current+neighbours baseline.
- [ ] Exit returns to the feed scrolled to the hologram last shown.
- [ ] Capture's VR/AR panel is drawn and hit-tested only by the shared
      packages; capture recording, refit and recenter pass the capture XR suite.
- [ ] Side-by-side IWER screenshots of the capture and viewer panels show the
      same components, styling and placement behavior.
- [ ] `/ar/:id` deep links work; existing AR placement, recenter and bubble
      specs pass; export → upload → render pipeline smoke passes.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Viewer AR has controllers, hands and screen input disabled (`useArController.ts`) because IWER threw on input frames | Step 1 re-enables input under IWER and fixes the throw; e2e enters AR and VR with controllers and hands |
| Next/prev unmounts the canvas (ARView swaps to a DOM notice on `isLoading`), ending the session | Shell stays mounted for the session; hologram id is shell state; URL changes via `navigate(..., {replace:true})`; loading drawn in the panel |
| Disposing a model breaks drei's `useGLTF` cache (clones share geometry/textures) | Dispose only the clone's own materials, stop the mixer (`uncacheRoot`), `useGLTF.clear(url)` only for evicted ids; keep current + neighbours |
| Double press on next/prev during a load | Load keyed by id; stale results discarded; e2e double-press case |
| Neighbour fails to load or 404s | Error in panel, current hologram stays, controls usable |
| Neighbour lies past the loaded feed page | Feed list and cursor passed in router state; fetch next page; deep link fetches its own neighbours |
| GLB with wrong root scale looks absurd at 1.0 | Scale chip makes it visible and reversible; flag recorded-scale anomalies in console diagnostics, no silent normalisation |
| Static hologram (no animation clip) | Timeline/play disabled, "still" state; static GLB fixture |
| No audio or autoplay blocked | Clock runs alone; `AudioContext.resume()` inside the first XR select handler (feed resume does not carry over) |
| Audio and animation drift over many seeks or loop wraps | Clock owns `mixer.setTime` (clip time × timeScale, incl. secondary actions); audio restarts from clock on play/seek via a `seekVersion`; check after 20 seeks |
| Old audio buffer survives a model swap | Audio hook drops and stops the old buffer when the hologram changes |
| One select fires twice in the viewer (router + @react-three/xr pointer events on `<primitive>`) | Panel `raycast` is a no-op; only the shared router hits the panel |
| Grab and panel ray target the same input | Panel hits win; grab only starts on a miss |
| Capture input differs (direct `renderer.xr.getController` listeners, poke with 1.2 s rearm) | Router takes a per-host adapter (ray origin/dir, select edge, pinch edge, fingertip); poke and ray/pinch both enabled in both apps |
| Capture recording regresses while its panel migrates | Capture XR suite before and after; migration is its own commit, last |
| Duplicate `three` copies across packages | Structural flags, not `instanceof`; typecheck catches clashing `@types/three` |
| Panel out of reach for tall, short or seated users | Placed from head height at session start and on recenter |
| Session ends unexpectedly (headset off, system menu) | Existing session-end path returns to the feed |
| Phone AR tap on panel also triggers placement | DOM overlay consumes the event |

## Ownership

Implementation order (each step lands green before the next):

1. Viewer input under IWER — `apps/viewer-web/src/features/ar/useArController.ts`.
2. Persistent immersive shell, in-session swap with disposal, `/vr/:id`,
   recorded scale — `apps/viewer-web/src/features/xr/` (new),
   `features/ar/` (adopt shell), `app/router.tsx`, feed navigation state.
3. Playback clock and seekable audio — `features/xr/`, `hologram/useGltfAudio.ts`
   (after portal-view merges).
4. Shared panel and interaction packages, used by the viewer —
   `packages/xr-ui-core/`, `packages/xr-ui-three/`, `packages/xr-ui-r3f/`.
5. Capture migration — `apps/capture/src/ui/VrRecordingPanel.ts`,
   `apps/capture/src/ui/VrHud.ts`, `createCaptureRuntime.ts` wiring.

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, final handoff, steps 4 API design |
| Design reviewer | `design-reviewer` subagent (Opus) | Done; findings applied below |
| Implementer | Claude (Sonnet) subagents, one step at a time | Paths per step above; new spec `apps/viewer-web/e2e/xr-viewer.spec.ts` |
| Independent verifier | Codex (different vendor) | Read-only verification; test artifacts only |

**Overlaps:**

- `portal-view.md` owns `feed/HologramCard*.tsx` and `hologram/useGltfAudio.ts`
  (its brief says Verifying; the index said Implementing). The VR trigger and
  audio seek wait for its merge.
- `hand-tracking-fidelity.md` owns viewer AR checks: coordinate before editing
  `hologram-feed.spec.ts` or `ar-bubble.spec.ts`.
- `room-scale-body-motion.md` owns `tooling-testing/xr-env` and touches capture
  runtime wiring (`AppOrchestrator`, `XrSessionService`): check before steps
  1 and 5.

## Design decision

- **Persistent shell.** One mounted immersive shell per session
  (`mode: "ar" | "vr"`); AR keeps its placement state machine, VR uses fixed
  floor placement. `/ar/:id` stays and `/vr/:id` is added.
- **Shared UI is plain Three.js.** Capture runs IWSDK (ECS over plain Three),
  the viewer runs R3F; a `THREE.Object3D` is the layer both host natively.
  `xr-ui-core` defines the panel spec (`{ id, kind: button|toggle|slider|label|chip,
  label, state, onSelect/onChange }`) and interaction state; `xr-ui-three`
  renders it, owns hit-testing, hover/press, lazy-follow and the manipulator;
  each app feeds an input adapter. Capture adds the group to its scene; the
  viewer mounts it with `<primitive>`. Rendering builds on `@pmndrs/uikit`'s
  vanilla Three API if a spike in step 4 shows it runs in both hosts (it is
  the library under today's `HeadLockedActionBar`); otherwise extend today's
  `ThreeRecordingActionPanel` canvas approach. `HeadLockedActionBar` and the
  R3F-only uikit usage are retired.
- **Same behavior everywhere.** Capture's panel changes from head-locked to
  lazy-follow and gains ray/pinch alongside its existing poke — intended
  changes that make the two apps identical.
- **Playback clock** lives in the viewer and owns mixer time; `useGltfAudio`
  takes a clip-time + `seekVersion` input instead of owning time.
- Alternatives rejected: moving the viewer onto IWSDK (rewrites render path
  and AR placement); two renderers behind one spec (they drift); wrist menu
  (unusable on phones and controllers; possible later addition).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Input enabled, VR entry, recorded scale | New IWER spec `xr-viewer.spec.ts` (Quest 3 profile) in `test:xr:viewer` | Screenshot + `xr-viewer-report.json`; pending |
| Playback, scrub, loop, audio scheduling | Same spec, clock and audio offsets read from the page | Drift numbers in report; pending |
| Move/scale/rotate | Same spec, scripted controller grips (not IWER hands) | Transforms in report; pending |
| Next/prev, paging, double press, 404, memory | Same spec on a seeded 12-item feed | Report incl. geometry/texture counts; pending |
| AR unchanged + phone overlay | `hologram-feed.spec.ts` AR cases, `ar-bubble.spec.ts`, overlay actions | Pass output; pending |
| Capture on shared panel | `pnpm run test:xr:smoke` + capture record/refit checks | Pass output + capture panel screenshot; pending |
| Same look in both apps | IWER screenshots of both panels via `preview.mjs` | Side-by-side sheet; pending |
| Pipeline compatibility | `pnpm run test:smoke:pipeline` | Pass output; pending |

## Physical-device limits

IWER proves session, input, scheduling and memory behavior only. On devices:
Quest 3 VR comfort, panel reach and readability, grab/pinch/poke feel, audio
sync by ear, recorded-scale realism; Quest passthrough AR; Android phone AR
tap controls; capture panel feel after migration. Record results here; until
then they stay under Unverified in `HANDOFF.md`.
