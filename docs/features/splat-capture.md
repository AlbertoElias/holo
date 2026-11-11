# Feature brief: Record a take inside a scanned place (split capture, slice 2)

**Lead:** Claude (Opus)  
**Status:** Approved (the user, 2026-11-10, the recommended answer A to Q1 to Q7); slice 2a implemented and verified on `feature/splat-capture-desktop` (2026-11-11), to merge with slice 1; 2b and 2c not started
**Layer:** event: a scanned place used as the take's set. The take happened
in the scanned place itself only when the scan is lined up with the real
room (*here*, Q2). See `docs/product/concepts/what-a-hologram-is.md`.

Source idea: IDEA-077, [phone reality capture](../product/concepts/phone-reality-capture.md).
Slice 1, [`splat-place.md`](splat-place.md), is the render end: a dev-only
`?place=<url>` shows a splat around an existing take in the feed card. The
user's direction on 2026-11-10: the place belongs to capture, because a
hologram is a recorded event, and it must work on every capture device.

## User outcome

An author scans a real room with Scaniverse (or any SPZ or PLY splat), opens
capture, brings the scan in, and records a take inside it. The person stands
on the scan's floor at true scale; the scan replaces capture's set. The take
uploads with the place inside it and plays in the feed card, the portal and
the AR and VR viewers with the scan around it, cut by the cloche. Older
viewers and Quick Look still play the take, standing on a plain floor. This
works on each capture device: the desktop page (keyboard and mouse, and
touch on an iPhone), Quest VR, Quest passthrough AR and phone AR.

## Background: what capture does today (checked at `e0b0636`)

- **One World, three modes.** `runtime/captureStage.ts:30` creates the IWSDK
  World; `runtime/xrEntry.ts:62-72` sets `sessionMode` to `vr` (opaque),
  `ar` (any passthrough blend) or `none` (the desktop page, and the iPhone's
  flat page). The set is `avatarRig.worldModel` from `?scene=`
  (`runtimeConfig.ts:32`, fitted in `avatar/AvatarRig.ts:266`), with a 20 m
  ground disc (`captureStage.ts:66`). There is no set picker, and no way to
  swap the set at runtime: `CharacterMotor.init` builds its Rapier trimesh
  once (`physics/CharacterMotor.ts:73-78`).
- **Phone AR is a camera author** ([AR recording](archive/ar-recording.md)):
  a handheld session (`isHandheldSession`, strict) hides the performer and
  records the phone's camera path, voice and held marks, in the set's frame.
  Android Chrome only; Safari has no WebXR AR, so an iPhone records on the
  flat page.
- **Quest passthrough AR does not record.** Any non-handheld AR session is a
  spectator (`frame.arSpectator`): `ArSpectator` stands the set 2.2 m ahead
  on the floor and recording returns early. Recording a performer in
  passthrough is a feature that does not exist yet (Q1).
- **Much of capture leans on the set being meshes**, through
  `avatarRig.worldModel`, and three's `Raycaster` ignores `visible`, so a
  hidden set still answers casts: the desktop floor collider; foot IK
  (`TerrainLegSolver`) and the VR ground sampler (`sampleTerrainYAt`); camera
  collision (`CameraController`); desktop and headset pointing
  (`DesktopPointAction`, the point resolver); object resting
  (`ObjectInteraction`) and set targets; the camera take's Record gate
  (`CameraRecorder.hasSetInReach`) and its export, which throws "Nothing in
  the set to export"; the export's clip to the bubble as
  `RecordedSceneBubble` (`recording/SceneBubbleSampler.ts:113`) and its
  occlusion test, which raycasts up from each set triangle. A splat has no
  mesh, so each of these needs a defined source.
- **Export → upload.** `recording/GltfExportComposer.ts` writes the GLB
  (`HOLOIM_meaning`, `HOLOIM_objects`, `HOLOIM_humanoid`, `KHR_audio`);
  `exportWorker.ts` only flattens keyframes. Capture downloads the GLB
  (`RecordingSession.ts:247`); the author uploads it in the viewer. The API
  checks the `glTF` magic and a 25 MB cap (`viewer-api/src/lib/constants.ts:1`)
  and converts to USDZ for Quick Look. One file per hologram. Precedent:
  `GLTFAudioPlugin` already writes a buffer view no mesh references, under an
  optional extension, and every reader takes it (GLTFLoader warns only about
  unknown *required* extensions; `glb_to_usdz.py` notes optional ones).
- **The viewer's cloche fits every drawn point** in the 6 m bubble
  (`packages/xr-ui-core/src/cloche.ts`, at least 0.4 of its width tall).
  Slice 1's set take had a dome about 5.9 × 6.2 × 5.5 m.
- **Slice 1's place code** (`apps/viewer-web/src/features/place/`):
  `loadPlace`, `readFloor`, `readUpright`, `placeOnFloor`, `cropToSweep` and
  the dome clip (`placeClip.ts`, GLSL plus its TS twin) are plain TS or plain
  three; `PlaceLayer`/`PlaceMount` are R3F; `takeFloor.ts` reads a recorded
  take and is viewer-only. Spark (`@sparkjsdev/spark@2.3.1`) is in
  `viewer-web` only, kept out of production. Both apps use the catalog's
  `super-three@0.181.0`. Spark 2.3.1 also has `writeSpz`, LoD trees (default
  budgets: Quest 500 k, Vision Pro 750 k, Android 1 M, iOS 1.5 M, else
  2.5 M), `raycastable` splat meshes and `SparkXr`.

## Questions for the user (decided 2026-11-10)

The user chose the recommended option, A, for every question. The other
options are kept for the record.

### Q1. Quest passthrough AR does not record today. How does this brief cover it?

- **(A, recommended) Sequence it.** Slices 2a to 2c cover the desktop page,
  Quest VR and phone AR. Quest passthrough shows the place as a spectator in
  2b, and records in it once "a performer in passthrough" is built, its own
  feature with its own brief (the body, the floor and the microphone in
  passthrough). Slice 2d then adds the place to it.
- (B) Fold performer recording in passthrough into this brief, as slice 2d.
  One brief owns all four devices, but it doubles the brief and mixes a
  recording change with a contract change.
- (C) Quest passthrough shows the place but never records in it; a headset
  author switches to VR to record. Simplest, but not the user's requirement.

### Q2. In AR, is the scan lined up with the real room, or does it replace the passthrough?

- **(A, recommended) Both, chosen by where the author is, with "elsewhere"
  first.** *Elsewhere* (not in the scanned room): the scan stands in the room
  at true scale, cut by the same dome the viewer uses: a diorama the phone
  walks around, with passthrough outside it (an uncut room scan would
  surround the author, which is VR in practice). *Here* (in the scanned
  room): the author lines the scan up with the room once (the floor is
  matched from `local-floor` against the scan's floor, so only a slide and a
  turn are left, done by dragging the ghosted scan); the scan is then faint
  or hidden while recording, the author acts in the real room, and the take
  stores where they were in its scan. *Here* is the truest event (the place
  becomes the take's site, not its set), but its alignment is hard to judge;
  it is its own slice once *elsewhere* works.
- (B) Always replace the passthrough with the whole scan. Splats have gaps
  and soft edges, so the real room bleeds through; the camera feed is wasted.
- (C) Always line up with the real room. Truest, but an author can only
  record in the room they scanned, and a wrong alignment puts the take in
  the wrong place with nothing to show it.

### Q3. How does the author bring a scan into capture?

- **(A, recommended) A file picker now, "My places" later.** The capture
  page's existing file input (`ui/CaptureOverlay.tsx:411`, the `FilePickerWord`
  used for objects) also takes `.spz` and `.ply`, plus `?place=<url>` for
  tests and links. Works on the desktop page and Android; a Quest picks the
  scan from its Downloads on the page *before* entering VR (there is no DOM
  in the session). A later slice adds "My places" to creator accounts:
  upload a scan once (from the iPhone that made it) and pick it in capture's
  tray on any device, in the session.
- (B) "My places" first: an API resource, storage and a picker before any
  take exists. The right end state for a Quest, but a second contract change
  before the first is proven.
- (C) URL only (slice 1's `?place=`). No product path; authors cannot use it.

### Q4. How is the place stored with the hologram?

- **(A, recommended) One GLB; a `RecordedPlace` node with a `HOLOIM_place`
  extension holding SPZ bytes.** At export the scan is cropped to the take's
  reach (Q7) and written with Spark's `writeSpz` into a buffer view of the
  same GLB. The node carries `extensions.HOLOIM_place` `{ version: 1,
  bufferView, splatCount, maxSh, provenance: { kind: "reconstruction",
  relation: "set" | "site", app?, scannedAt? } }`, and its TRS is the
  scan-to-set transform: the viewer applies it as is and never reads the
  floor or the way up again (a cropped patch can read differently from the
  whole scan). A node gives a mark on the scan a `to.node`. The extension is
  in `extensionsUsed`, never `extensionsRequired`. The set becomes a plain
  floor disc in `RecordedSceneBubble`, so older viewers, Quick Look and the
  USDZ converter show the take standing on a floor; a viewer that reads the
  place hides the disc. No DTO or storage change: one file, the same 25 MB
  cap; the API adds a check of the SPZ header (validation only).
  `KHR_gaussian_splatting` replaces it later as a version bump, once it is
  ratified with SPZ compression and three or Spark read it.
- (B) `KHR_gaussian_splatting` now. Standard, but its SPZ compression is
  still a draft, neither three nor Spark loads it from a GLB, and its
  fallback is a points primitive: today's viewers and the converter would
  draw tens of thousands of 1 px points and fit the cloche to them.
- (C) A sidecar `.spz` beside the GLB, which points to it by URI. Keeps the
  GLB small and the scan reusable, but needs multi-file upload, storage keys,
  delete, the DTO and the converter to know about it, and a GLB that is no
  longer self-contained.

### Q5. What scan size and frame rate are acceptable?

- **(A, recommended)** Input: up to 3 M splats decoded, refused above with a
  message. Live: Spark's LoD caps drawn splats at its own budgets (Quest
  500 k, Android 1 M, iPhone flat page 1.5 M, desktop 2.5 M), tuned on the
  devices. Frame rate while recording: Quest p95 frame time at most 13.9 ms
  (72 fps), phone AR 30 fps (the camera's rate), desktop 60 fps. Stored: SH
  degree 0 or 1, at most 200 k splats, sized at Stop to what 25 MB leaves
  after the rest of the take; a larger crop is thinned by distance from the
  take's path, from the original splats (not the LoD tree), never refused at
  Stop. Cost: every feed card downloads the place bytes (up to a few MB)
  before its first paint, older viewers included.
- (B) No live cap, only the input cap: simplest, but a dense room scan has
  been reported at around 14 fps on a Quest 3.
- (C) Crop the scan to a recording area chosen before Record, so the live
  scan is small too. Cheaper everywhere, but adds a step and limits where a
  VR author can walk.

### Q6. Which device does the first slice prove, and which come after?

- **(A, recommended)**
  - **2a, the desktop page:** bring in a scan, record a performer take on its
    floor, point at things in it (splat raycast), export `HOLOIM_place`,
    upload, and play it in the feed card and portal. The whole contract, on
    the device with the strongest e2e harness.
  - **2b, Quest VR:** the same take in a headset, IWER then the Quest, where
    Spark in a WebXR session (and its reported hang) is first proven; Quest
    passthrough shows the place as a spectator; the IWSDK AR and VR viewers
    and the R3F `ARView` render the stored place (the floor disc until then).
  - **2c, phone AR (Android):** a camera take in the scan, held marks on it.
  - **2d, Quest passthrough:** after the passthrough performer feature (Q1).
  - **2e:** *here* alignment (Q2), and "My places" (Q3).
- (B) Quest VR first: the most immersive, but every check needs IWER or the
  headset, and the contract would be proven where it is hardest to inspect.
- (C) Phone AR first: closest to IDEA-077's phone story, but a camera take
  has no performer to stand on the floor, which is what this slice fixes.

### Q7. How much of a room does the cloche show? (added by the design review)

The cloche fits whatever is drawn. A 6 m floor disc in place of today's
hilly set gives a dome about 6.3 m wide and 2.5 m tall, so a room's walls
and a 2.4 m ceiling sit inside the glass: the Follow view looks at the
outside of the ceiling and the backs of the near walls, not the take.

- **(A, recommended) Hug the take.** The disc is the take's reach (the
  avatar root's path, or the camera's path for a camera take) plus about
  1 m, so the dome fits the take; splats above head height plus a margin are
  dropped (the floor histogram also finds the ceiling's peak). The stored
  crop is the same volume, which also keeps it small. Less of the room
  shows; what shows is around the person.
- (B) Keep a 6 m disc and add a view-dependent cutaway of the walls and
  ceiling between the camera and the take. More of the room, but a new
  renderer behaviour on every viewer.
- (C) Today's 6 m dome, as is: walls and ceiling block the view indoors.

## Scope

**Included (slices 2a to 2c):**

- **`@holoim/place`, a new workspace package**, taking slice 1's loader,
  `readFloor`, `readUpright`, `placeOnFloor`, `cropToSweep` and the dome clip
  (GLSL and TS twin), plus the crop, thinning and SPZ writing for export.
  Plain TS and three; Spark as a dependency, loaded by dynamic `import()` so
  neither app's first chunk carries it. `PlaceLayer`, `PlaceMount` and
  `takeFloor` stay in the viewer; capture gets an IWSDK-side mount.
- **One runtime set swap.** A place replaces `avatarRig.worldModel`: the new
  world model is the floor disc (a visible, opaque mesh at set-frame y = 0,
  sized per Q7), and the motor, spawn, world bounds and terrain sampling are
  rebuilt from it. Every consumer listed in the background reads the disc,
  so feet, camera collision, object resting, the Record gate and the export
  keep working unchanged. The `SplatMesh` sits outside the set's raycast
  path; only pointing casts against it on purpose. On the desktop and in VR
  the author stands in the scan; phone AR and Quest passthrough show it as
  the dome-cut diorama (Q2).
- **A floor from the scan.** `readFloor`'s height is set-frame y = 0. The
  collider is an unbounded plane there (not just the floor band), with a
  visible fade where the scan ends, so a VR author who walks past the scan
  never falls; a take stands on ground as flat as the scan (slice 1's
  finding). Walls and furniture are not colliders; a take may walk through
  them.
- **Recording in it.** A performer take (desktop, Quest VR) or a camera take
  (phone AR) records as today, in the set frame. Pointing (desktop and VR
  from 2a; phone holds in 2c) resolves against the scan with Spark's splat
  raycast as well as the disc and event objects; a link to the scan has
  `to.node` = `RecordedPlace`, and resolves against the stored crop so it
  plays back where it was made.
- **Export.** `GLTFPlacePlugin` beside the other plugins writes
  `RecordedPlace` and `HOLOIM_place` v1 (Q4 A) from the scan cropped to the
  take's reach (Q7), thinned to fit (Q5). The crop and `writeSpz` run on the
  main thread or in Spark's workers, timed against the 60 s export timeout
  on each device. A take without a place exports as today.
- **The viewer reads it.** The feed card and portal render the stored place
  with slice 1's renderer and clip, from the GLB's own bytes, at the node's
  TRS, with the disc hidden. Before decoding, the viewer reads the SPZ
  header's splat count and refuses one over the cap (a gzip bomb or a lying
  `splatCount` must not crash a feed). Spark ships to production in a lazy
  chunk loaded only when a hologram has `HOLOIM_place`; `?place=` stays
  dev-only.
- **The API** checks an uploaded GLB's `HOLOIM_place` header (count within
  the cap, bytes within the buffer view) and rejects a malformed one; no DTO
  change.
- **Bringing a scan in:** the file picker and `?place=` (Q3 A), with the
  input cap (Q5) and one message on a refused or broken file.
- **Live budget:** Spark LoD caps per device (Q5); the LoD build time for a
  3 M input is measured on the Quest; a probe reports drawn splats and frame
  time for checks and `?debug`.
- **A flag.** Capture's place entry stays behind `?placeCapture=1` until 2a
  and 2b are verified; the viewer's reader ships with 2a, because a stored
  place must render wherever the GLB goes.

**Excluded:**

- Recording a performer in Quest passthrough (Q1: its own feature), and the
  place in it (2d).
- *Here* alignment with the real room (Q2, 2e), "My places" (Q3, 2e), and
  any DTO or storage change.
- `KHR_gaussian_splatting` output (Q4: a later version bump).
- Quick Look showing the scan: USDZ has no splats; it shows the floor disc.
- Colliders from walls or furniture, props resting on the scan beyond the
  floor, shadows or relighting, moving people in the scan, editing or
  cleaning a scan, a photoreal person.
- A privacy review step for scans. The stored crop is the take's reach only
  (Q7), not the orbit camera's bubble samples, so the published bytes hold
  little more than the dome shows; a real review step is a separate idea
  (IDEA-077's privacy tension).

## Acceptance criteria

Slice 2a (desktop):

- [x] With `?placeCapture=1`, the desktop page takes a `.spz` or `.ply` from
  its file picker or `?place=`; the scan replaces the set at true scale,
  upright; over a 10 m walk the avatar's feet stay within 2 cm of the scan's
  floor, and no cast lands on the old set.
- [x] A take recorded in it exports a GLB with `RecordedPlace` and
  `HOLOIM_place` v1 in `extensionsUsed` only, SPZ bytes that Spark decodes,
  and the floor disc in `RecordedSceneBubble`; every live-scan splat inside
  the viewer's fitted dome is in the stored crop unless thinned (the thinned
  count reported); the GLB is under 25 MB.
- [x] That GLB uploads through the real API and plays in the feed card and
  portal with the stored place at the node's transform, the disc hidden, the
  avatar's feet within 2 cm of the scan's floor, cut by the cloche; Follow,
  Free, pause and zoom work.
- [x] Pointing at the scan on the desktop makes a link whose end plays back
  within 2 cm of the hit; a hold behind a floater is checked.
- [x] Backward compatibility: the same GLB in `main`'s viewer build gives a
  dome whose base and radii are within 1 cm of this viewer's, plays on the
  disc, with no error; the USDZ converter converts it; a GLB without a place
  exports and renders as today (plugin JSON and counts compared).
- [x] A broken, oversized or unreadable scan leaves today's set with one
  message, and Record still works; a GLB whose SPZ header lies is rejected
  by the API and refused by the viewer without a crash.
- [x] No Spark code in either app's first chunk; the place chunk loads only
  for a hologram with `HOLOIM_place` or a capture place.
- [ ] Proof video: the user's (or the downloaded) scan, a take recorded in it
  on the desktop, uploaded and played in the feed.

Slices 2b (Quest VR) and 2c (phone AR), each with its device check:

- [ ] Quest VR (IWER, then the Quest): the author's `local-floor` is the
  scan's floor; walking or thumbstick past the scan's edge never drops them;
  drawn splats within the Quest cap; p95 frame time at most 13.9 ms over a
  60 s walking take on the Quest with `fireplace.spz` and the user's scan,
  dropped frames reported; no session hang.
- [ ] Quest passthrough (IWER, then the Quest): the scan stands as the
  dome-cut diorama; recording stays off. The IWSDK viewers and `ARView`
  render the stored place.
- [ ] Phone AR (IWER phone, then an Android phone): a camera take in the
  scan whose floor is set-frame y = 0; a held mark on the scan plays back
  within 2 cm of its hit; 30 fps on the phone.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Hidden set meshes still catch casts (feet on hidden hills, pointing at the old set) | The place replaces `worldModel` with the disc instead of hiding the set; e2e asserts no cast lands on the old set |
| A camera take cannot record, or exports "Nothing in the set" | The disc is a visible set mesh, so `hasSetInReach` and the export see it; IWER phone check |
| The occlusion test raycasts into the scan from each disc triangle | `SplatMesh` outside the set's raycast path |
| A scan picked at runtime leaves the motor on the old trimesh | The set swap rebuilds the motor, spawn and bounds |
| The cloche of a room shows the outside of the ceiling and the backs of walls | Q7: the disc and crop hug the take, ceiling dropped; screenshot in the Follow view |
| A stored crop re-read as a whole scan (flipped twice, wrong floor) | The stored place carries its transform; no reading at view time |
| Old viewers or the converter meet the place | Optional extension, no primitive to draw, the `KHR_audio` precedent; e2e on `main`'s viewer build and the converter |
| A gzip bomb or lying `splatCount` in a public GLB | SPZ header checked by the API at upload and by the viewer before decoding |
| The stored crop misses where the take went | Crop to the take's reach over the whole take; the dome-coverage criterion |
| Stored scan too large for 25 MB | SH 0 or 1, thin by distance from the path to what 25 MB leaves; e2e with a 3 M splat fixture |
| Crop and `writeSpz` exceed the 60 s export timeout on a phone or Quest | Timed on each device; the crop runs before `writeSpz` |
| Every feed card pays the place's download | Size cap, measured; noted in Q5 |
| A VR author walks off the scan's floor and falls | Unbounded floor plane, visible fade at the scan's edge |
| Scan axes or floor wrong (way up, table top, floaters) | Slice 1's `readUpright` and `readFloor` at load, with its fixtures; no floor means the place is refused with one message |
| Splat raycast hits floaters | Hold behind a floater checked in 2a |
| Quest frame rate drops (dense room) or LoD builds slowly | LoD cap per device; probe; measured on the Quest (physical only) |
| Quest WebXR hang with MSAA, per-frame shadow maps and Spark's async readbacks (reported for Spark 2.1 on Quest 3) | Checked first in 2b; capture turns off MSAA or shadow updates while a place is live if it reproduces |
| Two copies of three | Spark resolves to the catalog's `super-three`; lockfile and runtime check (slice 1) |
| Spark leaks into first-load bundles | Dynamic import; `check-prod-bundle.mjs` widened to capture |
| GPU memory left after a swap or the session's end | Dispose `SplatMesh` and `SparkRenderer` resources; heap noted on the Quest and the phone |
| A personal scan is committed | Fixtures written by the specs; real scans in the git-ignored `local-places/` |
| A set read as the take's site (principle 7) | `provenance.relation` is `set` unless aligned *here*; `kind: "reconstruction"` |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, final handoff; owns the `HOLOIM_place` contract |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation (done 2026-11-10) |
| Implementer, package | Assigned at 2a start | `packages/place/` (new), the move out of `apps/viewer-web/src/features/place/` |
| Implementer, capture | Assigned at 2a start | `apps/capture/src/place/` (new), the set swap in `avatar/AvatarRig.ts` and `physics/CharacterMotor.ts`, `recording/GLTFPlacePlugin.ts` (new), `GltfExportComposer.ts`, pointing against the scan, `ui/CaptureOverlay.tsx` (picker), `runtimeConfig.ts` |
| Implementer, viewer and API | Assigned at 2a start | `apps/viewer-web/src/features/place/` (read the stored place), `scripts/check-prod-bundle.mjs`, the API's SPZ header check |
| Independent verifier | Codex (`-p standard`, read-only) | Read-only verification; test artifacts only |

## Design decision

Approved by the user on 2026-11-10 with answer A to Q1 to Q7: one GLB
with a `RecordedPlace` node and `HOLOIM_place` v1 (Q4), a dome that hugs
the take (Q7), the dome-cut diorama in AR before alignment (Q2), Quest
passthrough sequenced after a performer-in-passthrough feature (Q1), a file
picker (Q3), Spark's per-device budgets (Q5), and desktop first (Q6). The
path keeps one self-contained
GLB and no DTO change, puts the risky part (the contract and its backward
compatibility) on the most testable device first, and reuses slice 1's
reading of a scan, now in a shared package, at load time only.

Design review (2026-11-10, `design-reviewer`, Opus), all adopted:
the place replaces the world model with a floor disc instead of hiding the
set (a hidden set still answers raycasts, and a dozen consumers read it);
Q7 on the cloche of a room; a `RecordedPlace` node whose transform the
viewer applies without re-reading the scan; pointing on the scan in 2a; Q2's
*elsewhere* as a dome-cut diorama; SPZ header checks in the API and viewer;
Spark's real LoD budgets, a fixed SH degree, sizing at Stop, thinning by
distance from the path; the crop off the export worker; an unbounded floor
with a fade; picking the scan before entering VR; `provenance.relation`;
crop to the take's reach, not the bubble samples; Quest passthrough and the
XR viewers moved to 2b; numeric acceptance criteria.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Scan as the set, floor, walking (2a) | `apps/viewer-web/e2e/place-capture.pipeline.spec.ts` (pipeline shard 8): a PLY written by the spec (floor off the origin, boxes, floaters under the floor, a faint and an opaque sheet), loaded by `?place=` and by the picker; a 10 m walk | Pass, 2026-11-11: 43,627 splats, floor found at 0.3501 (written at 0.35), floor band at the set's y = 0 within 0.03 mm, set = `PlaceFloor`, stage ground hidden, old set detached; 10.8 m walked, sole at most 7.8 mm off the floor; casts down an 81-point grid over and past the scan hit only `PlaceFloor` at y = 0 (and the hidden ground). The downloaded `fireplace.spz` and `snow-street.spz` load, stand upright and are walked on (sole within 2 cm) |
| Export contract (2a) | Same spec: Record, Stop, the GLB read with `readStoredPlace` | Pass: `HOLOIM_place` v1 in `extensionsUsed` only, `RecordedPlace` with the scan-to-set TRS, SPZ header = extension count, Spark decodes all 19,210 stored splats, `RecordedPlaceFloor` in `RecordedSceneBubble`, 3.3 MB, 0 thinned. Dome coverage against the scan's own splats: at nine times over the take the viewer's fitted dome showed 56,678 splat-times, all of them in the stored crop, while it swept 2.17 m. `fireplace.spz`: 161,364 stored, 4.87 MB; `snow-street.spz`: 45,891, 3.07 MB; at seven times over each take the fitted dome lies inside the crop's box (thinned counts reported as annotations) |
| Upload and play (2a) | Same spec: the GLB through the real API (Quick Look on) into the feed card and portal | Pass: stored place ready, disc hidden, stored floor on the disc within 0.03 mm, the author's foot bones at the height they stood at in capture within 2 cm, no shown splat leaving the dome at any time checked; pause, Free orbit, zoom inside (cut holds), Return, Play; screenshots `output/place-capture/room-*.png` |
| Pointing on the scan (2a) | Same spec: holds on a red box behind a faint (opacity 0.3) sheet and on an opaque sheet in front of a green box | Pass: the faint sheet lets the ray through to the box (x 0.80, sheet at 0.5), the opaque sheet catches it (within 3 cm of its plane); both links have `to.node` = `RecordedPlace`, stored ends within 2 cm of the hits, and the drawn ink ends within 2 cm of the hits in the feed |
| Backward compatibility (2a) | Same spec with `E2E_MAIN_VIEWER_URL` (`main`'s viewer test build at `f64690f`, served against the run's API) and `E2E_BASE_CAPTURE_URL` (capture at this branch's base, `origin/docs/splat-capture-brief`); the Quick Look converter on the place take | Pass: `main`'s dome base and radii equal this viewer's (difference 0), `main` draws the take on the disc with no error (`compat-*.png`); the converter reaches ready; a no-place take's extensions, node names, counts and plugin JSON shapes equal the base capture's, with and without `?placeCapture=1`. Against `main`'s capture the only difference is `main`'s newer positional audio (`KHR_audio` emitters), which this branch predates |
| Failure paths (2a) | Same spec: a 404, a PLY header over 3 M, a PLY whose comment claims a smaller count, a scan with no floor, a gzip that is not SPZ, a gzip bomb (10 splats over 8 MB), an `.obj`; GLBs whose SPZ header claims one splat more and 50 M | Pass: one message each, today's set and ground kept, Record exports a take without a place, the picker then places the scan; the API answers 422 to both lying GLBs, and the viewer served one anyway refuses it (status failed) without a page error |
| Bundles (2a) | Production builds of both apps, `node scripts/check-prod-bundle.mjs apps/viewer-web/dist` and `… apps/capture/dist --capture` (now in CI) | Pass: no Spark in either app's startup graph (viewer 3 startup chunks, 2 lazy with Spark; capture 6 startup, 2 lazy), no place report in the viewer's bundle. Capture's place code is its own chunk, loaded only with `?placeCapture=1` |
| Quest VR (2b) | IWER body check with a place; then the Quest via MetaVR | IWER report; on the Quest: frame times, drawn splats, LoD build time, heap. Pending |
| Quest passthrough and XR viewers (2b) | IWER `ar-record` quest-passthrough with a place; `test:xr:viewer` with a place GLB | Diorama cut by the dome; recording off; stored place rendered. Pending |
| Phone AR (2c) | IWER phone `ar-record` with a place and a hold on the scan; then an Android phone | Floor y = 0, link end vs hit; on the phone: fps. Pending |
| Proof video (each slice) | Real workflow, recorded under ignored `output/` | Sent to the user; not committed |

## Implementation notes (slice 2a)

- **What moved into `@holoim/place`:** `readFloor` and `readUpright`
  (`analysis.ts`), the dome clip and its GLSL twin (`clip.ts`) and the
  decode (`decode.ts`, the only `import()` of Spark). `placeOnFloor` and
  `cropToSweep` stay in the viewer's `placeSplats.ts` beside `PlaceLayer`
  and `takeFloor`: slice 1's live overlay is their only user, and capture
  crops by the take's path (`apps/capture/src/place/placeExport.ts`)
  instead.
- **Capture's place is its own chunk.** `CapturePlace` is imported only with
  `?placeCapture=1`, so a capture page without it never loads the place
  code or Spark; the widened bundle check caught the first version, which
  imported it statically.
- **Spark's raycast and meshes that never draw.** Spark counts the splats a
  render last updated, so the export's crop (never drawn) and a scan loaded
  while nothing draws gave no hits and every link fell to the disc. Both
  place meshes now carry their count (`raycastIndices`, LoD off).
- **The input checks.** A PLY's count is read from its header's own lines
  (a comment cannot claim a smaller one; found by the security review). The
  SPZ check no longer awaits the cancel of a stream it has refused:
  Chromium never settled it for a gzip bomb, which hung the load.
- **The crop** keeps the packed words of every splat in the estimated
  dome's swept box, less splats under the floor's slack, too faint to show
  or too large for any dome; none of those are drawn by the clip.
- **The backward-compatibility tests** need two older builds served beside
  the run (`E2E_MAIN_VIEWER_URL`, `E2E_BASE_CAPTURE_URL`), so CI skips
  them; they were run locally on 2026-11-11. The downloaded-scan tests run
  only where `apps/viewer-web/public/local-places/` holds the scans.

## Physical-device limits

IWER proves session, input, export and render behaviour, not splat frame
rate, LoD feel, heat or memory. Physical checks: the Quest 3 in VR (2b:
frame times with the user's scan, comfort walking in it, the MSAA and
readback hang) and in passthrough (spectator, 2b; recording, 2d); an
Android phone in Chrome (2c: 30 fps, marks on the scan, export time); the
iPhone for the flat page with a scan (2a) and for viewing the stored place
in the feed. Until each is run it stays under Unverified in `HANDOFF.md`.
