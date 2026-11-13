# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-042 — Agent-authored holograms have no Quick Look preview

- **Area:** `apps/capture/scripts/showcase/upload.mjs`, `apps/viewer-api/tools/glb_to_usdz.py`
- **Severity:** P2 (the sixteen showcase pieces cannot be opened in AR on an iPhone)
- **Observed:** 2026-11-10. All sixteen live items by "Claude (agent-authored)" have `quickLookEnabled: false` and `usdzStatus: "none"`.
- **Cause 1, fixed here:** Quick Look is opt-in per upload (`quickLookEnabled`, the upload panel's checkbox). The showcase upload script never sent the field, so no conversion was ever queued, and no route can turn it on afterwards. The script now asks for it by default (`--no-quick-look` opts out), waits for the conversion and prints its status.
- **Cause 2, fixed on `bug/usdz-vertex-colours`:** the converter dropped vertex colours (`COLOR_0`), and every showcase piece uses them. RealityKit ignores a `UsdPrimvarReader_float3` on `displayColor`, so the user chose (2026-11-11) to bake them in the converter; the live GLBs stay unchanged. `vertex_colors()` in `glb_to_usdz.py`:
  - all-white `COLOR_0` keeps the plain material, and the output is unchanged;
  - one colour becomes a tinted copy of the material. A base texture under varying colours gets their mean tint, flagged `approximated`;
  - varying colours go into one sRGB atlas per package (`textures/vertex_colors.png`). Each triangle gets a 4×4 cell, a 2×2 core plus a 1-texel guard, with the fourth core texel at p10 + p01 − p00, so bilinear filtering reproduces glTF's per-triangle interpolation. The UVs are a faceVarying primvar (`st`, or the first free `stN`), so points, normals, skin and morphs stay welded. Unlit colour goes to emissive; BLEND and MASK take opacity from the atlas alpha.

  A RealityKit probe on macOS (before the screen locked) showed that it decodes sRGB before filtering, honours faceVarying `st` and a second set `st1`, and fades unlit emission by opacity. The design-reviewer pass led to faceVarying UVs instead of unwelding. Uploads without `COLOR_0` convert identically: the USD layer and files match for the walk take, the credited bracket and the capture scene.
- **Inspector:** `inspect_usdz.py` gains `vertex_colors()`. It classifies each primitive from the source and decodes the atlas. It emulates bilinear sampling at every triangle's corners, centroid and edge midpoints against `COLOR_0` × factor, allowing 1 sRGB step at corners and quantisation plus a quarter of any clamped fourth-texel overflow inside. It also checks back-face UV reversal and the tint and atlas material variants. The old (white) Blue hour fails it on every coloured mesh.
- **Evidence (local, 2026-11-11):**
  - `showcase:upload --api <local>` (default Quick Look) reached `ready` for Blue hour, and the stored package passes the inspector and `usdchecker --arkit`.
  - All 14 convertible pieces pass the colour and material checks. Worst corner error is 0.5 sRGB steps, and only 7 of about 600k triangles have a clamped fourth texel. The full inspector passes on Blue hour, the dive and down. On `stairs` its geometry pass (901 animated nodes, about 3,700 sample times) did not finish in 20 min, on the old package as well.
  - The colour step costs 0.6 s on the largest piece (Walk around the year, 2048×1024 atlas). Conversion times otherwise track the old converter under the same load (load average about 40).
  - Packages grow by up to 2.5× (Walk around the year 4.3 → 10.7 MB, Blue hour 5.8 → 9.7 MB), mostly faceVarying UVs authored again on back faces.
  - RealityKit could not render the full packages because the screen was locked; the proof frames are offscreen SceneKit.
- **Converter version stays `ql3`:** output changes only for `COLOR_0` uploads, and none of the six stored live previews has `COLOR_0` (read-only scan of the live feed, 2026-11-11). A bump would force a production rebuild for identical output. Condition: before deploying, rescan `ready` previews for `COLOR_0`, and bump to `ql4` if one appears.
- **Backfill, done on production 2026-11-11** after the converter deployed (image `fd8b7d7`; a rescan found no `ready` preview with `COLOR_0`, so `ql3` stands). Database backup: `/data/dev.db.pre-b042-backfill-20261111`. Fourteen ids got `quickLookEnabled = true` and `usdzStatus = "pending"`. `rain` (both uploads) and `hearts` were left alone, since they fail the cause 3 budgets.
  - Ready, with colours: Two sides of a door, Blue hour, Orion isn't flat, The street that turns to follow you, Every moment of the dive, The corridor is a lie, Walk beside light, and The other side of the mirror. Blue hour, the corridor and the dive pass the inspector's colour checks on the published packages.
  - Reverted to `quickLookEnabled = false`, `usdzStatus = "none"`: Murmuration, From where you stand, The sea in the bathtub, Who holds the strings, Walk around the year, Everyone's down is different. Each hit the 100 s alarm on production 1 to 3 times. The worker defers a timeout as a retry with no attempt cap (`usdz-worker.ts`), so they would have looped every 10 minutes, kept the worker busy and shown "Preparing preview…" on iPhone.
- **Slow pieces, fixed on `bug/usdz-convert-speed` (merged and deployed 2026-11-11, `2fba1e6`):**
  - `glb_to_usdz.py` bakes animation from precomputed, vectorised tracks in one `Sdf.ChangeBlock` and batches rigid-mesh extents per frame. Local CPU time for the six fell from 8–57 s to 8–30 s; outputs match the old converter within float rounding (max abs 7e-7).
  - Limits: a 100 CPU-second budget (`ITIMER_PROF`, a permanent failure) replaces the 100 s wall alarm; the wall limit is 900 s (a retryable timeout), the API deadline 960 s and the `USDZ_STALE_CLAIM_MS` default 20 min.
  - The worker marks a conversion failed after three timeouts. A Quick Look request re-queues a failed item for one more attempt and does not reset the count (commit security review).
  - Second backfill: all six re-queued with `usdzAttempts = 0`; all six reached `ready`, each on its first attempt except Who holds the strings, which a Fly auto-stop interrupted once. Production wall times were 2–6 min each. All six published packages pass the inspector's colour and material checks.
- **Cause 3, open:** converter budgets. Locally 14 of 16 convert. `rain` fails ("Animation exceeds channel limit", 2362 channels over 2048, and then the baked-animation budget); `hearts` fails ("Animation extent evaluation exceeds conversion budget"; it converts in 48 s with that budget raised). `words` and `murmuration` take 79 s and 74 s on a loaded laptop against the 100 s alarm, and produce 17 MB and 30 MB packages.
- **Expected:** an authored piece opens in Quick Look with its colours.
- **Reproduction:** `showcase:build blue-hour`, start a local API with `USDZ_PYTHON` set, then run `showcase:upload --api <local> blue-hour` (status `ready`) and `inspect_usdz.py` on the stored GLB and USDZ.
- **Not done:** Fly auto-stop can still interrupt a long conversion when nobody is using the site (the worker reclaims it after 20 min). Not seen on a real iPhone or in RealityKit with the full packages. Cause 3 is still open.

### B-044 — On the user's table scan, the author's feet end 3 cm off the scan's floor

- **Area:** `apps/viewer-web` e2e and `packages/place` (split capture slice 2a)
- **Severity:** P3 (the case runs only where the user's own scan is on disk, an ignored file; the
  committed fixtures pass)
- **Observed:** 2026-11-11 on the merged slice 1 + 2a tree
- **Evidence:** `e2e/place-capture.pipeline.spec.ts:1042` "the downloaded scan table.spz", "the author's feet on the
  scan's floor": 0.029969515228847526 m against the 0.02 m limit, the same value in 2 of 3 runs (the third passed).
  The scan is a table rather than a room, 472,273 splats, from Scaniverse.
- **Expected:** the author stands on the scan's floor within 0.02 m, as on the committed fixtures.
- **Reproduction:** put the scan at `apps/viewer-web/public/local-places/table.spz` (and in the cached e2e build's
  `local-places/`), then in `apps/viewer-web` run
  `RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer pnpm exec playwright test e2e/place-capture.pipeline.spec.ts`.
  Suspect: the floor band of a scan whose floor is sparse around a table, or the end pose landing mid-step.

### B-054 — The summon XR check's `desktop-anytime` phase flakes on "mid-take row: no tray row"

- **Area:** `apps/capture` (`scripts/lib/tray-anytime-take.mjs`, `test:xr:summon`)
- **Severity:** P3 (a phase of the summon XR check; not in `verify:pr`'s pipeline stage)
- **Observed:** 2026-11-12 on `claude/bug-b-050-object-search-24dbf3`, found while verifying B-050
- **Evidence:** `SUMMON_ONLY=desktop-anytime` fails at `tray-anytime-take.mjs:204` (`checkRow(rowMid, { filled: 2, ... where: 'mid-take row' })`) with "no tray row": 2 of 3 runs with the B-050 fix, 1 of 4 without it, so the fix does not cause it. It ran at a load average of 30 or more.
- **Expected:** the tray dock shows its row mid-take on every run.
- **Reproduction:** `SUMMON_ONLY=desktop-anytime pnpm --filter @holoim/capture run test:xr:summon`, repeated on a loaded machine. Not isolated; suspect the same starved-page timing as B-050 (a wait that ends before the dock re-renders).

### B-055 — The ar-record check's `phone-put-back` phase flakes: "the tray dock is not shown"

- **Area:** `apps/capture` (`scripts/ci-ar-record-playwright.ts`, `test:xr:ar-record`, capture XR shard 1/2)
- **Severity:** P3 (a flaky check; the product behaves correctly)
- **Observed:** 2026-11-12 on hosted CI run 43330664456 at `main` `03d7961d3c6a`: `ci-ar-record-playwright.ts:518` `tapDock`, called from `putBackPhase`'s Close-ring step, "Error: the tray dock is not shown".
- **Cause:** a race in the check, not in the app and not in B-050's change. The Stop tap starts the export. While `recordingState` is `exporting`, `PhoneArChrome.update()` hides the tray dock and closes its row. On a runner where the export outlasts the Stop tap's own `drive` (`nextFrame` waits for an animation frame, or 100 ms), `advanceUntilDownload` stops stepping the manual clock the moment the download lands. The state is `idle` by then but no step has run, so `tapDock` read the stale dock (hidden, "Exporting...") and threw. Locally the export finishes inside the tap's `drive`, so the check passed on every normal-speed run (native 9 of 9, ci-emulate 8 of 8).
- **Reproduced** by forcing the slow export: the next 100 ms timer stretched to 3 s and one animation frame ignored. The probe then read "tray dock right after the download: false, row open false, status Exporting..." and the exact hosted error followed.
- **Fix:** `tapDock` steps the simulation until the dock is visible (a frame does not step the manual clock). `putBackPhase` now forces a slow export at the Stop tap (`slowNextExport`), so every run exercises the exporting → dock hidden → dock returns path. That exposed a second stale read: after the row reopens it is still sliding out, so the Close-ring step waits until the ring holds still before tapping.
- **Expected:** the phase passes at any export speed.
- **Reproduction:** before the fix, with the slow export forced, `AR_RECORD_ONLY=put-back pnpm --filter @holoim/capture run test:xr:ar-record`.
- **Fix status:** merged; close this entry once a hosted run of `main` passes shard 1/2.

### B-060 — A feed canvas connects pointer events to a container that is gone

- **Area:** `apps/viewer-web` (`features/feed/HologramCardCanvas.tsx`, `features/ar/ARView.tsx`; `@react-three/fiber` 8 `Canvas`)
- **Severity:** P3 (a page error, no visible break; fails any e2e that asserts no runtime errors, which skips every deploy)
- **Observed:** 2026-11-13 on hosted CI, run 43356706702 (`8f5b5f3e58`), pipeline shard 8, `profiles.pipeline.spec.ts`
  "a byline name opens that creator's page": `TypeError: Cannot read properties of null (reading 'addEventListener')` in
  R3F's `events.connect`, called from the `Canvas`'s `onCreated`. The next run (43360131531) passed the shard.
- **Evidence:** not reproduced in 8 runs of that test under `CI_EMULATE_LOAD=2` (those runs failed twice on the
  5 s `expect` deadline instead (6/8 passed), fixed in the same change by the pipeline's 20 s `expect` timeout:
  the whole `profiles.pipeline.spec.ts` ×5 under load 2 then passed 30/30.
- **Expected:** a card that unmounts while its canvas is still being created leaves no page error.
- **Suspect:** R3F connects events to the `Canvas`'s wrapper `div` (`divRef.current`) in `onCreated`, which runs after
  the root renders; a card torn down in between (the search feed replaced by the creator page) leaves the ref null.
  Fix candidate once reproduced: an `events` factory whose `connect` ignores a null target.
- **Owner:** the CI reliability session (claim in `.git/holoim-ci-owner.json`).

### B-062 — Find's Speak button stays on "Stop listening" after a refused recognition that has no recorder to fall back on

- **Area:** `apps/capture/src/objects/voiceInput.ts` (`startRecorder`, reached from `startRecognition`'s `onend`), shown by `ObjectFinder.tsx` and `VrFindPanel.ts`
- **Severity:** P3 (needs a browser that lists the Web Speech API but has no `navigator.mediaDevices`, i.e. a page served over plain `http://` on a LAN address; production is HTTPS. Typing and Enter still search; closing the sheet resets it)
- **Found:** 2026-11-13 by `/find-implicit-state-machines` (queue item 8, voice input), modeled in `VoiceInput.tla` (side-session notes), replayed against the real page
- **Reproduced (`test:xr:summon`, phase `desktop-voice-orders`):** tap Speak (recognition starts), the recognition fails with `not-allowed` and ends. `onend` sets the machine's `state` idle without telling the session, then `startRecorder` finds no `getUserMedia`, logs "no MediaRecorder" and shows "type instead", and returns without a state change. The session's `voice` is still `listening`: the button reads "Stop listening", Find stays disabled, and a tap on Stop calls `stop()` on nothing.
- **Expected:** the buttons follow the machine: back to "Speak" with the "type instead" line.
- **Fix:** `startRecorder`'s no-recorder branch sets the state idle through `setState`. Replay `desktop-voice-orders`: failed before the fix, passes after. Landed `f73048cc171b` (2026-11-13). Hosted run 43478134507 passed every capture job and the capture deploy; it is red only in a viewer redesign test from the viewer-timecode merge, so this stays open until a green run.
- **Not defects (modeled and replayed, recorded in `TODOS.md` item 8):** a transcription answer arriving after the sheet closed is discarded (abort); a `getUserMedia` answer after cancel is closed (generation).

## Entry template

```md
### B-### — Short symptom

- **Area:** app/package
- **Severity:** P0 | P1 | P2 | P3
- **Observed:** YYYY-MM-DD
- **Evidence:** link, error, or test name
- **Expected:** behavior
- **Reproduction:** minimal steps
- **Fix:** commit hash and validation (when closed)
```
