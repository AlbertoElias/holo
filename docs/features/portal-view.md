# Feature brief: Portal view

**Lead:** Claude Code  
**Status:** Verifying

Product decision and trial plan: [PRD-002](../product/prds/PRD-002-portal-view.md).

## User outcome

On a phone or computer, a viewer can freeze a hologram, look around the frozen
moment, zoom from inside the scene out to the hologram as an object, and return
to the author's framing, without breaking feed browsing.

## Scope

**Included:** feed-card camera modes (Follow, Free), pause and resume with
audio kept in sync, orbit, the zoom continuum, Return, the three interaction
variants (`freeze`, `drag`, `tilt`) selected by `?portal=`, phone orientation
with the iOS permission flow, keyboard controls, a portal e2e check on a real
capture export with screenshots.  
**Excluded:** WebXR camera tracking on phones, the pointing-driven Follow
camera (IDEA-041), scrubbing, headset viewing, the meaning layer, the visual
redesign, Quick Look, and the existing AR route.

## Acceptance criteria

- [ ] Pausing stops animation time and audio together; resuming continues both
  from the same moment. (Animation verified; audio is wired to restart at the
  animation time but the test capture has no audio, so it is unverified.)
- [x] Orbiting in Free keeps the camera's distance to the focus and the focus
  on the author; paused, the focus stays fixed.
- [x] Zoom runs from inside the recorded bubble (camera within its radius) to
  the Follow distance, clamped at both ends, without rescaling the model.
- [x] Return restores the Follow framing.
- [x] In `freeze`, gestures only explore while paused; in `drag`, sideways
  drags orbit while vertical swipes still scroll the feed; in `tilt`, device
  orientation turns the camera once enabled.
- [x] A card that becomes inactive returns to Follow and playing, and releases
  its gestures.
- [x] All controls work by keyboard and have accessible names.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Portal gestures trap the vertical feed | `touch-action` follows the variant and pause state; e2e scrolls to the next card on a phone viewport |
| Tap meant as a pause is read as a drag, or the reverse | Movement and duration thresholds; e2e taps and drags separately |
| Audio and motion drift after pause/resume | Audio restarts at the mixer's time; e2e compares both clocks |
| Orbit passes under the ground or flips at the poles | Pitch clamped; e2e drags far in both directions |
| Zoom ends outside the bubble's world or inside the avatar | Distance clamped to [inside, Follow]; e2e checks both ends |
| Free camera keeps chasing an avatar that walked away | Focus tracks the author while playing, frozen while paused |
| Entering Free jumps the camera | Free starts from the current Follow pose |
| Inactive cards keep Free state or listeners | Reset on deactivate; listeners scoped to the card |
| iOS refuses motion permission | Tilt stays off and drag still works; button reports the refusal |
| GLB without a bubble (older exports, plain avatars) | Inside distance falls back to a fixed eye-level distance |
| Test hooks leak into production | Probe exposed only in dev builds, as today |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code | Brief, PRD-002, integration, handoff |
| Design reviewer | Claude Code (sequential; no separate agent requested) | Review before implementation |
| Implementer | Claude Code | `apps/viewer-web/src/features/portal/`, `feed/HologramCard*.tsx`, `hologram/useGltfAudio.ts`, `styles/global.css` (portal rules only), `e2e/portal.pipeline.spec.ts` |
| Independent verifier | Claude Code (sequential) | E2E run and screenshots |

## Design decision

Actions are separate from triggers, so each trigger can be switched on, off,
or swapped per variant:

- `portalState.ts`: pure state and camera math (Follow pose → Free orbit,
  zoom continuum in log distance, clamps, Return blend).
- `usePortalController.ts`: one store per card with the actions `togglePause`,
  `orbitBy`, `zoomBy`, `setTilt`, `returnToFollow`, `reset`.
- `portalTriggers.ts`: pointer tap and drag, pinch, wheel, keyboard and device
  orientation, each enabled by the variant table in `portalVariant.ts`.
- The card canvas reads the store each frame: Follow keeps today's framing;
  Free places the camera on a sphere around the author's hips-to-head
  midpoint.

Alternatives considered: drei `OrbitControls` (fights the feed's scroll, owns
its own state, and cannot express the zoom continuum or variants); a separate
detail page (IDEA-058; defers the question of how viewing works in the feed).

Review changes: Free starts from the live Follow pose; audio resumes at the
mixer time instead of restarting.

Implementation change: zooming in grows the bubble to cover the screen, which
first magnified the view (only the canvas centre was visible). The field of
view now widens with the canvas, so opening the bubble reveals more of the
scene at the same scale; the zoom continuum comes from camera distance only.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Pause, orbit, zoom, Return, feed scroll | `pnpm run test:smoke:pipeline` (`portal.pipeline.spec.ts`, real capture export) | Passed 2026-10-19 with the other two pipeline specs (3/3, 4.9 min): frozen action times while paused, yaw +0.3 rad from a 240 px drag at constant distance and fixed focus, pitch clamped at −8° and 78°, zoom 0 inside the bubble radius with model scale unchanged, Return at the Follow distance, keyboard Space/arrows/Escape, reset on scroll away |
| Variants on phone and desktop | same spec at 390×844 touch and 1280×860, `E2E_SCREENSHOTS=1` | freeze: swipe scrolls while playing, not while paused, pinch moves in; drag: sideways swipe orbits while playing and vertical still scrolls; tilt: 6° deadzone, then yaw −1.5× the phone turn. Screenshots: [`evidence/portal-view.jpg`](evidence/portal-view.jpg) |
| Existing viewer behaviour | `pnpm run test:xr:viewer`, viewer unit tests, lint, typecheck | 5/5 mocked AR and feed specs, 35/35 unit tests |
| Recipient trial | PRD-002 trial | pending (needs a headset recording) |

## Observations

- Every feed card owns a WebGL context. With several uploads in the feed and a
  second page open, the browser stopped rendering new cards until the first
  page closed. Not caused by this feature, but a long feed on a phone may hit
  the same limit.
- The Follow camera sits at a fixed world direction, so scene geometry (a
  rock) can hide the author in Follow; Free lets the viewer move around it.

## Physical-device limits

Emulated touch and orientation in Playwright prove the logic, not the feel.
Phone checks on a real iPhone (motion permission, tilt comfort) and Android
are required before the trial.
