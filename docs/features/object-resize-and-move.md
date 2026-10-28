# Feature brief: Resize and move props on every device

**Lead:** Claude Code (Opus)  
**Status:** Verifying
**Layer:** Event (see `docs/product/concepts/what-a-hologram-is.md`)  
**Builds on:** [Grab, place and throw objects with physics](archive/object-physics.md)

## User outcome

While preparing or recording a take, an author can make a capture prop
bigger or smaller and put it where they want with little effort, on every
capture device that handles props: desktop, phone (touch) and a headset
(controllers or hands). The recipient sees the prop at the size it had at
each moment, growing or shrinking as it happened, in the feed, portal,
headset and Quick Look.

Decisions taken with the user on 2026-10-28:

- **Range:** ¼× to 4× of the prop's original size, with a soft snap at 1×
  and a reset.
- **Recording:** scale is sampled every frame like position. A resize during
  a take is part of the event, and the viewer sees it happen.
- **Controls:** the natural set. A headset grabs with both hands and
  stretches. Touch pinches with two fingers while a prop is held. Desktop uses
  the scroll wheel while holding, `-` and `=` keys, and `0` to reset.
- **Moving:** add push/pull while held, and grab at a distance. Precise
  nudging is not wanted.

AR is out of scope for the same reason as in the physics brief: a headset in
passthrough and a phone AR camera take are spectators that never handle
props (`createCaptureRuntime.ts`). Resize and move come with props once AR
recording carries objects (the existing `TODOS.md` item).

## Scope

**Included**

1. **Size state.** Each `SceneObject` has a uniform `size` (1 = as loaded),
   carried by a `sizer` node between the rigid wrapper and the model (see
   Design decision). It is clamped to [0.25, 4] and shows exactly 1× while
   the size asked for is within ±6 % of 1×.
2. **Desktop resize.** While a prop is held:
   - The scroll wheel scales by ×1.1 per notch, proportional to `deltaY`, so
     trackpads are smooth.
   - Holding `=` or `-` scales continuously at ×1.8 per second.
   - `0` resets to 1×.
   - The keys are inert when nothing is held.
3. **Touch resize.** While a prop is held, a two-finger gesture anywhere
   outside the walk stick acts on the prop and never looks around. A spread
   or pinch scales by the ratio of the finger distances. The gesture locks to
   pinch or pan once one dominates past a slop, as maps do.
4. **Headset resize.** While one hand holds a prop, the other hand squeezes or
   pinches within reach of it. Both hands then hold it, and the prop scales
   by the ratio of the current to the starting hand-to-hand distance. It keeps
   following the first hand. Letting go with the second hand ends the resize
   (snap at 1×). Letting go with the first hand releases as today, and the
   second hand does not take it over.
5. **Push and pull while held.** The held prop slides along a line, 0 to 4 m
   beyond the hand:
   - Desktop: Shift+wheel, along the camera's view.
   - Touch: a two-finger pan up or down, along the camera's view.
   - Headset: the right thumbstick's Y axis, at 2 m/s, along the holding
     controller's ray (the eye through the hand would point at the floor).
     That axis was free; while a prop is held, the stick locks to its
     stronger axis, so pushing never snap-turns. Hand tracking has no stick
     and no push.

   The prop stops short of scene geometry, using a shape cast in the prop
   world, so it can't be pushed through a wall. A still release while pushed
   out (desktop and touch) lowers the prop straight down onto the surface
   under it, then lets go. This is the remote form of today's set-down,
   because the hand can't follow it there. A headset release is a plain
   drop. A swing still throws, but pushing never counts toward the throw.
6. **Grab at a distance.** The prop glides into the hand over 0.3 s and is
   then held as if picked up. Only one prop moves, and nothing else changes.
   - Desktop: a mouse press on a prop that is out of reach, up to 8 m away
     and in clear line of sight. The prop then stays held until the next
     press.
   - Touch: a tap on such a prop. A touch-and-hold still marks "this".
   - Headset: a squeeze or pinch with no prop in reach casts the
     controller's target ray up to 8 m.

   During the glide, the prop passes through other props.
7. **Physics follows the size.** `ObjectPhysics` keeps each prop's hull
   points at 1× (capped at 128) and the box fallback. On a size change it
   reshapes the collider from the scaled points (`setShape`). Density stays at 500 kg/m³,
   so mass follows the volume (s³). It rebuilds when the size has changed by
   more than 1 %, and always at the end of a gesture.
8. **Recording carries size.** The sample store records the size per frame.
   When any present sample differs from 1, the exporter writes a
   `RecordedObjectSize` child node between the wrapper and the model, with a
   linear `.scale` track. The wrapper's discrete 0/1 visibility
   track is untouched. The `HOLOIM_objects` schema is unchanged, so its
   version stays 0. Takes without a resize stay as they are.
9. **Help.** `captureHelp.ts` desktop and touch lines describe resize, push
   and pull, and grabbing at a distance. VR help gets one line.

**Excluded**

- AR (above).
- Non-uniform scale.
- Resizing a prop that isn't held. Selection doesn't exist, and holding is
  the selection.
- Resizing tray miniatures.
- Precise nudge keys.
- A visible on-screen size readout.
- A viewer-side (`apps/viewer-web`) resize of placed holograms. That one
  exists already and is unrelated.

## Acceptance criteria

- [ ] Desktop: holding a prop, wheel/`=`/`-` change its size within
  [0.25, 4]; `0` and a release near 1× restore exactly 1×; keys do nothing
  when nothing is held.
- [ ] Touch: a two-finger pinch on a held prop resizes it, and a two-finger
  vertical pan pushes or pulls it. Neither turns the camera.
- [ ] Headset (IWER): a two-hand grab-and-stretch resizes the held prop, and
  the right stick Y pushes or pulls it.
- [ ] Push/pull is clamped to [0, 4] m and stops at a wall. A still release
  while pushed out sets the prop down on the surface below. It doesn't drop
  from height.
- [ ] Grab at a distance: desktop click, touch tap and a headset squeeze or
  pinch on a prop beyond reach (≤ 8 m, in sight) bring it into the hand.
  Nothing happens for a prop behind a wall or past 8 m.
- [ ] A resized prop's collider matches its visual size. A 2× prop rests on
  the floor with its bounds' bottom within 1 cm of the floor, and its mass is
  8× the original.
- [ ] A take in which a prop is resized exports a `.scale` track. In the
  feed, the viewer shows the prop's world bounds at the sampled times within
  2 % of capture's, and Quick Look's USDZ carries the same scale samples
  (`object.pipeline.spec.ts`, a resized take).
- [ ] A take with no resize exports exactly as before: no `Size` node, and
  the existing pipeline assertions pass.
- [ ] The desktop and touch help say how to resize, push and pull, and grab
  at a distance.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A pose write (physics, placement, summon) resets the size to 1 | Size applied inside `writeWorld` after decompose; e2e asserts size survives a release and fall |
| Non-uniform or negative scale from matrix decompose drift | Uniform scalar is the only source; wrapper.scale set from it |
| Collider stays at the old size: prop floats or sinks | Rebuild on change; e2e checks resting height of a 2× prop |
| Collider rebuilt every frame during a pinch: frame drops | Rebuild only past 1 % change; step-time stat in the check report |
| Rebuilt collider overlaps the floor and is shot up | Held props are kinematic, and the rebuild happens while held. On release, the existing release path starts from the current pose (checked by the release-after-resize case) |
| Wheel scroll leaks to camera zoom or page scroll | Wheel handled only while held, `preventDefault` |
| Two-finger touch also looks around or starts a "this" hold | While held, a second finger switches both pointers to the prop gesture; look is suppressed |
| Second VR hand steals the hold or the first-hand-wins rule breaks | Second hand only resizes; releasing the first hand releases as today |
| Pushing through a wall, or out of the scene bounds | Shape cast clamps the push; the bounds reset still applies |
| A pushed-out release drops from height | Remote set-down lowers it to the surface first |
| Distance grab through a wall | Line-of-sight check with the scene (the same `sceneBlocks` ray) |
| Old viewers or old takes break on the new track | No schema change; old takes have no `Size` node; mixer plays `.scale` generically |
| USDZ zero-scale clamp hides a ¼× prop | `HIDDEN_SCALE` applies only to the 0 visibility values on the wrapper; size is on the child |
| Conflicts with avatar-physics and tray-ui sessions | Edits kept to focused hunks; rebase and re-run checks before merge |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only |
| Implementer | Lead (capture interaction, physics, input); a subagent for the e2e spec extension | `apps/capture/src/objects/*`, `physics/ObjectPhysics.ts`, `input/*`, `recording/objectExport.ts`, `ui/captureHelp.ts`, `scripts/lib/object-*.mjs`, `apps/viewer-web/e2e/object.pipeline.spec.ts` |
| Independent verifier | Codex (`-p standard`) | Read-only verification and test artifacts |

## Design decision

The design review (Opus `design-reviewer`, 2026-10-28) changed the plan as follows:

- **Size lives on a node, in capture as in the export.** The registry builds
  wrapper → `sizer` → model, and `SceneObject.size` is a scalar the sizer
  carries. The wrapper stays rigid, so every reader that treats it as rigid
  is unchanged: `rigidPose`, the grab offset, `inHandPose`, `place`,
  `snapshot` and the sample store. `Box3.setFromObject(model)` follows the
  size, so reach, pick and the grasp point follow it too. The size is
  recorded as a scalar per frame (`ObjectTrackSamples.size`). It is never
  recovered from the matrix, where a height-fit mismatch would leak in.
- **Export.** A resized object gets a `RecordedObjectSize` child with a
  linear scale track, and its rest scale is the rest frame's size. The name
  avoids the `RecordedObject_` prefix the viewer counts objects by. The
  viewer and USDZ play it through their generic TRS paths, so the schema is
  unchanged.
- **Meaning.** In a camera take, a "this" on an object resolves local to the
  size node when one exists, so the mark sits on the surface. Only camera
  takes resolve onto objects, and a camera author cannot resize during a
  take, so in practice this covers a prop resized before the take.
- **Physics.** Hull points are kept at 1×. A uniform scale doesn't change
  which points are extreme, so a resize is `collider.setShape` from the
  scaled points, with density set again so mass follows s³. That happens
  past a 1 % change within a gesture, and always before `release()`. A prop
  grown into a surface while held is lifted out onto it at release
  (`liftOut`, an intersection test followed by a downward shape cast). We
  chose this over clamping growth against the floor, which would cap a
  carried prop well below 4×. A growing kinematic prop shoves nearby free
  props; that is accepted.
- **Detent.** The size accumulates as a raw value on the hold, and the prop
  shows exactly 1 while the raw value is within ±6 %. So every input snaps
  back the same way, and none needs a gesture-end event.
- **Touch.** While a prop is held, a second finger joins the first in a
  gesture, even on the walk side, and the gesture locks to a pinch or a pan.
  Neither finger looks or marks during it. A lone touch on a held prop now
  lets go when it lifts as a tap rather than at the press, so a second
  finger can still pinch. Lifting the grab finger still releases.
- **Headset.** The second-hand branch runs before the first-hand-wins rule
  and ahead of the tray miniature, but only within reach of the held prop.
  When the second hand loses tracking, the stretch ends.
- **Slices.** Slice 1 is resize end to end. Slice 2 is push and pull plus
  grab at a distance. It touches the reach state machine, release velocity
  and the "this" hold, and it overlaps the in-flight avatar-physics and tray
  sessions. Review findings for slice 2:
  - Distance grab is a `fetch` phase of the reach machine.
  - Touch distance grab fires on a tap, never on a press, so touch-and-hold
    on a far prop still marks "this".
  - Line of sight is checked against the scene.
  - The prop's contacts are off while it glides.
  - The release history is cleared after a glide and while pushing.
  - The right stick locks to its dominant axis while holding and respects
    the Halo's lock. Hand tracking has no push and pull.
  - A pushed-out release in a headset is a plain drop; only desktop and
    touch get the remote set-down.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Desktop, touch, headset resize | `test:xr:object` runs `resizeDesktop`, `resizePhone`, `resizeIwer` (`scripts/lib/object-resize.mjs`) | Pass, 2026-10-28. Five wheel notches give 1.6105. A −40 px wheel stays at 1 (detent). `=` clamps at 4, `-` at 0.25, `0` gives 1. A phone spread ×2.0 gives size 2.0 with 0 rad of look. A pinch with no finger down gives 0.5 and is not released; a lone tap releases. An IWER stretch gives 1.95, and the hold is kept when the second hand lets go. |
| Physics follows size | Same runs | Mass at 2× is 8.00× the mass at 1×. A 2× and a 4× prop set down rest at min y 0.0099 (floor 0.01) with no bounds reset. A prop grown 1→4 during a set-down rests on the floor. |
| Push and pull | `pushDesktop`, `pushPhone`, `pushIwer` (`scripts/lib/object-push.mjs`) | Pass. Shift+wheel: 4 notches push 1.00 m along the view, clamped at 0 and 4 m, and stopped short of the `reach-wall` wall. A two-finger pan of 120 px pushes 1.2 m with no resize or look. The IWER stick pushes 1.02 m in 0.5 s along the controller ray (cos 1.0), with no snap turn; a sideways stick still snaps. A still release while pushed out: the hand doesn't move, the prop is lowered and let go 0.018 m above the floor with sideways speed 0, and rests at 0.0099. An IWER pushed release drops without a throw. |
| Grab at a distance | `fetchDesktop`, `pushPhone`, `fetchIwer` | Pass. A mouse press at 5.2 m glides the prop to 0.09 m from the hand and keeps it held. Nothing is fetched beyond 8 m or behind the wall. A phone touch-and-hold on a far prop marks "this" and fetches nothing, while a tap fetches it. An IWER ray at the sky fetches nothing; on the prop, it glides to 0.095 m off the palm. |
| Existing behavior | Full `test:xr:object` tier (22 takes) | Pass. One expectation changed: a mouse press on an out-of-reach prop now fetches it. The old test passed only because its press fell in the bracket's hole. |
| Pipeline carries size | `RUN_E2E_PIPELINE=1` `object.pipeline.spec.ts` (4 tests) | Pass. A resized IWER take has 329 keys and a `RecordedObjectSize` child. The viewer's size-node scale matches the GLB at 7 times (≤1 %), and its world bounds match (<0.1 % of extent). The viewer counts 1 recorded object. The USDZ size prim has 66 time samples that match the track. The unresized GLB has no size node. |
| No regression | `pnpm run verify:pr` | pending |
| Proof | Proof video in `output/proof-object-resize/` | pending |

## Physical-device limits

IWER and desktop emulation prove the logic. On devices, still to check:
- On a Quest, how the two-hand stretch feels, and the right stick's
  push/pull speed.
- Aiming a distance grab with hands.
- On a phone, telling pinch from pan.
- A trackpad's wheel deltas on macOS.
