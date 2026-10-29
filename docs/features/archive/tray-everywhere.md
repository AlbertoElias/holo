# Feature brief: The tray on every device

**Lead:** Claude Code (Opus), session `tray-ui`
**Status:** Complete
**Layer:** event (what is summoned and when it appears) and view (the
tray's chrome, which never enters the recording); see
`docs/product/concepts/what-a-hologram-is.md`

## User outcome

The user's words: "holding t shows the options with a signifier of how to
invoke each one ... it should be possible to invoke object both pre
recording and while recording. also to search them while recording". It
must work on every device.

On any device the author opens the tray and sees, on each item, how to
summon it there: the key on desktop, a tap target on a phone, the hand that
can reach it in a headset. They summon before a take to set the scene, or
during one, mid-sentence. When something is missing, they search for it
during the take and summon it a moment later. The take keeps flowing and
its export stays valid.

## Decisions (the user, 2026-10-28)

1. **Nothing is cleared between takes.** Whatever is in the scene when the
   author presses record is in the take from the first frame, at its pose,
   including objects left from the last take. (Today a take start clears
   the last take's summoned objects; that goes.)
2. **Touch: a Tray glyph on the dock, like the Halo.** Tap it to open the
   tray, then tap an item to summon it into the hand. Or press, hold, slide
   onto an item and lift. A touch on the held object lets go. The glyph stays
   on the dock during a take.
3. **Phone AR places; Quest passthrough watches.** The phone camera author
   gets the Tray glyph on its AR dock. Tapping an item puts it where the
   screen's centre ray meets the set or the floor, present from that moment.
   Quest passthrough stays a spectator: it can search and fill the tray, but
   it does not summon.
4. **Voice search works during a take, and the query stays in the audio.**
   Nothing mutes the take's microphone.
5. **On flat screens the tray is the dock row only** (option A, chosen from
   mockups). The 3D arc in front of the chest is not drawn on desktop or
   touch; headsets keep the arc at the palm.

## Scope

**Included:**

- **Summon any time.** Drop the `step.recording` gate on the VR and desktop
  summon paths in `ObjectInteraction.ts`. `CaptureObjects.startTake` stops
  removing summoned objects from the registry, but still resets the tray's
  `summonLog`.
- **What a take holds (export).** An event object that is placed when the take
  starts has samples from frame 0, and so it exports with no scale track.
  `buildObjectExports` writes `origin: 'prepared'` when the object's first
  presence starts at frame 0, and the object's own origin otherwise. The live
  `SceneObject.origin` is never rewritten: `registry.clearPrepared()` (the
  `?object=` picker) must not delete objects carried over from a take. So an
  object that was in the scene when the event began reads as prepared
  (principle 7; the schema's wording in `packages/objects/src/objects.ts`),
  and its rest pose follows: the first frame. An object summoned during the
  take keeps today's partial-presence path (`origin: 'summoned'`, scale 0
  before its summon frame). The extension's schema is unchanged. Only the
  rest pose reads `origin`. The viewer only validates it, USDZ hides objects
  by their scale track, and credits come from the node.
- **Search and load during a take.** Remove the take gates in
  `CaptureObjects.loadTray` (both checks), on the overlay's `TrayPicker` and
  `ObjectFinder`, and in `VrChrome` (`canFind`, the Find glyph hidden during a
  take, and the "a take closes Find" rule). The single prepared object
  (`ObjectPicker`, `?object=`) stays before the take only: it replaces the
  set's prop, it does not add to the tray.
- **Chrome while recording (styleguide 8.5 amended).** During a take the
  flat dock shows Stop, "Recording 0:12", the Halo, **Tray** and **Find**. The
  VR wrist shows Stop and **Find**, and the phone AR dock shows Stop and
  **Tray**. Find needs a place outside the Settings sheet, because the sheet
  closes during a take. On flat screens Find becomes its own dock action
  that opens the existing `ObjectFinder` in a small sheet above the dock.
  Opening it leaves pointer lock. It has no key: F is hold-to-point. Typing
  in the field never drives the avatar; `isTextEntry` already suppresses
  game keys. The rule's code is `SHOWN_WHILE_RECORDING` in
  `packages/xr-ui-core/src/recordingChrome.ts` and its test, and
  `chromeVisible('settings')` hides Find in `VrChrome`.
- **The tray UI**, one model on every device: five slots, each filled,
  loading or empty, and each filled slot carrying its device's summon
  signifier. Styleguide 1.2 puts the non-dominant hand's tools in the bottom
  dock on flat screens. So on desktop, touch and phone AR the tray is a **row
  of five slots above the dock**, and in a headset it is the existing arc of
  miniatures at the palm. A filled slot in the row shows a **thumbnail**,
  rendered once from the miniature when the item loads (a small offscreen
  render). On flat screens the 3D arc in front of the chest is not drawn,
  because the row replaces it (decision 5). A desktop summon
  still lands in the right-hand carry, as today.

  | Device | Open the tray | Signifier on each filled slot | Summon |
  | --- | --- | --- | --- |
  | Desktop | Hold T, or click the dock's Tray glyph | The key, 1–5, as a keycap on the thumbnail | T held + 1–5, or a click on the slot |
  | Touch phone | Tap the dock's Tray glyph (it stays open), or press and hold it and slide | The slot is a 44 apx tap target with a gold ring | Tap the slot, or lift on it |
  | VR, hands | Turn the left palm up | Gold ring at the slot. The item nearest the right palm and within reach brightens to cream and shows the **pinch** glyph | Right pinch |
  | VR, controllers | Hold Y | As hands, with the **squeeze** glyph | Right squeeze |
  | Phone AR (camera author) | Tap the AR dock's Tray glyph | The same row in UIKit, thumbnails as textures, 44 apx rings; a centre reticle shows where an item will land | Tap a slot |
  | Quest passthrough | Not shown; Find on the wrist fills the tray | — | — |

  - **Empty slot:** a muted dashed ring with nothing in it. On desktop it also
    carries its numeral in muted text, so the keys read as five places.
  - **Loading slot:** the next empty slot shows a muted ring that fills as
    the load progresses. Under reduced motion it holds still.
  - **Unavailable:** while the summoning hand is full or reaching, every
    signifier dims to 40%, which says why a key or tap does nothing.
  - **Open state:** the arc unfolds from the holder (240 ms in, 400 ms out,
    ease-out; a crossfade under reduced motion). On flat screens the dock's
    Tray glyph turns to the cream highlight while the tray is open. An empty
    tray shows five empty slots and the caption "Empty: search with Find"
    (flat screens; in a headset, the Find glyph only).
  - **Flat screens draw the row in the DOM** (`CaptureOverlay`). Each slot is a
    real button named "Summon <name>", so touch hit sizes and keyboard focus
    come from the platform. The row sits above the dock and clear of the
    walk stick's zone and the gesture edges. Press-hold-slide uses
    `elementFromPoint` on lift, because touch captures the pointer.
    **Headsets and phone AR draw in UIKit** (`@holoim/xr-ui-iwsdk`), at
    headset sizes in the headset, with glyphs only within arm's reach (7.3).
    The phone AR row is chrome, so `ScreenHolds`' `beganOnChrome` covers it.
  - **Touch letting go.** A summon grabs with `reached: false`, and `pick()`
    returns a held object only when it was reached
    (`ObjectInteraction.ts:253`, `:691`). A touch on the held summoned object
    must therefore pick it, so that lifting releases it. This is a small
    change in `ObjectInteraction.ts` and possibly `TouchInput.ts`.
  - **Feeding a summon from the DOM.** The flat row and the touch tray-open
    state go through `InputController`, beside `trayHeld` and
    `summonSlotQueued`: a held-open flag for touch, and a queued slot from a
    click or tap. `CaptureObjects`' tray gesture reads the held-open flag as
    well as T.
  - **New glyphs** (provisional until the styleguide table and `tokens.json`
    carry them, like Find): **Tray**, a shallow arc of three small rings over
    a base line; **Pinch**, a thumb and index tip meeting; **Squeeze**, a
    grip with its fingers closed. Their drawings are shown to the user before
    they land in the styleguide.
- **Phone AR placement (reverses `ar-recording.md`'s exclusion of summoning
  as a camera author).** `ObjectSystem` returns early for the AR spectator, so
  this is a new path, not a reuse. While the tray is open, a live ray from the
  screen centre is cast against the set's meshes, and against the set frame's
  y = 0 plane for the floor, throttled for the reticle. A tap on a slot calls
  `registry.summon` and sets `placed`, its base resting on the hit point and
  turned to the camera's yaw. This happens before `cameraRecorder.capture`
  in that step. With no hit, the reticle reads as dashed and a tap does
  nothing. `CameraRecorder` already null-pads through `ObjectSampleStore`.
  There is no physics in AR, so the object stands where it is put.
  **Presence filter for links:** `PointResolver.resolveCamera` builds its
  targets from every object at its rest pose. It must skip an object that is
  absent at a hold's time, so a hold made before a placement can't link to
  that object.
- **Mid-take load cost.** `crypto.subtle` and `createImageBitmap` already run
  off the main thread. The expected stalls are the GLTF parse, and texture
  upload and shader compile at the item's first draw, which is the thumbnail
  render here. After the parse, prewarm with `renderer.compileAsync` and
  `renderer.initTexture`, so the first tray open mid-take does not compile.
  The release collider is built at release, as today.
- **Help.** `captureHelp.ts` and `UIStateStore.publishMode` say, per device,
  that summoning works before and during a take, and how to open the tray and
  Find.

**Excluded:**

- Dismissing an object or removing a tray item. Decision 1 makes this more
  wanted: every retake adds more copies, and there is no dismiss. It goes to
  `TODOS.md` as a follow-up, raised with the user;
- reordering the tray, or a tray larger than five items or 16 MB;
- physics, grabbing or throwing in AR;
- summoning from Quest passthrough;
- muting the take's microphone during voice search (decision 4);
- neutralizing arm motion while the author uses Find mid-take in a headset.
  The ray and pinch on the panel stay in the body track, as any reach does.
  Recorded as a known limit.

## Acceptance criteria

- [x] **Desktop, before a take:** holding T shows the row of five slots, with
  a thumbnail and its key on each filled slot, and muted empty slots. T + 1
  summons into the right hand, and G places. Pressing record keeps the
  object, and the exported GLB has it as a `RecordedObject` with
  `origin: 'prepared'`, present from frame 0 (no scale track), at its
  pre-take pose within 1 cm (the harness's `EXPORT_POSITION_M`).
- [x] **Desktop, during a take:** the dock shows Tray and Find. Find
  (fixture search) adds an item to the tray mid-take, and T + its key summons
  it. The export validates (`gltf-validator`, no errors) and has the item as
  `origin: 'summoned'`, with presence from its summon frame (within one
  frame) and its credit.
- [x] **No hitch (real-time clock; enforced on a hardware GPU, see Hitch decision):** during a take, an 8 MB
  fixture GLB is loaded mid-take and the tray is then opened for the first
  time. A `PerformanceObserver('longtask')` records no task longer than
  100 ms. The report lists every long task and the step intervals, and the
  take's export still validates. Quest timing is a device check.
- [x] **Between takes:** a second take starts with the first take's objects
  where they were left, all present from frame 0 as `prepared`. A 60 s take
  carrying five or more objects converts to USDZ.
- [x] **Touch (phone size, touch emulation):** tapping the Tray glyph opens
  the tray with a ring of at least 44 apx on each filled slot. Tapping one
  summons it into the hand, and a touch on the held object releases it.
  Press-hold-slide-lift on the glyph also summons. Before a take and during
  one.
- [x] **VR (IWER, controllers and hands):** a squeeze or pinch on a
  miniature summons before a take, where today it does nothing. The
  reachable item's probe reads `reachable: true` with the right glyph, and
  the others read false. Find on the wrist stays during a take and adds to
  the tray.
- [x] **Phone AR (camera author, emulated):** the Tray glyph opens the row,
  the reticle sits on the set, and a tap places the item on the hit point.
  The camera take's export has it with presence from that frame. A screen
  hold made before the placement, aimed where the object later stands, does
  not link to it.
- [ ] **Quest passthrough:** no summon. Find fills the tray. Unverified:
  the spectator gate is unchanged code, but no check drives passthrough.
- [x] **Help** on each device says summoning works before and during a take,
  and how.
- [x] **No regression:** `test:xr:summon`, `test:xr:object`, `test:xr:ui`,
  the AR record check and `verify:pr` pass. Three assertions are changed by
  this brief and not regressions: `summon-take.mjs`'s tray-only take
  exporting `objects: []`, a squeeze before recording summoning nothing, and
  the origin expectations for carried objects.
- [x] **Design:** Codex reviews the screenshots of each device's open tray
  against the styleguide, and its findings are fixed before the user sees
  them. Codex hit its usage limit, so Muse reviewed instead; its one finding
  (the phone dock clipping the row) was fixed with the dock's `unfold`.

## Failure cases considered

| Failure case | Prevention or evidence |
| --- | --- |
| A pre-take summoned object is held in the hand when record is pressed | Held objects are `placed`; frame 0 samples it in the hand. The desktop check presses record while holding |
| Objects pile up across takes (no dismiss) | Accepted by decision 1; bytes stay bounded because clones share the tray item's geometry. Dismiss is a follow-up |
| A load that started before a take finishes during it, or the reverse | No take gate remains; `trayLoadSeq` still drops stale results. The check starts a load and presses record before it lands |
| Main-thread parse or hash hitches the take | Measured first (step-time and sample-gap report). If over budget, yield between fetch, check, parse and hash, and build the collider on the first physics step after a yield |
| A sixth item or over 16 MB mid-take | The same refusal notice, shown without stopping the take |
| The Find field takes keys that move the avatar or open the tray | Focus in the field suppresses game keys; the desktop check types "t", "g", "1" in the field mid-take and asserts no summon or move |
| Voice search and the take's recorder both open the microphone | Checked in `desktop-voice` mid-take. The take's audio track must keep running; the query is heard in the take (decision 4) |
| The row's thumbnails render when an item loads mid-take | One small offscreen render per item, at load, after the prewarm. It is inside the long-task measurement |
| A touch on the tray row also looks, walks or points | The row is DOM above the dock and outside `TouchInput`'s canvas handlers; the touch check asserts no look delta and no point mark |
| A carried object's full-length tracks grow the GLB and the USDZ work | The 60 s, five-object take converts within `glb_to_usdz.py`'s limits |
| `summonLog` keeps entries from an earlier take | Still reset at take start |
| The tray's chrome reaches the export | Tray items stay `authoring`; the DOM and UIKit signifiers are chrome. The export check lists node names |
| Phone AR centre ray hits the dock, the status line or the reticle | The ray is cast against the set and floor only |
| A pre-take summon in VR adds authoring spans | Spans are recorded only during the take; the check asserts none for pre-take summons |
| `origin: 'prepared'` for a cloned item confuses the viewer's credit or presence logic | The viewer reads presence from spans and credit from the node; the pipeline spec checks a pre-take summoned found object shows its credit |
| Parallel sessions (avatar-physics, object-resize) edit `ObjectInteraction.ts`, `InputController.ts`, `TouchInput.ts` | Edits there stay minimal (the gates). Rebase on `origin/main` before merging, then re-run `test:xr:summon` and `test:xr:object` |

## Ownership

| Role | Owner | Files or modules |
| --- | --- | --- |
| Lead | Claude Code (Opus) | Brief, integration, final handoff; the gates and touch release in `objects/ObjectInteraction.ts`, `objects/CaptureObjects.ts`, the held-open flag and queued slot in `input/InputController.ts`, `recording/objectExport.ts` (origin), `recording/PointResolver.ts` (presence filter), `packages/xr-ui-core/src/recordingChrome.ts` and its test |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only, before implementation |
| Implementer | Claude Code (Sonnet) subagents, one slice each | Slice A (flat tray UI and Find dock): `ui/CaptureOverlay.tsx`, new `ui/TraySignifiers.tsx`, `ui/capture.css`, `ui/UIStateStore.ts`, `ui/captureHelp.ts`, `types/contracts.ts`, `runtime/captureTextState.ts`. Slice B (headset and phone AR): `ui/VrChrome.ts`, `ui/PhoneArChrome.ts`, new `ui/XrTraySignifiers.ts`, new `objects/ArPlacement.ts`, `systems/ObjectSystem.ts` (the AR path), `packages/xr-ui-iwsdk/src/glyphs.ts`. Thumbnails and prewarm: new `objects/trayThumbnail.ts`, `objects/ObjectTray.ts`. Checks: `scripts/ci-summon-playwright.mjs`, `scripts/lib/*-take.mjs` |
| Independent verifier | Codex (`-p standard`) | Read-only verification against this brief, plus the screenshot design review |

## Design decision

Reviewed by the `design-reviewer` subagent (Opus) on 2026-10-28. Changes
adopted:

- Derive `prepared` at export from presence, rather than rewriting the live
  object's origin, which `clearPrepared` would then delete.
- On flat screens, a dock row with thumbnails, rather than signifiers pinned
  to projected miniatures. Styleguide 1.2 maps the non-dominant hand to the
  dock. In first person the arc is off screen, and in third person it is
  behind the body.
- Touch release, the DOM-fed summon, and the shared input files are listed
  explicitly.
- No F shortcut, because F is hold-to-point.
- Phone AR is a new path: a live ray cast and a presence filter in
  `PointResolver`. `CameraRecorder` is unchanged.
- The hitch is measured with long tasks on the real-time clock, with
  compile and texture prewarm. The manual clock hides hitches.
- The three changed assertions are named. A USDZ conversion criterion covers
  carried objects. The tolerance is 1 cm.
- The 8.5 rule's code (`xr-ui-core`) is owned by the lead.

Alternatives rejected: rewriting `origin` on the live object; UIKit on flat
screens (the DOM gives touch, focus and names for free); a worker parse
(measure first).

## Hitch decision (the user, through the lead)

"Enforce on real GPU". `tray-hitch` loads the 8 MB fixture mid-take and
opens the tray, with a `PerformanceObserver('longtask')` and `tray:*` User
Timing marks. On a hardware GPU (WebGL renderer string, or
`SUMMON_HITCH_GPU=1`) any task over 100 ms fails; on Metal there were 0 long
tasks. On SwiftShader the GPU process's work runs on the CPU and blocks the
page, so the stalls are recorded, not failed, and the export must still
validate: about 164–200 ms at the first draw after the texture upload, about
136 ms around the read-back, and about 111–121 ms at the summon. The fixture
and threshold are unchanged. The work that got there: compile with the
thumbnail target bound, compile a visible proxy for the live scene, one
texture upload per task, an async read-back, and a hull scan in 16,384-point
chunks.

## Glyphs (the user, 2026-10-28)

Tray (a shelf of shapes), Squeeze (a closed fist, after Lucide hand-fist),
Pinch (a real pinch, after Iconoven hand-pinch), and the slot fallbacks for
a model (a globe) and an image (a frame with a sun over a peak) are in
`tokens.json` and the styleguide's glyph table. Find stays provisional.
Styleguide 8.5 now keeps Tray and Find on the dock during a take.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
| --- | --- | --- |
| Desktop pre-take and mid-take, between takes | `desktop`, `desktop-anytime` phases of `test:xr:summon` | pass; `apps/capture/output/ci-summon/report.json`, `desktop-anytime-*.png` |
| Hitch | `tray-hitch` phase (`SUMMON_HITCH_GPU=1` for Metal) | pass; 0 long tasks on Metal, SwiftShader stalls recorded above |
| 60 s, five carried objects, USDZ | `long-carry` phase, then `summon.pipeline.spec.ts` | pass; five `prepared` objects present 0–59.98 s, each within 0.1 mm of its start; USDZ converts |
| Touch | `touch-tray` phase | pass; 44 apx slots, tap and slide summon, dock clearance in the report |
| VR controllers and hands | `controllers`, `hands` phases | pass; pre-take squeeze and pinch summon |
| Find mid-take (flat, headset, voice) | `find`, `headset-find`, `desktop-voice` phases | pass |
| Phone AR placement | AR record check, `phone-tray` phase | pass; `phone-tray.glb` has the `RecordedObject` from its placement |
| No regression | `test:xr:object`, `test:xr:ui`, `verify:pr` after rebase on main | pass |
| Proof | Real-time recording of desktop, touch and IWER VR (`SUMMON_VIDEO_DIR`) | `output/tray-everywhere-proof/`, not committed |

Verifier: Codex was out of usage, so Muse verified against this brief. Its
sandbox blocks sockets, so it judged recorded artifacts and the code; it
found no correctness defects. Its notes: the `seq` guard in `loadTrayNow` is
now dead code (left), and the AR reticle is faint (a device check).

## Physical-device limits

IWER and touch emulation prove the logic and layout, not feel. Still to do on
devices: Quest 3 hands and controllers (whether the reachable highlight reads
at arm's length, and pinch comfort), an Android phone (touch tray and AR
placement), and an iPhone (touch tray, portal-only).

Unverified at close: all of the above, plus mid-take load timing on Quest
and the AR reticle's contrast on a phone camera feed.
