# Feature brief: Put an object back and remove a tray item

**Lead:** Claude Code (Opus), session `tray-remove`
**Status:** Ready to merge (branch `claude/tray-remove-aa6e28`)
**Layer:** event (what is in the take and when it leaves) and view (the
tray's chrome, which never enters the recording); see
`docs/product/concepts/what-a-hologram-is.md`

## User outcome

From the queue item (2026-10-28): nothing clears between takes, so a carried
object stays in every later take, and the tray only fills up to its five
slots. The author needs a way to take an object out of the scene and to
remove an item from the tray, on desktop, phone and headset.

When this is done the author can, before or during a take, take a placed
object out of the scene, and the viewer sees it leave at that moment. They
can also free a tray slot so Find can fill it with something else. Both work
on desktop, a touch phone, a headset with controllers or hands, and the
phone AR camera author.

## What exists (2026-10-29)

- `SceneObjectRegistry.remove` already detaches an object and its physics
  body; nothing calls it. `ObjectInteraction.update` drops a hold whose
  object left the registry, but not an in-flight reach or glide.
- The sample store keeps a removed object's track, and `buildObjectExports`
  already writes a presence that ends before the take ends (null samples,
  a discrete 0/1 scale track). So a removal mid-take exports correctly
  today; only the gesture is missing (`summon-and-place.md` foresaw this).
- The tray has `clear()` but no single-item remove. Slots are numbered
  `items.length + 1`, and thumbnails, the UI and desktop keys 1–5 all key
  on the slot number.
- A scene object is a `clone(true)` of its tray item and shares geometry,
  materials and textures with it. Removing a tray item must not dispose
  them while a clone is in the scene or a take may still export.

## Decisions (the user, 2026-10-29)

Chosen from the live mockups
(<https://claude.ai/artifact/P6vP1MNJdBcnmxkzfHQL95>, 2026-10-29: the flat
options as working mocks, headset and phone AR sketched).

1. **Put it back into the tray** (option A). Holding is the selection in
   capture (`object-resize-and-move.md`), so the author puts back what they
   hold. The phone AR author, who holds nothing, aims the reticle.
2. **Lift it off the shelf** (option A) on flat screens: drag a tray slot up
   off the row and let go.
3. **In a headset, a cross ring per miniature.** A squeeze or pinch on a
   miniature already summons, so pulling one off the arc cannot also remove
   it. A small Close ring sits above each miniature while the arc is open.
4. **A put-back during a take is part of the event.** The object's presence
   ends at that frame, and the viewer sees it go.
5. **No "clear the scene" action** in this change.

## Scope

**Included:**

- **Put back (the action).** `CaptureObjects.putBack(object)`: release the
  hold and cancel any reach, settle or glide on it, then
  `registry.remove(object)`. The object leaves on that step, so the sample
  store's track for it ends at the previous frame, and the export writes its
  presence ending there (`objectExport.ts` already handles this). It does
  not animate in the world: a shrink would be recorded as a resize. The tray
  slot it came from highlights for 400 ms (flat row, headset ring, phone AR
  ring). Objects remember the tray item they came from (a `WeakMap` in
  `CaptureObjects`); with that item gone, the object still leaves, and no
  slot highlights. A carried object with no tray item (the `?object=`
  prepared prop) can be put back as well: it leaves the scene.
- **New glyph: Put back**, an arrow down onto the tray's shelf, the mirror
  of Upload: `M1.5 13.5h13M8 1.5v10M4.8 8.3 8 11.5l3.2-3.2` (the arrowhead lands on the shelf). Provisional
  (`provisionalGlyphs.ts`, like Find) until the user approves its drawing,
  then into `tokens.json` and the styleguide's glyph table.

  | Device | Put back the held object | Remove a tray item |
  | --- | --- | --- |
  | Desktop | `Backspace` or `Delete` while holding, or the dock's **Put back** glyph, shown only while holding | With the tray open, drag a slot up off the row (more than 30 apx up) and let go; under 22 apx of movement it is still a click that summons |
  | Touch phone | The dock's **Put back** glyph, shown only while holding (44 apx) | The same drag on the row |
  | VR, controllers and hands | Open the tray (left palm up, or hold Y), carry the held object into the arc (`PUT_BACK_ZONE_M`, 12 cm of a miniature: tighter than `TRAY_ZONE_M`, so a catch beside the tray stays a catch) and let go: put back instead of a drop. The slot it came from shows the Put back glyph while the object is over the arc | A Close ring above each miniature while the arc is open (UIKit, 56 apx ray / 72 apx poke hit): poke with the dominant index, or the dominant ray and trigger |
  | Phone AR (camera author) | With the tray open, the centre ray also hits placed objects; the reticle turns cream over the one it would put back and the AR dock shows **Put back**; tap it | A Close ring above each filled slot of the UIKit row, 44 apx hit (the row commits on press, so a slide is not reliable there) |
  | Quest passthrough | None (a spectator) | None |

- **Remove a tray item.** `ObjectTray.remove(item)`: `registry.remove` on
  the item's authoring object, splice it out and renumber the remaining
  slots 1 to N, so the keys stay in order. Thumbnails are keyed by the item,
  not the slot number, so they follow it. Nothing is disposed: summoned
  copies share the item's geometry, materials and textures, and stay in the
  scene. A load in flight lands in the next free slot as before.
- **Chrome while recording (8.5).** Put back is part of the take, like Tray
  and Find, so it stays while recording; it shows only while something is
  held (flat) or under the reticle (phone AR). `SHOWN_WHILE_RECORDING`
  gains `putBack`.
- **Help** (`captureHelp.ts`) says how to put back and remove on each
  device.

**Excluded:**

- Undo of a put-back or a removal; a "clear the scene" action (decision 5);
- reordering the tray, or a tray larger than five items;
- dismissing from Quest passthrough (a spectator);
- putting back an object that is not held, other than the phone AR reticle;
- disposing a removed item's GPU resources (left to garbage collection).

## Acceptance criteria

- [ ] **Desktop, before a take:** summon slot 1, press Backspace: the object
  leaves the registry, and the hand is empty. Summon again, click the dock's
  Put back: the same. Delete does the same.
- [ ] **Desktop, during a take:** an object carried in from before the take
  is put back at about 1 s of a 3 s take. The export validates and has it as
  `prepared`, with one presence span ending within one frame of the
  put-back.
- [ ] **Desktop tray:** with three items, drag slot 2 up off the row: the
  tray has two items, the old slot 3 is now slot 2 with its own thumbnail,
  and T + 2 summons it. A click on a slot (no drag) still summons. Objects
  summoned from the removed item stay in the scene.
- [ ] **Touch (phone size, touch emulation):** the Put back glyph shows only
  while holding, at 44 apx, and a tap puts back. A touch drag up off a slot
  removes it; a tap still summons.
- [ ] **VR (IWER, controllers and hands):** with the tray open, a held
  summoned object let go inside the arc's zone is put back (no throw, gone
  from the registry); let go outside, it drops as today. The cross ring of
  slot 2, poked (hands) or selected by ray and trigger (controllers),
  removes that item.
- [ ] **Phone AR (camera author, emulated):** with an object placed and the
  tray open, aiming at it shows Put back; a tap removes it, and the camera
  take's export ends its presence at that frame. The cross ring on a slot
  removes the item.
- [ ] **Help** on each device says how to put back and remove.
- [ ] **No regression:** `test:xr:summon`, `test:xr:object`, `test:xr:ui`,
  the AR record check, and `verify:pr`.
- [ ] **Design:** a different-vendor reviewer checks screenshots of each
  device against the styleguide before the user sees them.

## Failure cases considered

| Failure case | Prevention or evidence |
| --- | --- |
| Removing an object mid-reach or mid-glide leaves a dangling reach | Release the hold and cancel the reach before `registry.remove` |
| A tray item's geometry is disposed while clones use it | Never dispose on remove; the GC reclaims it once nothing references it |
| Slot renumbering after a remove leaves stale thumbnails or keys | Thumbnails move with the item, not the slot number; the check removes slot 2 of 3 and summons the new slot 2 |
| A remove during a load lands the load in the wrong slot | `loadTrayNow` assigns the slot when the load lands; the check removes while a load is in flight |
| A put-back mid-take loses the object's track | The sample store keeps it; the check asserts presence ends within a frame of the put-back |
| The put-back gesture also summons, places or throws | The check asserts no new object and no throw velocity |
| Backspace in the Find field puts back the held object | `isTextEntry` already suppresses game keys; the desktop check types and deletes in the field while holding |
| A VR release in the arc during a stretch, or by the stretching hand | Only the holding hand's release puts back; a stretch hand letting go stays a stretch end |
| A swing that ends over the arc reads as a put-back | Put back needs the tray open and the palm in its zone; the check also lets go outside the zone and expects a drop |
| The phone AR reticle on an object also places onto it | A tap on a slot still places on the set or floor hit behind the object; Put back acts only on the object under the reticle |
| A drag that leaves the row sideways removes by accident | Only an upward drag past 30 apx removes; a sideways or short drag snaps back |
| Put back while the take exports | Objects are frozen during export; the dock hides Put back while exporting, like Tray |

## Ownership

| Role | Owner | Files or modules |
| --- | --- | --- |
| Lead | Claude Code (Opus) | Brief, integration, handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only, after the user's choice |
| Implementer | Claude Code (Opus, the lead) | `objects/CaptureObjects.ts`, `objects/ObjectTray.ts`, `objects/ObjectInteraction.ts`, `objects/ArPlacement.ts`, `input/InputController.ts`, `ui/TrayRow.tsx`, `ui/CaptureOverlay.tsx`, `ui/XrTraySignifiers.ts`, `ui/PhoneArChrome.ts`, `ui/captureHelp.ts`, `packages/xr-ui-core` (glyph, recording chrome) |
| Checks | Claude Code subagent (Sonnet) | `scripts/lib/put-back-take.mjs`, phases in `scripts/ci-summon-playwright.mjs`, the AR record check |
| Independent verifier | Codex or Muse | Read-only verification against this brief |

## Design decision

The user chose, on 2026-10-29: put back into the tray (not a discard or a
throw), lift a slot off the shelf to remove it, a put-back mid-take is
recorded, and no "clear the scene". For the headset they chose a Close ring
above each miniature (poke with the dominant index; with controllers, the
dominant ray and trigger). The mockups are linked above.

Deviations from the plan above, made while building:

- **Phone AR removes with the Close glyph, not a lift.** The UIKit row
  commits on press, so a drag off it is not reliable; a bare Close cross
  above each filled slot, 12 apx clear of the slot's 44 apx hit.
- **The VR put-back zone is tighter than the tray's zone.** Letting go with
  the right palm within 12 cm of a miniature (`PUT_BACK_ZONE_M`) puts back;
  the 25 cm `TRAY_ZONE_M` caught objects let go beside the open tray, which
  the existing summon check (a catch 22 cm from a miniature) caught.
- **A hands ray never removes.** A tracked hand's ray selects with the pinch
  that summons the miniature under it, so only a fingertip poke removes
  with hands; controllers use the ray and trigger.
- **The phone AR row leaves the layout while closed.** Its Close glyphs made
  the row taller, and a hidden UIKit panel still takes the screen's ray, so
  a camera take's hold on the bracket low on the screen began on chrome and
  never marked (the camera-take pipeline check). Closed, the row's chip is
  `display: none`; a hidden Close takes no pointer either.
- **A hold that starts on an object still resolves to it if the object is
  put back mid-hold** (`PointResolver.resolveCamera` checks presence at the
  hold's start, as before). Also checking its end dropped the camera take's
  link to the bracket in the pipeline check, so it was left out.

Cross-vendor review (Muse; Codex was at its usage limit) of the desktop,
touch, headset and phone AR screenshots, 2026-10-29. Adopted:

- A sideways drag that rose past the line removed the item: now a lift must
  be more up than sideways (and a check covers it).
- A slot lifted past the line looked like a press: its border turns cream,
  like an armed slot, until it is let go.
- A slot focused from the keyboard had no focus ring: the gold 1.5 apx ring,
  3 apx out (§6).
- The Put back arrowhead now lands on the shelf, so it reads as onto the
  tray rather than a download.
- The headset Close ring highlights on hover or a fingertip near it (§6).
- The phone AR Close sat 4 apx above its slot: now 12 apx (§6's glyph gap).
- The brief promised the aimed object brightens in phone AR; it is the
  reticle that turns cream, and the Put back button appearing carries the
  state without colour.

Not adopted: the ring around the headset Close (the user chose a ring, and
the tray's pinch and squeeze glyphs already sit in one, approved in 8.5);
separate ray and poke hit areas (the 72 apx poke hit already exceeds the
56 apx ray minimum); the returning-slot glyph pointing at a foreign slot
(`returnSlot` is always the object's own source slot); and the tray row's
bare captions and truncation, which predate this change (the tray-everywhere
row) and belong to a separate pass.

## Test plan and evidence

All end to end, in the repository's harness, on this worktree's own ports
(`DEV_PORT=5430`). `pnpm --filter @holoim/capture run test:xr:summon`, 16
phases, passes; five are new:

| Phase | Device | What it proves |
| --- | --- | --- |
| `desktop-put-back` | Desktop | Backspace while holding puts back; Backspace in Find's text does not; the dock glyph shows only while holding; a sideways, a diagonal and a short drag snap back; a lift past 30 apx removes slot 2, slots renumber and thumbnails follow; a copy in the scene stays; a mid-take summon and put-back export with the object's presence ending at the put-back frame (matches capture to the frame) and the removed item's copy present the whole take |
| `touch-put-back` | Touch phone | The same lift with a touch drag; the dock's Put back at 44 apx |
| `tray-budget` | Desktop | A removed item whose copies remain still counts toward the tray's byte budget |
| `put-back-controllers` | IWER controllers | Carry into the arc shows the Put back glyph on the source slot; let go puts back; a ray and trigger on a Close ring removes |
| `put-back-hands` | IWER hands | The same with a pinch carry and a fingertip poke; the hands ray does not remove |

`pnpm run test:xr:ar-record` gains `phone-put-back` (IWER phone AR): the
reticle on a placed object turns cream, Put back appears and removes it from
the take, and the Close glyph removes a tray item. `test:xr:object`,
`test:xr:ui` and `packages/xr-ui-core` unit tests (recording chrome) pass.
The summon check's time limit is now 300 s (16 phases, about 110 to 130 s
locally). `pnpm run verify:pr` passes (see `HANDOFF.md`).

Pre-existing, not changed here: under SwiftShader with the manual clock, a
second heavy item's thumbnail read-back can stall, so `tray-budget` judges
the budget from the refusal's size rather than a second load.

## Physical-device limits

IWER emulation only. On a Quest, check that the 12 cm put-back zone feels
right (a carry into the arc puts back, a catch beside it does not), that the
Close ring is easy to poke without summoning the miniature under it, and the
trigger on a controller ray. On an Android phone in AR, check that the
reticle finds small placed objects and that the Close glyph above a slot is
not hit by a summon tap.
