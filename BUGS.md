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

### B-050 — The Poly Haven object-search case fails inside the full pipeline and passes alone

- **Area:** `apps/viewer-web` e2e (`object-search.pipeline.spec.ts`), `apps/capture/scripts/lib/summon-take.mjs`
- **Severity:** P2 (fails the `pipeline` step of `verify:pr`, which stops there)
- **Observed:** 2026-11-12, in three full `test:smoke:pipeline` runs: twice on `feature/profiles-and-share` and once on clean `main`
- **Evidence:** `e2e/object-search.pipeline.spec.ts:168` "found Poly Haven object: search, summon twice, credit survives the GLB, the feed card and the USDZ":
  `TimeoutError: page.waitForFunction: Timeout 10000ms exceeded` in `trayHolds` (`summon-take.mjs:657`, called from `runDesktopFindApiTake`, `:856`),
  the tray never reaching the expected count. Also failed in a full `verify:pr` on `ci-speedups` on 2026-11-12. Run alone it passes on both trees (1 passed in 57 s on `main` `73e9ef6f78aa`, 33 s on the branch).
- **Expected:** it passes in the full pipeline as it does alone.
- **Reproduction:** `pnpm run test:smoke:pipeline` from the repository root, with the five ports moved off their defaults when another run holds them.
  Suspect: the 10 s `trayHolds` wait on a loaded machine after many specs, or state left in the shared database or the stubbed Poly Haven server.
  2026-11-12 (`feature/hologram-budgets`): it also failed run alone, twice, at a load average of about 45 on 10 cores (other sessions' browsers), then
  passed alone (2 passed in 1.0 m) once the load fell to about 30; this points to the 10 s wait under load rather than leftover state.

### B-051 — Feed spatial audio's motion-wrap step flakes on hosted CI

- **Area:** `apps/viewer-web` e2e (`e2e/spatial-audio.spec.ts`), `test:e2e:mocked:shard2`
- **Severity:** P2 (fails the CI Gate, which skips every deploy)
- **Observed:** 2026-11-12 on hosted CI twice: run 43158849962 (`d0182e3c`, "after the motion wraps, every source is where the motion is") and run 43268222950 (`6b531875`, "the motion wraps", the poll at `spatial-audio.spec.ts:364` never seeing the clip time drop within `SPATIAL_CLIP_S + 4` s)
- **Evidence:** local runs pass (3/3 with `--repeat-each=3` on 2026-11-12); not yet run under `scripts/ci-emulate.sh`.
- **Expected:** the animated sources' clip wraps and the step passes on a 4-CPU runner as it does locally.
- **Reproduction:** `scripts/ci-emulate.sh pnpm --filter @holoim/web run test:e2e:mocked:shard2`, or rerun the CI shard.
  Suspect: the feed's clock runs slower than real time on a loaded software-GL runner, so the wrap misses the fixed poll window.

### B-052 — The profiles "copy link" check fails locally and passes on hosted CI

- **Area:** `apps/viewer-web` e2e (`e2e/profiles.pipeline.spec.ts:175`), pipeline shard 8
- **Severity:** P3 (fails the `pipeline` step of a local `verify:pr`; hosted CI passes it)
- **Observed:** 2026-11-12 on macOS: inside a full `test:smoke:pipeline` and, run alone twice, on this tree and on clean `origin/main` (`eb9add54d707`), with the ports moved off their defaults; the other four tests of the spec pass
- **Evidence:** "copy link and delete wait out of sight until the card is reached; delete is the owner's alone": `expect(getByRole("status")).toContainText("Link copied")` times out after 5 s, "element(s) not found" (`profiles.pipeline.spec.ts:190`). Hosted CI shard 8 passed it in runs 43272311181 and 43260608085, then failed it once on run 43319865598 (`37a99105`, no source change) and passed on rerun.
- **Expected:** the status line appears after "Copy link" is pressed, as on CI.
- **Reproduction:** `RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer pnpm --filter @holoim/web exec playwright test e2e/profiles.pipeline.spec.ts --workers=1` from a clean `main` worktree on a Mac.
  Suspect: the clipboard write or its permission differs locally (the status appears only after `navigator.clipboard.writeText` resolves), or the moved base URL origin; not yet run under `scripts/ci-emulate.sh`.

### B-053 — Place gate: a card that becomes first after its dome is fitted takes the place late

- **Area:** `apps/viewer-web/src/features/feed/HologramCard.tsx` (`placeRequest`), `HologramCardCanvas.tsx` (`placeGate`), `features/place/PlaceMount.tsx`
- **Severity:** P3 (the scanned place is a dev and e2e build feature, `testHooks` only; production never asks)
- **Found by:** `/find-implicit-state-machines` (2026-11-12), replayed 2026-11-12. Model: gate states `off | loading | ready | failed | timeout`; rule "a place draws only if the gate said ready before the dome was fitted".
- **Replay, reproduced:** `place.spec.ts` "a card that becomes first once its dome is fitted does not take the place". A faked two-card feed with `?place=` shows the place on the first card; deleting that card (the real Delete button, the real `DELETE` path) makes the second the first in the list. Its `placeRequest` was keyed on `first`, so it went from `null` to a request, `createPlaceGate` made a new gate in `loading`, `PlaceMount` mounted on a card whose dome was fitted long before, loaded the (cached) scan and reported `ready`: the place drew late, over a card the fit had treated as placeless. Before the fix the check read `status: "ready"` for the second card; after it, no place report exists.
- **Cause:** whether a scan is wanted was derived from `first` (the card's index), which changes while the card lives; the gate and the fit assume it is settled at mount.
- **Fix:** `HologramCard` reads `first` once, at mount (`useState`), so a card that later becomes first is not handed a place, and one that stops being first keeps its own. `?place=` on a fresh page, `placeFor`, and the fit's wait are unchanged.
- **Same cause, not replayed:** the card demoted by an upload at the top (`onUploaded` → `addToTop`) used to lose its `PlaceMount` while its recorded set stayed hidden from the fit. Needs a real upload; the fix removes the cause (the request no longer changes), the delete replay is the check.
- **Did not reproduce (suspected 1, as framed):** "the place mounts after the gate timeout and changes what the viewer sees". The late scan does set `place`, but `PlaceMount` renders it only while `gate.status === "ready"`, and the gate never leaves `timeout`. Check kept: `place.spec.ts` "a scan that is still loading when the fit gives up is not shown late" (scan held past `placeWait=1500`, then served whole: pixels and dome equal today's card, report `timeout`, one warning).
- **Did not reproduce for the user (suspected 2):** "`fail()` overwrites `timeout`". The gate does not: every writer checks `loading` first, so a terminal gate status never changes (a late failure leaves `timeout`). Only the diagnostic report differs (`status` reads `failed` after a timeout then a failure, `timeout` after a timeout then a success, and `loading` between the timeout and the load settling); the card is the same recorded one in every order, and the one-warning rule holds (`place.spec.ts` "a slow scan that then fails warns once"). Not changed.
- **Not done:** emulation in headless Chromium only; the upload demotion path was not replayed; no real-device run.

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
