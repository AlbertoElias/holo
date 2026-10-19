# Feature brief: Bubble rendering across feed and XR

**Lead:** Codex bubble session
**Status:** Complete  
**Layer:** View

## User outcome

Capture exports keep their recorded scene and avatar inside a visible glass bubble in
the desktop feed and immersive AR, including animated playback and head movement.
Reviewers can inspect a deterministic before/after video, pixel results and screenshots.

## Scope

Included: browser sphere clipping, glass shader, AR aura coordinates, material arrays
and lifecycle, capture-export compatibility and rendering regression wiring.
Excluded: USDZ converter/cache (separate session), avatar height, locomotion, physical
headset validation. Preserve feed following recorded sphere motion and AR pinning it.

## Acceptance criteria

- [x] Controlled fixture reproduces the original rendering defects before the fix.
- [x] Feed and actual IWER stereo cameras show visible glass, inside geometry and
  no outside geometry, including rotated views and non-unit model scales.
- [x] Animation continues; feed sphere follows the recording while AR sphere is pinned.
- [x] Material arrays retain all entries; setup/cleanup restores source materials and
  disposes owned materials on repeated mount/unmount and configuration changes.
- [x] Actual capture-exported GLB loads through upload into feed and immersive AR.
- [x] Same deterministic before/after sequence produces a short video, PNGs and JSON.
- [x] Independent review and required verification pass before integration.

## Failure cases considered

| Failure | Evidence |
| --- | --- |
| View-space normals compared to world direction distort rim under rotation | Common rigid rotation of actual XR eye/model; compare rendered pixels |
| World radius applied beneath scaled parent scales aura twice | Non-unit model scale and measured/rendered sphere/aura sizes |
| Outside recorded scene or animated avatar protrudes | Colored controlled inside/outside probes and real capture GLB |
| Multi-material meshes lose groups | Controlled multiple primitive fixture and material inspection |
| Remount clones leak or corrupt cached GLTF | Repeated mount/unmount/configuration change with dispose/restore observation |
| Animation deforms before clipping position is computed | Moving/skinned capture avatar, post-deformation world-position shader |
| AR pinning accidentally removed or feed freezes | Sample animation and sphere positions in each mode |
| Test checks status but nothing draws | Pixel counts from real renderer and actual XR eye cameras |
| Test fixture cannot load | Valid GLB MIME/data, console errors fail check |
| Test shares another session's runtime | Dedicated 45743/45740/45741/45742 port overrides |

## Ownership

Lead/implementer: this session; browser bubble modules, new bubble E2E, script wiring,
brief and evidence. Design reviewer and independent verifier: separate read-only agents
required by FEATURE_WORKFLOW for export/render compatibility. No converter edits.

## Design decision

This is a View-layer correction under the current hologram definition: preserve the
recorded body, scene and timeline while fixing how each device presents the sphere.
Feed following and AR pinning remain viewing policies; event data stays canonical.


Design reviewed by bubble_design agent (2026-10-18): accept recovered fixes and
add draw-time synchronization, bubble-only AR pinning, positive pixel controls,
and grouped-material lifecycle checks. Supported AR parents are uniformly scaled;
arbitrary ellipsoid clipping is outside scope. Preserve canonical GLB recording semantics and
fix the coordinate/material defects locally; establish a rendering baseline before
applying the recovered runtime patch. USDZ should approximate pinned AR sphere,
translucent glass and clipping of sampled scene/avatar, with limits documented.

## Test plan and evidence

Completed 2026-10-18. Design review: bubble_design. Independent implementation and
artifact review: bubble_verify, PASS with no unresolved findings. Final full
`verify:pr` exited 0 after merging current main's TypeScript 7, recenter, and
Quick Look opt-in upload changes. No converter implementation was edited here.

| Criterion | Reproducible workflow | Result / artifact |
| --- | --- | --- |
| Baseline | Original runtime trio from c8c3a4d4abe7 with final harness | Expected failures; rotation error 2.49 / 2.47 versus 0 / 0 corrected |
| Stereo rendering and head movement | `test:xr:viewer` includes `ar-bubble.spec.ts` | Distinct ±0.032 m eye poses, visible shell/content, positive outside control then zero outside pixels |
| Matching before/after | Exact mixer sampling plus actual IWER yaw/pitch | 24 identical requested/observed stereo poses and animation times; midpoint error < 1.1e-7 m |
| Aura scale | Non-unit 0.4625 model scale | World radius 0.428 before, 0.925 after, matching clipping radius |
| Material lifecycle | Reconfiguration and three browser unmount/remount cycles | Two groups/colors preserved; 15 owned materials created, 12 disposed, 3 correctly active |
| Deformation and frame order | Browser morph + immediate transform change before draw | Outside deformed vertices disappear; clipping center matches shell without intervening frame |
| GLB compatibility | `test:smoke:pipeline` includes real bubble capture pipeline | Capture → export → API upload → feed and both immersive eyes render content/glass; feed moves, AR pinned |
| Integration | `verify:agent`, native TS7 E2E typecheck, final `verify:pr` | Quality, unit tests, production builds, both pipelines, capture mock/locomotion/hands, five viewer checks pass |

Final verification environment:

```bash
DEV_PORT=45743 E2E_BASE_URL=https://localhost:45740 E2E_API_PORT=45741 \
  E2E_CAPTURE_URL=https://127.0.0.1:45742/ \
  USDZ_PYTHON=/private/tmp/holoim-quicklook-python/bin/python pnpm run verify:pr
```

The original 5274/3274 set and the next 3474 candidate conflicted with concurrent
sessions. The final high ports were checked free; other sessions' servers were
left running. The CI office scene also exposed an offscreen positive marker;
the harness now moves the actual IWER device to a controlled view for that oracle.

Durable evidence directory:
`/Users/albertoelias/.codex/visualizations/2026/10/18/01a14f6d-77d4-7b32-a871-47e1b6c9ff2d/bubble-rendering/`.
Start with **BEFORE-AFTER.mp4** (eight seconds). `comparison/{before,after}` holds
matched PNGs/JSON and expected baseline failures; `capture` holds the real exported
GLB and feed/stereo rendering evidence. `verify-pr.log` is the full passing transcript.
The video preserves the eye projection aspect and shows the left eye; assertions
and JSON cover both. Comparison sources are preserved separately from subsequent
regression runs. Re-encode with `pnpm exec tsx scripts/render-bubble-comparison.ts`.

Canonical semantics and USDZ approximation requirements:
[../../BUBBLE_RENDERING.md](../../BUBBLE_RENDERING.md).

## Physical-device limits

IWER establishes emulated stereo rendering and deterministic behavior only. Physical
headset transparency, tracking, comfort and performance remain untested. This session
does not claim physical Apple Quick Look playback.
