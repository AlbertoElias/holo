# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-049 — Capture take lifecycle: a starting take reads as idle, and a late mic refusal reads as "no microphone"

- **Area:** `apps/capture/src/recording/RecordingSession.ts`, `AudioRecorder.ts`
- **Severity:** P3 (the start window lasts as long as the microphone prompt; the second needs two `getUserMedia` calls that disagree)
- **Found:** 2026-11-12 by a TLA+ model of the take lifecycle (`TakeLifecycle.tla`, in the side-session notes for this run), each claim replayed against the real page
- **Reproduced 1, `isTakeBusy()` was false while a performer take started:** Record pressed, the microphone not yet answered: `ui.recordingState` is `idle`, size is locked (`sizeLocked`), and `isTakeBusy()` (`startingCamera !== null || recordingState !== 'idle'`) is false. Its consumers read it as "no take", so `CapturePlace.load` accepted a scan (`?placeCapture=1`) under the starting take instead of refusing it as it does while recording. The same gap was in a camera take letting go of the microphone after a hidden page or a session end (`await audio.stop()` with the size still locked). The camera start itself was covered by `startingCamera`.
- **Reproduced 3, the shown microphone state came from whichever request spoke last:** `requestMicPermission()` (page load) and the take's own request (`getOrCreateStream`) are two `getUserMedia` calls; each wrote `micPermission`. The take's request granted and recording began, then the probe's refusal arrived: `micPermission` `denied`, and the overlay said "No microphone: takes save without sound." over a take that records sound (the export does carry `KHR_audio`). Needs the two calls to disagree (a transient device error on one), so it is rare; the replay answers them by hand.
- **Fix, on `bug/take-lifecycle`:** `RecordingSession` keeps one `TakePhase` (`idle | starting | recording | exporting | abandoning`) in place of `sizeLocked`, `startingCamera`-as-busy and the `recordingState` reads. `isTakeBusy()` and `isSizeLocked` are `phase !== 'idle'`, `toggle()` acts only in `idle` (start) and `recording` (stop). `ui.recordingState` is unchanged for everything the user sees. One writer, `publishMicPermission()`, sets `micPermission` from `AudioRecorder.getPermissionState()`, which is `granted` while a stream is live whatever a separate request last heard; the probe's refusal no longer overwrites a live stream's grant. `render_game_to_text` gains `heightAdaptation.recordingTakeBusy`. No change to the exported GLB.
- **Replay:** `pnpm --filter @holoim/capture run test:xr:take` (`apps/capture/scripts/ci-take-lifecycle-playwright.ts`; desktop, manual clock, the microphone answered by hand). Before the fix `start-window` and `mic-order` failed (scan load accepted during the start, `isTakeBusy` not true, UI `denied` while recording); after it all four phases pass. Reports in `output/take-lifecycle/` (`run-before.log`, `run-after.log`, `report.json`; ignored). The fixed model (`TakeLifecycleFixed.tla`) holds every rule.
- **Did not reproduce, suspected 2:** "`endCameraTake()` ignores performer takes, so a page hide or an XR session end mid-start leaves a take running or half-started." The omission is real but not a defect. The `performer-ends` phase hides the page and ends a VR session while the microphone is pending: the start completes, the take records on the desktop, a hidden page mid-take does not stop it, and Stop exports one GLB and unlocks size. Nothing is stuck. The documented promise (`docs/features/archive/ar-recording.md:253`) is for camera takes, which stop and export; the model's rule for them (`CameraTakeEndsWithSession`) holds, and the existing `ar-record` phases (`hidden-at-start`, `ended-at-start`, `session-end`, `page-hidden`) cover it. Not replayed: a performer take across a long hidden page on the real clock (the manual clock cannot show a time gap).
- **Also checked, no defect:** a double Record in one task makes one start and one microphone request; a double Stop makes one export and one download (`toggle-races`); the model found no way for a second take to begin while one is starting, recording or exporting.
- **Not done:** emulation (IWER) and Chromium's fake microphone only, no physical headset or phone. While the microphone prompt is open Record is refused without a message and there is no way to cancel a starting performer take (unchanged; if the prompt is never answered the take never starts). The model leaves out the input-recording await (test builds only), the held microphone's release, and the export's own steps.

### B-048 — R3F AR view: a late anchor pulls the model back to a spot it left

- **Area:** `apps/viewer-web/src/features/ar/ARHologramModel.tsx` (`requestWorldAnchor`), reached only through `/ar/:id?shell=r3f`, the fallback shell; the default IWSDK shell (`placementSystems.ts`) is a different code path
- **Severity:** P3 (fallback shell only; needs `createAnchor` to answer after a re-placement)
- **Found:** 2026-11-11 by a TLA+ model of the placement stage, then replayed against the real view
- **Cause:** `createAnchor`'s answer was accepted whenever the placement mode was set, so an anchor asked for at one spot was adopted after the model had moved. The frame loop then set the model to the anchor's pose. Two orderings:
  1. Placed on a surface, anchor pending, the viewer turns away and the visibility fallback puts the model in front of them, the anchor arrives: the model jumps back to the unseen surface spot, and the status reads `visibility-fallback` with `anchored: true`.
  2. Placed, anchor pending, Recenter places it again elsewhere, and the old anchor arrives after the new one (WebXR does not order the answers): the model jumps back to the first spot.
- **Fix, on `bug/ar-late-anchor`:** `anchorRequestEpochRef` counts placements; `clearActiveAnchor` (every re-placement, reset and anchor loss) and the visibility fallback bump it, and an answer from an older epoch is deleted instead of adopted. The other modes (`hit-test`, `plane-detected`, `floor`) place and anchor as before.
- **Replay:** `apps/viewer-web/e2e/ar-late-anchor.spec.ts` holds `XRFrame.createAnchor` open with a shim and steps exact frames (clock frozen). Before the fix, orderings 1 and 2 failed (model back at `[0, 1.299, -0.86]` from `[0, 1.38, 1.53]`, and from `[1, 0.129, -1.8]`); after it all three checks pass. Reports in `output/ar-late-anchor/` (`run-before.log`, `run-after.log`, `*.json`; ignored). Wired into `test:e2e:mocked` and its shard 1. `verify:agent` (lint, typecheck, unit tests) passes.
- **Model's second claim did not hold:** "an anchor overwrites a `locked` model, and anchored models get no monitoring". Replayed (the third check): the anchor resolves after the 45-frame lock, the stage label goes `locked` → `anchored`, and the model does not move (it was anchored at the spot it stood on). Nothing reads the label but the `data-placement-stage` attribute and `arController`, which treats both as placed, so there is no user-visible defect and no change was made. Frames spent with an anchor skip the visibility monitor, so looking away does not trigger the fallback (also pinned by the third check); that fits the placement being a point in the room the viewer chose. The model was wrong to treat `locked` as terminal: the code never said so. A device that answers `createAnchor` within a few frames never reaches the fallback for surface placements; that is by design, not a recorded requirement either way, so it is left as a note.
- **Not done:** emulation (IWER) only, no physical headset or phone. The default shell's `ArPlacementSystem.adoptAnchor` (`placementSystems.ts:432`) only discards an anchor whose hologram is `searching` or gone, so a slow anchor after a floor tap (`placeAtTap`) or a two-hand move may pull the hologram back the same way. Not replayed here; the same shim would do it.

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

### B-043 — The bubble pipeline test cannot click its card's AR button after the avatar-format uploads

- **Area:** `apps/viewer-web` e2e (`test:smoke:pipeline`, part of `verify:pr`)
- **Severity:** P2 (fails `verify:pr` locally; the pipeline stage is not in hosted CI)
- **Observed:** 2026-11-11 on `main` `623e4645f986` and on `bug/b041-avatar-objects`
- **Evidence:** `e2e/bubble-capture.pipeline.spec.ts:44` "real capture bubble exports, uploads and draws in feed and
  immersive AR" times out after 6 min at `bubble-capture.pipeline.spec.ts:126`: clicking the new card's
  `.ar-trigger-button` keeps hitting `<div data-reach="hidden" class="portal-controls" data-portal-mode="follow">`
  (and `.portal-controls-side`), which "intercepts pointer events". 2 of 2 full-stage runs on the branch and 1 of 1 on
  `main` fail the same way; the other 27 tests pass.
- **Update 2026-11-12:** it also fails intermittently when the spec runs alone on clean `main` `fff8507`
  (same click, same overlay, 6 min timeout): in two simultaneous runs of `main` and of `main` plus unrelated
  CI-script changes, round 1 failed on both and round 2 passed on both, so it is a timing race, not tied to
  the avatar-format uploads alone. Under heavy machine load it failed 0 of 5, then passed on a quiet retry
  (`test:smoke:pipeline` 34 passed, 5 skipped).
- **Expected:** the card's AR button is clickable whatever other cards the feed already holds.
- **Reproduction:** `pnpm run test:smoke:pipeline` (about 17 min). The spec alone passes
  (`RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer pnpm exec playwright test e2e/bubble-capture.pipeline.spec.ts` in
  `apps/viewer-web`, 57 s), so it depends on the three `avatar-formats` uploads that run before it. Suspect: a
  portal-controls overlay marked `data-reach="hidden"` still takes pointer events over the neighbouring card.

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

### B-046 — The face XR check finds no IWER gaze device

- **Area:** `apps/capture` XR checks (`test:xr:smoke` → `test:xr` face, part of `verify:pr`)
- **Severity:** P2 (fails `verify:pr` locally)
- **Observed:** 2026-11-11 on `origin/main` `1f4ec3a02077` (clean worktree) and on `feature/undo-redo`
- **Evidence:** `node --import tsx scripts/run-xr-checks.ts face` fails after about 17 s:
  `page.evaluate: TypeError: Cannot set properties of undefined (setting 'connected')`, from
  `window.IWER_DEVICE!.gaze!.connected = true` (`scripts/ci-face-playwright.ts:232`). 3 of 3 runs; every other
  XR check passes.
- **Expected:** the face check gets the IWER device with eye gaze and passes.
- **Reproduction:** in `apps/capture`, `node --import tsx scripts/run-xr-checks.ts face` (with `DEV_PORT` moved if
  5174 is taken). Suspect: the device the check gets no longer has `gaze`, after an IWER or harness change.

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
