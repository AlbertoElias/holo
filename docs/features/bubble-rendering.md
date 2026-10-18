# Feature brief: Bubble rendering across feed and XR

**Lead:** Codex bubble session
**Status:** Verifying

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

- [ ] Controlled fixture reproduces the original rendering defects before the fix.
- [ ] Feed and actual IWER stereo cameras show visible glass, inside geometry and
  no outside geometry, including rotated views and non-unit model scales.
- [ ] Animation continues; feed sphere follows the recording while AR sphere is pinned.
- [ ] Material arrays retain all entries; setup/cleanup restores source materials and
  disposes owned materials on repeated mount/unmount and configuration changes.
- [ ] Actual capture-exported GLB loads through upload into feed and immersive AR.
- [ ] Same deterministic before/after sequence produces a short video, PNGs and JSON.
- [ ] Independent review and required verification pass before integration.

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
| Test shares another session's runtime | Dedicated 5274/3274/3101/5275 port overrides |

## Ownership

Lead/implementer: this session; browser bubble modules, new bubble E2E, script wiring,
brief and evidence. Design reviewer and independent verifier: separate read-only agents
required by FEATURE_WORKFLOW for export/render compatibility. No converter edits.

## Design decision

Design reviewed by bubble_design agent (2026-10-18): accept recovered fixes and
add draw-time synchronization, bubble-only AR pinning, positive pixel controls,
and grouped-material lifecycle checks. Supported AR parents are uniformly scaled;
arbitrary ellipsoid clipping is outside scope. Preserve canonical GLB recording semantics and
fix the coordinate/material defects locally; establish a rendering baseline before
applying the recovered runtime patch. USDZ should approximate pinned AR sphere,
translucent glass and clipping of sampled scene/avatar, with limits documented.

## Test plan and evidence

Controlled unlit glTF fixture provides exact color oracles; actual capture-exported GLB
provides compatibility evidence. Run through browser feed and IWER immersive AR.
Store artifacts under output/bubble-rendering; run verify:agent then verify:pr with
session-specific port overrides. Baseline, after and independent review pending.

## Physical-device limits

IWER establishes emulated stereo rendering and deterministic behavior only. Physical
headset transparency, tracking, comfort and performance remain untested.

## Current evidence (2026-10-18)

- Baseline origin/main c8c3a4d4abe7; recovered test fixture repaired to valid GLB.
- Design reviewer: bubble_design; independent verifier: bubble_verify. Initial
  review found pipeline gate omission; new pipeline spec is now wired into it.
- verify:agent passed (sandbox rerun required for Prisma cache access).
- Controlled stereo, actual head movement, grouped material lifecycle and morph/
  draw-time transform checks pass. IWER stereo explicitly enabled at 64 mm IPD;
  default IWER views initially shared a pose and were insufficient stereo evidence.
- Real capture → upload → feed → AR passes. Final stereo-enabled pipeline rerun
  and verify:pr remain pending. Quick Look conversion files remain untouched.
- Video: `output/bubble-rendering/BEFORE-AFTER.mp4` (pending encoding).
- Reproduce comparison: capture before/after variants using the same harness,
  then `pnpm exec tsx scripts/render-bubble-comparison.ts`.
- Semantics and USDZ approximation contract: [../BUBBLE_RENDERING.md](../BUBBLE_RENDERING.md).
