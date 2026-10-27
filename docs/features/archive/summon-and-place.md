# Feature brief: Summon and place while speaking

**Lead:** Claude Code (Opus)  
**Status:** Complete (merged 2026-10-24 with PRD-043; scope and gestures approved by the user 2026-10-24)
**Layer:** Event (see `docs/product/concepts/what-a-hologram-is.md`)  
**PRD:** [PRD-045](../../product/prds/PRD-045-authoring-while-speaking.md) (IDEA-062)  
**Builds on:** [Explain with an object](explain-with-an-object.md) (PRD-043): the object
registry, grab, the per-object sample store and the `HOLOIM_objects` export.
Both landed on `main` together on 2026-10-24.

## User outcome

Before a take, the author prepares a tray of up to five objects or images.
Mid-explanation, without stopping talking, they hold a gesture with the
non-dominant (left) hand, and the tray opens at that hand. They reach in with
the right hand, take an item, and place it in the scene. The recording keeps
flowing. The recipient, in the feed, the portal or Quick Look, never sees a
tray or a menu. They see the object appear in the author's hand at that
moment, and it stays where it was put.

## Scope

**Included:**

- **Prepare the tray.** Before recording, up to five items, each a GLB (the
  PRD-043 rules: no Draco, meshopt, KTX2 or skins; at most 8 MB) or an image
  (PNG or JPEG, at most 8 MB and 4096 px on a side). Sources: repeated
  `?tray=<url>` query parameters, or a multi-file "Tray" picker on the overlay's
  existing shortcut row (it adds no height: the `recording` check runs at
  320×180). An image becomes a thin double-sided card, 0.3 m on its longer
  side, with its own aspect ratio. A sixth item, a tray over 16 MB in total
  (so a take stays under the 25 MB upload), or any item during a take, is
  refused with a notice. The PRD-043 prepared object (`?object=`) still works
  alongside the tray.
- **Open the tray: a held gesture (proposed; the user decides, see "Gesture
  decision").** The tray is open only while the gesture is held; letting go
  closes it (design language: "modes are held, never toggled").
  - Controllers: hold the left controller's **Y** button.
  - Tracked hands: turn the left palm **up** and keep it there for 0.25 s.
  - Desktop: hold **T**.
  The tray does not open while the left hand holds an object, and grabbing
  with the left hand closes it.
- **Tray at the hand.** Items show as miniatures, each fitted to an 8 cm cube,
  in a shallow arc 12 cm above the left palm (controller: above the left
  controller), facing the author's head. On desktop the arc floats in front of
  the avatar's chest, numbered 1–5. Tray items are `authoring` objects:
  `SceneObjectRegistry` holds them, `ObjectSystem` positions them, and they are
  never sampled, exported or under `worldModel`.
- **Summon: pick from the tray.** In XR, the right hand's squeeze or pinch
  (PRD-043's grab input and hysteresis) within reach of a miniature summons
  it. On desktop, pressing **1–5** while **T** is held summons that item. A
  summon calls `registry.summon(trayItem, timeSec)`: a **new** `event` object
  with a new id, a clone of the full-size model and `origin: 'summoned'`,
  created at the miniature's position and already held in the right hand. The
  tray item stays, so an item can be summoned again. The clone shares the
  item's geometry, materials and textures, so the exporter writes them once.
  Summoning works only while recording. Summoned objects from a take are
  cleared when the next take starts. When the tray is open, a miniature
  within reach wins over an event object, and the miniature nearest the palm
  is chosen. On desktop the summoned object appears at the in-hand pose and
  follows the hand while the carry pose raises the arm. It does not glide in
  from the chest.
- **Place.** The summoned object is a normal PRD-043 object: releasing the
  squeeze or pinch (desktop: `G`) leaves it where it is, and it can be picked
  up again. A summon made while the right hand already holds something does
  nothing.
- **Interface exclusion (chrome).**
  - The tray never enters the recording: it is `authoring`, so the sample
    store and the exporter skip it.
  - **Hands-in-menu motion is neutralized in the body track.** The arm's
    **authoring spans** are worked out after the take from a per-frame
    record: tray open, each hand empty, the right palm within 25 cm of the
    tray, a summon, and whether each hand's pose was tracked. The left arm is
    in the menu while the tray is open. The right arm is in it from the frame
    its palm enters the tray zone until a summon or the tray closing. A right
    run that ends because the hand left the zone, or because it grabbed an
    event object, stays live: it was content. At export,
    the arm chain bones (shoulder, upper arm, forearm, hand and fingers) are
    replaced inside each span by an eased interpolation of their local
    rotations, from the last frame before the span to the first frame after
    it. The recipient sees the arm move smoothly from where it was to where it
    ends up. For the right arm that is the summon moment, with the object
    appearing in its hand. The relation of a summoned object to the hand stays
    exact, because the object only exists from the span's end frame. The arm
    chain is an explicit bone list (`Shoulder`, `Arm`, `ForeArm`, `Hand` and
    the `HandThumb`/`Index`/`Middle`/`Ring`/`Pinky` 1–4 bones per side), rotations only, using shortest-path
    slerp. Left and right spans may overlap, because their bones are
    disjoint. Each boundary frame is the nearest one, within 0.5 s, whose
    hand pose was tracked, so a lost hand's rest pose is never blended in. A
    span that touches the take's start or end holds its one boundary pose. A
    span covering the whole take is left as recorded. The rewrite is applied
    once, to a copy of the frames, and both the export worker and
    `PointResolver` read that copy, so body-anchored marks match the exported
    arm.
    On desktop the tray needs no arm motion, so desktop takes have no
    authoring spans in the body track.
  - Hand point samples inside an arm's authoring span are dropped, so a reach
    into the tray never becomes a pointing mark.
- **Export.** Each summoned object uses PRD-043's partial-presence path: a
  `RecordedObject` node with a STEP scale track that is 0 before the summon,
  `origin: 'summoned'` and presence spans in `HOLOIM_objects`. Version 0 of
  the extension gains one optional root field, `authoring: [{ hand, start,
  end }]`, recording the neutralized spans. v0 has not shipped yet: PRD-043
  and PRD-045 reach `main` together. The extension is written when there are
  objects or authoring spans, so `objects` may be empty when only the tray was
  opened.
- **Viewer.** The feed and portal already play scale tracks through the
  mixer, so a summoned object appears at its summon time. The work is to check
  that bounds, framing and clipping ignore a zero-scale object, and that the
  probes read the presence spans. Older GLBs and PRD-043 GLBs render
  unchanged.
- **Quick Look / USDZ.** `glb_to_usdz.py` maps the wrapper's zero-scale spans
  to `visibility` time samples (`invisible` / `inherited`), and writes a
  near-zero scale (1e-4) there instead of 0. This avoids a singular
  transform, and RealityKit is not known to honour animated visibility, so
  the scale hides the object even if visibility is ignored. Extents are read
  per frame. A summoned object's rest pose, the USD default and what a still
  shows, is its **last** present pose: where it was placed. After placement
  the object holds that pose. When the card loops, the object disappears
  again at the start, as expected.

**Excluded (PRD Out of Scope, plus):**

- voice commands, transforming or animating summoned objects, and spatial
  primitives (simple shapes);
- dismissing a summoned object mid-take (presence spans support it, but there
  is no gesture for it yet);
- a dominant-hand (handedness) setting: the left hand always holds the tray;
- the Halo radial menu (IDEA-031): the tray is the only held mode here;
- reordering or editing the tray during a take;
- the PRD's comparison study (tray against menus).

## Acceptance criteria

- [ ] `?tray=` and the overlay picker load up to five GLBs or images before
  recording. A sixth item, a refused file or an attempt during a take shows a
  notice, and capture keeps working.
- [ ] In IWER with controllers: holding left Y opens the tray at the left
  hand and releasing closes it. A right squeeze on a miniature creates a new
  summoned object in the right hand, and a release places it. Squeezing away
  from the tray, or with the tray closed, summons nothing. Summoning the same
  item twice gives two objects.
- [ ] With IWER tracked hands: palm-up opens the tray after 0.25 s, palm-down
  closes it, and a right pinch on a miniature summons.
- [ ] On desktop: holding T shows the tray, and 1–5 summon into the right-hand
  carry. `G` places, and keys pressed without T do nothing.
- [ ] The exported GLB from a scripted take that summons and places two
  objects has two `RecordedObject` nodes with `origin: 'summoned'`. Their
  presence starts at the summon frames (within one frame), their scale is 0
  before that and 1 after, and their placed poses match capture (≤ 1 cm,
  ≤ 1°). No tray geometry is in the GLB: no tray node names, and the mesh and
  primitive count equals the take's event content.
- [ ] In the same GLB, the authoring spans are listed in `HOLOIM_objects`.
  Inside them, the arm chain's rotations equal the eased interpolation of the
  boundary frames (≤ 0.5°), and outside them they equal the captured frames.
- [ ] Uploaded through the real API: in the feed or portal card, each summoned
  object is invisible before its summon time, visible in the avatar's right
  hand at it, and at its placed pose afterwards (≤ 1 cm, ≤ 1° against the
  GLB). A report JSON and screenshots are written.
- [ ] The converted USDZ has `visibility` time samples on each summoned prim
  (invisible before the summon, inherited after) and no zero scale.
- [ ] PRD-043 takes (a prepared object for the whole take) and GLBs without
  the extension export and render exactly as before. A take where the tray
  was opened but nothing was summoned exports `objects: []` with its
  authoring spans, and renders.
- [ ] Grabbing a placed object while the tray is open keeps the right arm's
  reach live (no right span), and summoned objects are gone when the next
  take starts.
- [ ] A tray over 16 MB in total is refused at load.
- [ ] `pnpm run verify:pr` passes locally.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Tray geometry exported or sampled into the bubble | Tray items are `authoring` objects under `worldGroup`; the check counts nodes, meshes and names in the GLB |
| Accidental summon while gesturing (PRD risk) | The tray must be held open; a summon needs a press starting within reach of a miniature (PRD-043's rising-edge rule); palm-up needs 0.25 s |
| Accidental tray open from a palm turned up while explaining | 0.25 s dwell, and hysteresis on the palm-up angle (open above 0.7 dot, close below 0.4) |
| Arm snaps at a span boundary | Eased interpolation between boundary frames, never a held pose followed by a jump |
| Summoned object detached from the neutralized hand | The right span ends on the summon frame; the object's presence starts on that frame; the check composes the object against `RightHand` |
| Left hand holds content while the tray is open | The tray will not open while the left hand holds an object, and grabbing with the left closes it, so the left span is never over held content |
| Long tray-open spans make the arm drift slowly | Accepted and noted; the author normally closes the tray within a second or two |
| The tray reach recorded as pointing | Point samples inside right-arm spans are dropped |
| Zero scale gives a singular USD transform | Converter maps zero-scale spans to `visibility` |
| Zero-scale object counted in AR bounds, framing or clipping | The viewer already excludes object nodes (PRD-043); the spec checks a summoned object does not change card framing |
| Interpolation leaks into the rest pose or the bind pose | Only `RecordingFrame` bone rotations inside spans are rewritten; the composer still uses the first frame as rest |
| A sixth tray item, or tray loading during a take | Refused with a notice |
| An image too large for the 25 MB upload | 8 MB / 4096 px limit; PNG re-encoding noted |
| Grab input conflict: the tray Y button and the trigger record toggle | Y and X are unused today; the trigger stays the record toggle; grab stays squeeze or pinch |
| The PRD-043 extension validator rejects the new field | Optional `authoring` added to the v0 schema in `packages/objects`; the viewer ignores it |
| A shared port or harness collision with other sessions | One XR harness at a time; ports via `CAPTURE_RUNTIME_PORT` / `E2E_API_PORT` |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, PRD-045 status, integration, handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review of this brief |
| Contract | Lead | `packages/objects` (optional `authoring` spans, empty `objects`) |
| Capture | Lead | New `apps/capture/src/objects/` tray modules (tray store and loader, image card, tray gesture input, tray presenter), `SceneObjectRegistry.summon`, `ObjectInteraction` (summon-into-hand), `ObjectSystem`, new `recording/authoringSpans.ts` (span tracking and body-track interpolation), the composer and objects plugin hooks, `InputController` (T, 1–5), `PointSampleStore` (drop in spans), overlay tray picker, automation hooks |
| Capture check | Lead | `scripts/ci-object-playwright.mjs` or a sibling `ci-summon` check, tray fixtures, the `run-xr-checks.mjs` entry |
| Converter | Lead | `apps/viewer-api/tools/glb_to_usdz.py` (zero scale → visibility) |
| Viewer | Lead | `apps/viewer-web/src/features/objects/recordedObjects.ts` (presence), a new `e2e/summon.pipeline.spec.ts` beside `object.pipeline.spec.ts` |
| Check runs | `check-runner` subagent | Runs and summarizes checks |
| Independent verifier | Codex (`codex exec -s read-only`), or a fresh read-only reviewer if Codex is unavailable | Read-only verification against this brief |

## Design decision

### Gesture decision (for the user)

IDEA-031's grammar is a draft. Its Summon row is a Halo radial menu (controllers:
"hold non-dominant menu button, flick stick"; hands: "turn non-dominant palm up,
pinch-drag"; mouse: right-button hold). The proposal keeps its principles,
non-dominant hand frames, dominant hand acts, and modes held, never toggled, and
adapts the bindings:

| Device | Proposed hold | Why not the grammar's binding |
|---|---|---|
| Controllers | Left **Y** | The left menu button is reserved by the Quest system and never reaches WebXR. X is the grammar's "Speak" hold, which an author may use at the same time, so Y is the free button |
| Hands | Left **palm up**, 0.25 s dwell | Same as the grammar |
| Desktop | Hold **T**, then **1–5** | The right button is already the desktop point action |

Picking is a grab from the tray rather than a flick direction: it reuses
PRD-043's grab, so the summoned object is already in the hand that places it.

### Chrome handling: interpolate, don't freeze or cut

- Cutting the span out of the take would cut the audio and shorten the
  explanation. Rejected.
- Holding the arm's last pre-span pose, then jumping to the live pose at
  the span end, gives a visible snap exactly at the summon. Rejected.
- **Chosen: an eased (smoothstep) slerp of the arm chain's local rotations
  between the boundary frames.** It is local to the exporter, it reads as a
  natural reach, and it keeps the summoned object exact in the hand at the
  summon frame.

### Review changes (design review, 2026-10-24)

The `design-reviewer` pass led to these changes, folded in above:

- right-arm spans scoped to the palm being in the tray zone, worked out after
  the take;
- tracked boundary frames, an explicit bone list, rotations only, and the
  whole-take case;
- one rewritten copy of the frames shared by the worker and the point
  resolver;
- a near-zero scale alongside `visibility` in USDZ, the last present pose as
  the rest pose, and extents read per frame;
- a 16 MB tray budget and shared geometry in clones;
- summoning only while recording, clearing summoned objects at the next
  take, the nearest miniature winning over event objects, and an in-hand
  desktop spawn;
- palm-up measured against world +Y, and the tray kept open through up to
  0.5 s of left-hand tracking loss;
- the tray-only GLB, with `objects: []`, added to the checks.

Quick Look playback of the visibility and scale path on a real iPhone is a
device check this branch cannot run (see Physical-device limits).

### Data

- `SceneObjectRegistry.summon(item)` creates the event object. Presence comes
  from the sample store's first sample, so the registry needs no time.
  `ObjectSampleStore` already pads `null` before the first sample, and
  `objectExport` already writes the STEP scale and presence spans.
- An `AuthoringSampleStore` in `src/recording/` keeps the per-frame record
  inside `AvatarRecorder.capture`. At export, `authoringSpans.ts` works out the
  spans and rewrites a copy of the frames.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result (2026-10-24) |
|---|---|---|
| Tray loading and refusals | `pnpm --filter @holoim/capture run test:xr:summon`: `?tray=` with the bracket and `diagram.png` (IWER phases); the overlay picker on desktop | Pass. `apps/capture/output/ci-summon/report.json`: `?tray=` loads `1:bracket.glb:model`, `2:diagram.png:image`; a picker pick that would make six items is refused with "The tray holds at most 5 items." and the tray keeps its two |
| XR controller summon and place, negatives | Same check (`iwer-summon`): IWER controllers in programmatic mode; Y hold, right squeeze on each miniature, carry, release | Pass. Y opens the tray (`source: button`), miniatures 15 cm above the left palm; releasing Y closes it. A squeeze on a miniature before recording, and a squeeze away from the tray, summon nothing. Two summons, each into the right hand, each placed (0 m drift in capture). Grabbing the placed image again beside the open tray (palm 22 cm from a miniature, in the zone) grabs it, summons nothing, and adds no authoring span. Screenshots `iwer-summon-{1-tray-open,2-summoned,3-placed}.png` |
| Hands palm-up and pinch | Same check (`iwer-hands-summon`) | Pass. Palm dot with world up −0.96 at rest, 0.96 turned up; closed after 0.1 s (inside the dwell), open after it (`source: palm`); a right pinch (2 mm thumb–index) on a miniature summons into the right hand; release places; palm down closes the tray |
| Desktop T + 1–5 | Same check (`desktop-summon`), real keys | Pass. `1` without T summons nothing; holding T shows the tray (`source: key`); T + 2 summons `diagram.png` into the right hand (0.13 m from the hand bone on its first step and after the carry pose blends in); `G` places it; the export has one summoned object and no authoring spans |
| GLB: presence, scale, placed poses, no tray geometry, authoring spans and interpolation | Same check parses each GLB without a renderer | Pass. Two `RecordedObject` nodes, `origin: summoned`, with STEP scale 0 before the summon key and 1 from it; each in the right hand at its summon key exactly as in capture (0 m / 0° at the report's precision); still where placed until the end (≤ 1.4 mm); rest pose at the placed pose; the two placed objects relative to each other match capture; summon gap 1.356 s in both. Scene roots are only the avatar, bubble, scene bubble, the two objects and lights; each object node has its item's mesh count (3, 1); no `SceneObject_` wrapper. Spans: left 0.51–3.90 s, right 0.69–1.09 s and 2.05–2.43 s, each right span ending on the key before its summon; inside them the arm chain matches the eased slerp of the boundary keys within 0.034° (boundary swings 118° and 70°, so the reach really is replaced) |
| Tray-only take and retake clearing | Same check, a second take: open, reach in, close | Pass. Summoned objects from the first take are gone at the start; the GLB has `objects: []` with a left and a right authoring span, and validates |
| Viewer at summon times | `apps/viewer-web/e2e/summon.pipeline.spec.ts` (in `test:e2e:pipeline`): records the controller take in `beforeAll`, uploads it through the API, pauses the card and seeks before, at and after each summon | Pass. `output/summon-viewer/report.json`: before its summon each object has zero world scale; at and after it, its pose relative to the recording root matches the GLB (0 m / 0°). Screenshots `output/summon-viewer/{0..3}-*.png` |
| USDZ visibility | Same spec reads the converted USDZ with `pxr` | Pass. Each summoned prim has 660 visibility samples, default `inherited`; `invisible` with a 1e-4 world scale before its summon and `inherited` at scale 1 after; minimum authored scale 1e-4, never 0 |
| PRD-043 and old GLBs unchanged | `test:xr:object`; `object.pipeline.spec.ts` | Pass (both re-run on this branch) |
| Repo gate | `pnpm run verify:pr` | Pass. Doctor, `check:all`, unit (capture 19, viewer-web 35, viewer-api 24, packages), `build:all`, pipeline 8/8, portal 6/6 and `test:xr:smoke`. The knowledge atlas suite ran on an isolated port (7/7): its config reuses any server on 4176, and another checkout's was running there |
| Independent verification | Fresh read-only reviewer (Codex was at its usage limit) | Fixed: authoring frames could fall out of step with recorded frames when the object step skipped a frame (before the spawn resolves, AR spectator) or a frame was left over from the last take. Masking then silently turned off. The recorder now records an idle frame for each skipped step, the frame is consumed each step, and a take start clears it; `test:xr:summon`, `test:xr:object` and the capture unit tests re-run green. Accepted: interpolation by frame index, not time (within the 0.5° check); the strict v0 schema rejects `authoring` in older validators (v0 has not shipped) |

## Physical-device limits

IWER proves the deterministic tray, summon, export and render path. It does
not prove that holding Y or turning a palm up while explaining feels natural
(the PRD's open question), palm-up detection with real hand tracking, reach
comfort, or tray legibility. These need a Quest take, and Quick Look on a real
iPhone is unverified. Both are recorded here once run.

With tracked hands, the left span starts once the palm-up dwell opens the
tray, so the arm's turn up before it and lowering after it stay in the take.
Whether that reads as a gesture or as menu handling needs the Quest take;
starting the span at the turn's onset is the follow-up if it reads as noise.
