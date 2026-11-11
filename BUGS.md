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
- **Cause 3, open:** converter budgets. Locally 14 of 16 convert. `rain` fails ("Animation exceeds channel limit", 2362 channels over 2048, and then the baked-animation budget); `hearts` fails ("Animation extent evaluation exceeds conversion budget"; it converts in 48 s with that budget raised). `words` and `murmuration` take 79 s and 74 s on a loaded laptop against the 100 s alarm, and produce 17 MB and 30 MB packages.
- **Expected:** an authored piece opens in Quick Look with its colours.
- **Reproduction:** `showcase:build blue-hour`, start a local API with `USDZ_PYTHON` set, then run `showcase:upload --api <local> blue-hour` (status `ready`) and `inspect_usdz.py` on the stored GLB and USDZ.
- **Not done:** the six slow pieces need a converter that finishes inside 100 s on production (or a longer alarm), then a second backfill. Timeouts retry with no cap. Not seen on a real iPhone or in RealityKit with the full packages. Cause 3 is still open.

### B-043 — The bubble pipeline test cannot click its card's AR button after the avatar-format uploads

- **Area:** `apps/viewer-web` e2e (`test:smoke:pipeline`, part of `verify:pr`)
- **Severity:** P2 (fails `verify:pr` locally; the pipeline stage is not in hosted CI)
- **Observed:** 2026-11-11 on `main` `623e4645f986` and on `bug/b041-avatar-objects`
- **Evidence:** `e2e/bubble-capture.pipeline.spec.ts:44` "real capture bubble exports, uploads and draws in feed and
  immersive AR" times out after 6 min at `bubble-capture.pipeline.spec.ts:126`: clicking the new card's
  `.ar-trigger-button` keeps hitting `<div data-reach="hidden" class="portal-controls" data-portal-mode="follow">`
  (and `.portal-controls-side`), which "intercepts pointer events". 2 of 2 full-stage runs on the branch and 1 of 1 on
  `main` fail the same way; the other 27 tests pass.
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
