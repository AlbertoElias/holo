# Feature brief: Richer holograms (raise the size budgets)

**Lead:** Claude (Opus)  
**Status:** Delivered 2026-11-12 (merged to `main`); device checks, marks on the detail level, feed first paint and the KTX2 fallback decision open  
**Layer:** event (what is recorded and kept), with view costs

## User outcome

An author records a take inside a detailed scan, with high-quality props, and
the hologram that viewers open keeps that detail: the place keeps its splats
and view-dependent colour, and props keep their textures. A viewer on a phone
still sees the hologram start quickly, and every device draws only as much
of the place as it can.

## Why this is needed: where the limits are today

The 25 MB upload cap (`apps/viewer-api/src/lib/constants.ts:1`) is the visible
limit, but for the place it is not the one that binds:

| Limit | Value | Where | Binds today? |
|---|---|---|---|
| Stored place splats | 200 k | `packages/contracts/src/place.ts:15` `PLACE_STORED_SPLAT_CAP` | **Yes**: a scan crop is thinned to 200 k whatever room is left |
| Stored place colour | SH degree 0 written by capture (`CapturePlace.ts:308` `maxSh: 0`); the contract already allows 1 (`place.ts:19` `PLACE_STORED_MAX_SH`) | capture | **Yes**: surfaces look matte from every angle. The SH data is also dropped on load: `decodeScan` keeps only `packedArray` (`packages/place/src/decode.ts:73,100`), and the crop copies only those rows (`placeExport.ts:145-149`) |
| GLB upload | 25 MB | `viewer-api` `MAX_GLB_BYTES`, hand-copied in `CapturePlace.ts:147` | Rarely: 200 k SH0 splats are a few MB |
| Tray | 5 items, 16 MB total | `apps/capture/src/objects/ObjectTray.ts:10-12` | Yes, for detailed props |
| One object | 8 MB, images up to 4096 px | `suppliedObject.ts:14`, `registry-fetch.ts:8` | Yes, for detailed props |
| Live splats drawn in capture | Quest 500 k, Vision Pro 750 k, Android 1 M, iOS 1.5 M, desktop 2.5 M | Spark's LoD defaults | Device GPU limit; unchanged |
| Viewer place drawing | No LoD: every stored splat is drawn | `StoredPlaceMount.tsx:122-124` (`enableLod: false`) | Fine at 200 k; **must change** for a larger place |
| Quick Look | 100 MB input, 4096² per texture, 64 MP texture total, 100 CPU-seconds | `glb_to_usdz.py:34-41`, `:1493` | Ignores the place; props count |

Splat-capture (`docs/features/splat-capture.md` Q5) chose 200 k, SH0 and
"sized at Stop to what 25 MB leaves". This brief revisits that choice.

Uploads already require sign-in: all three upload routes return 401 without
a session (`apps/viewer-api/src/routes/holograms.ts:38,107,169,235`). Capture
never uploads; the author downloads the take and uploads it in the viewer's
`UploadPanel`.

## Decisions (user, 2026-11-12)

- **Q1, place detail: whatever fits in 100 MB.** No splat-count target: the
  detail keeps as many splats as fit in what the 100 MB cap leaves after the
  rest of the take, up to the input cap (3 M, `PLACE_INPUT_SPLAT_CAP`), at
  **SH degree 1** where the source scan has it. Each device draws its own
  share through LoD. SH1, not SH3: SH3 costs about 2.5× the bytes per splat,
  so it would buy view-dependent colour with far fewer splats. (Revised from
  "2.5 M splats" the same day.)
- **Q2, cap: 100 MB per hologram, no anonymous uploads.** Tray 64 MB, one
  object 40 MB, images still 4096 px on a side. One cap for every upload,
  defined once in `@holoim/contracts`. Anonymous uploads are already refused
  (sign-in required since creator accounts); this brief keeps it that way
  and corrects the stale line in `live-deployment.md`.
- **Q3, feed speed: two levels of place.** A light place (today's: 200 k,
  SH0) is what the feed paints first; the full-detail place is swapped in
  after.

## Design (after review)

**One upload, split by the API.** Capture still writes one GLB. The
`HOLOIM_place` extension gains an optional `detail: { bufferView,
splatCount, maxSh }` that names a second SPZ in the same file. On
`complete` (and on the multipart route) the API checks the detail SPZ's
header, stores its bytes as `<id>-place.spz`, and stores a **light GLB**
with the detail buffer view removed. The hologram DTO gains an optional
`placeDetailUrl`. The GLB never holds a URL.

Why not a separate file from capture (the first draft): the author would
download two files and upload both, so a missing or mismatched SPZ becomes a
normal outcome. One file keeps today's download → upload flow and the
`UploadPanel` (`accept=".glb"`) unchanged.

Backward compatibility: `parsePlaceExtension` ignores unknown fields
(`packages/contracts/src/place.ts:147-160`), so older viewers read the light
place and nothing else. Old holograms have no `detail` and no
`placeDetailUrl`, and play as today. Quick Look receives the light GLB.

**Capture at Stop.**

- Carry SH1 (`PackedSplats.extra`) through `decodeScan` and
  `cropScanToTake`. A scan without SH1 stores SH0: `maxSh` comes from the
  source and is never padded.
- Write two levels from one crop: detail (≤ 3 M, SH1, sized to the cap) and light (≤ 200 k,
  SH0, thinned from the detail). Same node TRS for both; the light crop lies
  inside the detail crop, so the swap shows no jump.
- Size fitting: props first, as today; only the detail level is thinned to
  fit the 100 MB, with at most one rewrite (not today's four passes). With a
  full 64 MB tray the detail keeps far fewer splats; that is expected.
- The export's raycast mesh (`CapturePlace.ts:319`) is built on the light
  level, so pointing marks resolve against what every viewer paints first.
  The check confirms marks also lie on the detail's surfaces.

**Viewer.**

- Paint the light place (no change), then load the detail for the focused
  card once it has painted and is idle; free it when the card scrolls away.
- The detail needs LoD so each device draws its own budget. Where the LoD
  tree is built is **the first implementation step, a spike**:
  (a) built at Stop and stored with the detail (no viewer cost; larger file),
  or (b) built in a worker in the viewer for the focused card only, under a
  time and heap budget, with phones given a lower detail cap if it misses.
  `CapturePlace.ts:232-235` notes a tree for 1 M splats with SH "can take
  minutes of worker time", so (b) is only acceptable if the spike shows
  otherwise on an iPhone and an Android phone. The spike's numbers decide;
  record them here.
- **Spike result (2026-11-12).** Spark 2.3.1 tiny LoD in its worker,
  HeadlessChrome 145 on an Apple M1 Max (32 GB), a 3 M-splat SH1 place tiled
  from a real scan:

  | Step | 1 M SH1 | 3 M SH1 |
  |---|---|---|
  | Decode PLY | 0.27 s | 0.76 s |
  | `writeSpz` SH1 (the detail) | 3.2 s, 17.5 MB | 9.9 s, 50.3 MB |
  | LoD build (`createLodSplats`) | 3.3 s, 1 M → 1.51 M nodes | 11.1–11.9 s, 3 M → 4.40 M nodes |
  | LoD tree | 24.2 MB raw | 70.5 MB raw, 37.5 MB gzipped |
  | LoD splats as SPZ | 28.2 MB | 78.6 MB, 12.7 s |
  | Renderer peak (build) | | +936 MB at Stop, +772 MB in the viewer |
  | Viewer, option (b): read, decode, build | | 0.98 s + 11.9 s = 12.9 s |
  | Viewer, option (a): decode stored LoD + tree | | 2.0 s, +479 MB |

  No physical iPhone or Android phone was reachable (no adb device; the iOS
  simulator runs at Mac speed, and DevTools CPU throttling does not slow
  Spark's worker), so phone figures are a device gap. Scaling by the usual
  2–4× desktop-to-phone gap puts (b) at roughly 25–50 s and about 0.8 GB per
  3 M place on a phone.

  **Decision: neither (a) nor (b) as written.** (a) stores 78.6 + 37.5 =
  116 MB for a 3 M detail, over the 100 MB cap by itself, and the LoD splats
  written as SPZ decode back to zero splats in Spark 2.3.1 (Spark's own LoD
  format is RAD, written only by its Rust `build-lod` tool). (b) misses any
  reasonable phone budget and costs 13 s and 0.8 GB even on this desktop.
  Instead the viewer loads the detail without a LoD tree and **thins it to
  the device's Spark budget** when it is larger (Quest 500 k, Vision Pro
  750 k, Android 1 M, iOS 1.5 M, desktop 2.5 M; the same per-device numbers
  capture draws live) by keeping every k-th splat, the cheap kind of thinning
  capture already uses for the light level. That is the brief's "lower detail cap" applied at view
  time: one O(n) copy instead of a tree, so each device draws at most its
  budget. Follow-up, not in this brief: a true LoD detail as a RAD file built
  by the API with Spark's `build-lod` (needs a Rust binary in the API image).

**API.**

- Caps: one `MAX_HOLOGRAM_BYTES` (100 MB) in `@holoim/contracts`, imported
  by the API and capture (replacing the copy in `CapturePlace.ts:147`), and a
  new `PLACE_DETAIL_SPLAT_CAP` (3 M, the input cap) beside `PLACE_STORED_SPLAT_CAP`, which
  stays 200 k for the light level.
- Enforcement points: the `initiate` schema and the presign
  `content-length-range` (`holograms.ts:116,135`), the head check on
  `complete` (`:196`), and the multipart file limit (`:241`,
  `hologram-storage.ts:61`).
- Memory: `complete` reads the whole object (`:205`) and multipart uses
  `readFile` (`hologram-storage.ts:67`); at 100 MB on the 2 GB machine,
  validate the detail with a header and streamed check, and split the GLB
  without holding several copies.
- Delete removes the detail object too (`holograms.ts:417-466` deletes only
  the GLB and USDZ today).

## Scope

**Included:** the caps above; SH1 carried from scan to stored place; two
place levels in one upload, split by the API; viewer light-then-detail load
with LoD; delete of the detail; Q4's light and detail textures, animation reduction
and KTX2, with a separate Quick Look input; correcting
`docs/features/live-deployment.md`'s line about anonymous uploads.

**Excluded:** Spark's per-device draw budgets; avatar realism; Draco;
compression in capture's own export (the API does it, Q4); longer takes; SH degree 2 or 3; Quest recording in a
place (that arrives with splat-capture slice 2b).

## Q4: large non-splat holograms (decided 2026-11-12: A, B and C)

Without a place, 100 MB is the avatar, its animation, props and sound. What
fills it today: animation is every bone sampled every frame as float32 with
no keyframe reduction or quantization (`GltfExportComposer.ts:151-171`);
props and avatar textures are stored as given (PNG or JPEG); sound is Opus
in WebM (`AudioRecorder.ts:1`), already small. The viewer already decodes
meshopt (`apps/viewer-web/src/features/xr/hologramAssets.ts:34`).

All three run in the API's upload split, so capture's export stays as it is:

- **A. Two levels for the whole hologram.** The light GLB carries the
  avatar, animation, sound, the light place and props with textures
  downscaled to at most 1024 px. The detail carries full-size textures (and
  the detail place). The viewer paints the light hologram and swaps in the
  full textures for the focused card, freeing them when it scrolls away.
- **B. Smaller animation.** Keyframes that interpolation reproduces are
  dropped and rotations quantized (glTF-Transform `resample`, meshopt with
  `KHR_mesh_quantization`). The light GLB served to viewers carries the
  result.
- **C. KTX2 (Basis) textures** in both levels for the viewer: about 4–8×
  less GPU memory. The viewer gains a `KTX2Loader` beside its meshopt
  decoder.

**Quick Look** cannot read KTX2, and its converter's support for meshopt
and quantized animation is unverified. The converter therefore receives a
separate Quick Look input made at the split: full PNG/JPEG textures and
unquantized animation, no place. It is temporary (deleted after conversion)
and is still bounded by the converter's 100 MB input limit.

Added criteria and failures are listed below.

## Undo

None: the feature changes how much of a take is kept, not what the author can
do while recording.

## Acceptance criteria

- [x] A take recorded in a 3 M-splat SH1 scan with an empty tray stores a
      detail place of at most 3 M splats at SH1, sized so the take is at most
      100 MB, and a light place of at most 200 k at SH0
      (read from both stored SPZ headers).
- [x] A take in an SH0-only scan stores SH0 in both levels.
- [ ] The stored GLB holds no detail bytes; the DTO's `placeDetailUrl`
      serves them; an older viewer build plays the new hologram's light place.
- [x] The viewer paints the light place first and swaps in the detail with
      no change in position or floor height (within 0.5 mm).
- [ ] Each device draws at most its own Spark budget from the detail (render
      stats); light-to-detail time and peak heap on an iPhone and an Android
      phone are recorded and within the budgets the spike sets.
- [x] Scrolling a card away frees its detail (heap returns near baseline).
- [x] A 100 MB take uploads through both routes and plays; one byte over is
      refused with the cap in the message at capture and at the API.
- [ ] The tray accepts items up to 40 MB each and 64 MB in total and refuses
      the next byte with a notice.
- [x] Deleting a hologram removes its detail object.
- [x] Holograms uploaded before this change play unchanged.
- [ ] Feed first paint at 1 MB/s for a 100 MB hologram is no slower than for
      today's holograms (`snappy-feed-first-load.md` numbers).
- [x] Three concurrent 100 MB completes plus a Quick Look conversion stay
      within the API machine's 2 GB.
- [ ] Pointing marks lie on surfaces in both levels.
- [ ] A prop-heavy take without a place (64 MB of props, 4096 px
      textures, a long take) paints its light version first; full textures
      swap in for the focused card without a visible change in placement.
- [x] The served animation differs from the recorded one by at most 1 mm in
      bone position and 0.5° in rotation at every recorded frame, and its
      bytes shrink (reported).
- [ ] The viewer loads KTX2 textures on desktop, iPhone, Android and Quest;
      GPU texture memory is reported before and after.
- [x] Quick Look converts the take from its PNG/JPEG, unquantized input.
- [x] `pnpm run verify:pr` passes locally.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Capture and API caps drift apart again | One constant in `@holoim/contracts`, imported by both |
| SH1 silently lost between load and export | Carried through decode and crop; criterion checks the stored header |
| SH0 scan padded to SH1 (bigger file, no gain) | `maxSh` from the source |
| Detail drawn whole on a phone | Viewer LoD (spike decides where it is built); per-device draw criterion |
| LoD build or detail decode stalls the feed | Detail only for the focused card, after first paint, under a time and heap budget |
| Many cards keep detail in memory | Freed when a card scrolls away |
| Light and detail disagree in position (jump on swap) | Same TRS; light crop inside the detail crop; 0.5 mm criterion |
| Missing or mismatched detail file | One upload; the API splits it, so there is no pairing |
| Detail header lies (gzip bomb, wrong count) | Header and decompressed-size checks under `PLACE_DETAIL_SPLAT_CAP`, as for today's place |
| 100 MB uploads exhaust the 2 GB API machine | Streamed checks; concurrency criterion |
| Detail object orphaned on delete | Delete covers it |
| Old viewer meets the new `detail` field | `parsePlaceExtension` ignores unknown fields (`place.ts:147-160`); old-build check |
| Quick Look fed the full file | The converter receives the light GLB; props stay under its 100 MB input limit |
| Stop takes too long at 3 M splats | One crop for both levels, at most one rewrite; Stop timed on the 3 M fixture |
| Pointing marks off the painted surface | Raycast on the light level; checked on both |
| Animation reduction visibly changes motion (foot slide, hand jitter, lip sync) | Error bound criterion against the recorded frames; body and hand replays on the served file |
| A device without a Basis transcoder path shows no textures | KTX2Loader detects support and transcodes to what the GPU takes; per-device criterion |
| Quick Look meets KTX2 or quantized data | It gets its own PNG/JPEG, unquantized input |
| Texture or animation processing at upload exhausts the 2 GB API machine or takes too long | Processing time and peak memory measured on a 100 MB take; run in the existing conversion queue if it does not fit the request |
| Rewrite collides with splat-capture 2b and 2c | This lands before 2b starts (2b has not started, `splat-capture.md:4`) |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` (Opus) | Done 2026-11-12; findings folded in above |
| Implementer | Claude (Opus for the contract, export and API split; Sonnet for caps and tray) | `packages/contracts`, `packages/place`, `apps/viewer-api` upload, storage and delete, `apps/capture/src/place`, `apps/capture/src/objects`, `apps/capture/src/recording/GltfExportComposer.ts`, `apps/viewer-web/src/features/place` |
| Independent verifier | Muse (Meta; Codex was at its usage limit) | Read-only verification; test artifacts only. Found five defects: four fixed in `1a671ef`, one is the open decision under Known risk |

Coordination: `splat-capture.md` slices 2b and 2c change `prepareExport` and
the composer too. Land this first; 2b then carries the Quest recording and
frame-rate check in the denser place.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| LoD spike | Build time and heap for a 3 M SH1 tree, at Stop (desktop) and in a viewer worker (iPhone, Android) | Done on desktop (Design, Viewer: spike result); phones are a device gap; decision: thin to device budget |
| Both levels stored, SH from source | `apps/viewer-web/e2e/hologram-budgets.pipeline.spec.ts` (capture tests 1–2) with 3 M SH1 and SH0 fixtures | Pass: 35.4 MB take; light 200 k SH0, detail 2.83 M SH1 (SPZ headers); SH0 scan stores SH0 in both; a small scan stores no detail |
| Light GLB, detail URL, old viewer | `apps/viewer-web/e2e/hologram-budgets.pipeline.spec.ts` test 3; `apps/viewer-api/test/hologram-budgets.test.ts` split tests | Pass for the split: stored GLB 3.9 MB with no detail, `placeDetailUrl` serves the SPZ, both upload routes. Not run: a previous viewer build. Known risk below: processed GLBs require `KHR_texture_basisu` |
| Swap without a jump; marks on both levels | `apps/viewer-web/e2e/hologram-budgets.pipeline.spec.ts` test 3, feed portal | Pass for the swap: `floorBandY` equal before and after, detail in 1.41 s. Marks on the detail level not checked |
| Per-device draw, heap, free on scroll | `apps/viewer-web/e2e/hologram-budgets.pipeline.spec.ts` test 3 with the Quest budget forced | Pass on desktop: `drawnCount` 500 000; heap 15.4 MB → 19.1 MB with detail, back to baseline after scroll. Phones are a device gap |
| Caps and refusals | `apps/viewer-web/e2e/hologram-budgets.pipeline.spec.ts` test 5; `apps/viewer-api/test/hologram-budgets.test.ts` cap test; `pnpm --filter @holoim/capture run test:xr:summon` (tray-budget) | Pass: 100 MB accepted and played, +1 byte refused with 413 naming 100MB on both routes. Tray: a 23.45 MB item loads, a third copy (70.4 MB) is refused at the 64 MB total, counting a copy in the scene. The old 7 MB fixture failed against the 64 MB cap and was resized. A 40 MB single item not run |
| Delete | `apps/viewer-api/test/hologram-budgets.test.ts` delete test; `apps/viewer-web/e2e/hologram-budgets.pipeline.spec.ts` test 3 | Pass: place detail, texture detail and processed GLB removed; `deletedDetail` counts them |
| Old holograms | `pnpm run verify:pr` feed and pipeline suites, whose fixtures predate this change | Pass (B-043 flake aside, which passes alone) |
| Feed first paint | Throttled Chromium at 1 MB/s against a preview deploy | Not measured. The served first load is 3.9 MB against a 35.4 MB recording; baseline 4.2–4.7 s in `snappy-feed-first-load.md` |
| API memory | Three concurrent 100 MB completes plus a conversion, in Docker at 2 GB | Pass: stayed under 2 GB (processing is serial in the USDZ worker loop) |
| Quick Look | `apps/viewer-api/test/hologram-budgets.test.ts` Quick Look input test; `check_usdz_tools.sh` on the 3 M SH1 take | Pass 6/6. Input is the stored GLB without the place, PNG textures |
| Prop-heavy take, light then full | `apps/viewer-web/e2e/hologram-budgets.pipeline.spec.ts` test 4 | Pass at 30 MB (not 64 MB): a 4096 px texture is served as KTX2 at 1024 px (3.9 MB), the focused card swaps in 4096 px in 50 ms |
| Animation error bound | `apps/viewer-api/test/hologram-budgets.test.ts` processing tests; verifier's frame-by-frame compare | Pass: worst 0.32 mm / 0.17°; 1.82 MB → 85 KB on the fixture; long LINEAR tracks no longer overflow |
| KTX2 on each device | `apps/viewer-web/e2e/hologram-budgets.pipeline.spec.ts` test 4 on desktop | Pass on desktop (the ASTC probe now answers `extensions.get`). Phones and Quest are a device gap; GPU texture memory not reported |

## Known risk: processed GLBs require KTX2 (decision open)

Processing serves textures as `KHR_texture_basisu` listed in
`extensionsRequired`, with no PNG fallback. A viewer build from before this
change cannot load a processed hologram: a tab left open across the deploy
(there is no service worker) shows that card broken until it reloads. New
builds load it. Keeping a PNG fallback would undo the byte savings. Options:
accept it (tabs reload on the next visit), add a build-version check that
reloads stale tabs, or serve the fallback for a grace period. Found by the
independent verifier.

## KTX2 kept only where it saves bytes (fixed 2026-11-12)

Processing used to encode every texture to KTX2, even a small JPEG: the
capture's `avatar.glb` (twenty JPEG textures of 64 to 1024 px) was served as a
3.55 MB light GLB against a 1.83 MB upload. A texture that fits the served size
and whose KTX2 is no smaller than its upload now stays as uploaded (skipped as
`smaller-as-uploaded`), and `KHR_texture_basisu` is required only when some
texture still uses it. `avatar.glb` is now served at 1.83 MB, with one texture
in KTX2. A downscaled texture always takes its KTX2. Covered by "keeps a small
texture as uploaded when its KTX2 would be larger" in
`apps/viewer-api/test/hologram-budgets.test.ts`.

## Open checks

- Phones and Quest: light-to-detail time, peak heap, draw budget and KTX2
  loading (see Physical-device limits).
- Pointing marks on the detail level.
- Feed first paint at 1 MB/s for a 100 MB hologram against a preview deploy.
- A 64 MB prop take end to end (the pipeline ran a 30 MB one), and a 40 MB
  single tray item (the summon tray-budget check exercises the 64 MB total).
- A previous viewer build against a new hologram (see Known risk).

## Physical-device limits

iPhone and Android: light-to-detail time, peak heap and frame rate viewing a
3 M-splat place in the feed portal. Quest: viewing only (recording in a
place waits for splat-capture 2b). iPhone Quick Look open of a hologram with
64 MB of props. IWER emulation does not stand in for any of these.
