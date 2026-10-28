# Feature brief: The cloche's rim follows the ground

**Lead:** Claude (Opus)  
**Status:** Ready for implementation
**Layer:** View (see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

A take recorded on a hill no longer looks like a sheet of ground floating
halfway up an empty glass dome in the feed. The dome's rim settles onto the
ground under it, and where the ground stops short of the dome's edge, the
rim tucks in under the ground's lip. From any angle the glass and the ground
meet, so the event reads as a place standing on its own ground.

## Background

Since B-033 (`2b15fa8c`), the feed fits the cloche to everything the bubble
draws and stands its foot on the lowest drawn ground. On a hilltop take
(`avatar-recording-1792945435020`, production media
`w0ynfm6ikpzj6xcnb4sgqku8.glb`; the scene is the capture app's
`apps/capture/public/gltf/models/scene.glb`) that foot is about 6 m below the
author: the bubble (radius 6 m) cuts the hill's flanks down to it, but the
hill is a one-sided surface, so between the ground and the foot the dome is
empty glass. The author walks about 18 m during the take (feet 17.1 m to
19.2 m), and the bubble and dome follow, so the ground under the rim changes
every frame.

Mockups (2026-10-27, scratch orbit videos, not committed) compared today's
view with an earth block under the ground, this rim, and a small patch of
ground with a smaller dome. The user chose the rim. The approved mockup clipped
the scene to the dome, not to the 6 m sphere; that clip is part of the look.

Design review (2026-10-27, `design-reviewer`, Opus): not ready as drafted;
the decisions below record its required changes. It found three bugs in the
mockup's mechanics (direction mismatch, clamped grid lookups, grid too small)
that the decisions correct.

## Scope

**Included (feed portal only: `HologramCardCanvas`, also the portal view):**
- The shell, embers and sparks bend so the rim follows a per-direction height
  over the ground, recomputed as the bubble moves.
- The recorded scene is clipped by the bent dome instead of the sphere.
- Framing accounts for the lifted rim.
- The shade rule for takes whose rim lifts.
- Gate: the rim runs only when the sphere clip is active, the take is not a
  camera take, and `RecordedAvatar` is present; otherwise lift is 0.

**Excluded:** The XR/AR viewer and IWSDK shells (keep the sphere clip and a
flat foot on the recorded floor, B-022; not queued). The Quick Look USDZ edge
(`viewer-api/tools/cloche.py` stays flat; the divergence is accepted and
recorded in styleguide 3.4). `ClocheShape` and its golden parity. Removing
scene triangles hidden below the ground at capture (queued in `TODOS.md`).

## Acceptance criteria

All rim checks measure against the drawn ground with the test's own raycast,
never the implementation's height field.

- [ ] **Rim on the ground.** On the hill fixture and the capture pipeline's
  `scene.glb` take, per bin at t = 0, mid-take and the end: rim − ground at
  the dome's edge (or at the ground's edge measured inward) is within
  [−3 cm, +5 cm] where the slope is under 30°; on steeper slopes the
  tolerance is one cell × the slope.
- [ ] **Nothing outside the glass.** Drawn ground vertices outside the bent
  glass = 0, from any orbit angle.
- [ ] **Smooth.** At 60 fps, the largest per-frame change in any bin is
  ≤ 2 cm except at a loop or seek snap; the largest change between
  neighbouring bins is ≤ 0.05 × dome height.
- [ ] **Flat takes unchanged.** Lift ≤ 1 mm everywhere and the shade drawn;
  a fixed-time, reduced-motion screenshot differs from `main` by ≤ 0.5% of
  pixels.
- [ ] **Camera takes and old exports** (no `RecordedSceneBubble`) unchanged:
  lift 0, sphere clip as today.
- [ ] **Cost.** Ground field build ≤ 15 ms on desktop and ≤ 60 ms at 4× CPU
  throttle on the hill; rim update ≤ 0.25 ms per frame.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Props (posts, fences, walls, roofs, the boat `Barco`, canopies) count as ground | Connectivity ground rule (decision 3): disconnected surfaces drop out. Synthetic fixture has a post, an 8 m wall and a roof box |
| Buried geometry in exports (a lowest-hit pick) | Flood fill stays on the connected top surface; fixture has a buried slab |
| Water or glass counts as ground | Materials with opacity < 0.5 or transmission > 0 skipped; opaque water joined to the shore counts (user decision). Fixture has a water plane and a glass pane |
| A ground object changes class between takes because the export is clipped | Per-triangle rule, no per-mesh extent test |
| No ground anywhere under or inside the rim | Lift 0: today's dome |
| Ground higher than the dome can take | Lift capped at 0.6 × dome height |
| Rim lifts in the wrong direction on a footprint stretched by a walk | One angle for bins and samples: θ = atan2(z/rz, x/rx) |
| Grid lookups outside the read area return the edge cell | Grid covers the path box + max(rx, rz) + 0.5 m; outside it returns no ground |
| Bent floor cuts a valley or the author's feet at the centre | Bend weighted by w(ρ) = smoothstep(0.4, 1, ρ), zero near the axis |
| The avatar or recorded objects are cut by the dome clip | Avatar and recorded objects exempt from the dome clip |
| Burnt fronts crawl across the glass as the rim moves | Bend in the vertex shader; burn noise keeps the unbent position |
| Rim pops where the ground under it changes (a cliff, a gap) | Continuous rim field built at load, smoothing across bins and asymmetric easing over time |
| Take loops, scrubs, pauses, or the bubble jumps | Snap without easing on loop, seek or a bubble jump > 1 m; reduced motion snaps every frame |
| Framing shows empty space under the lifted rim | Frame the dome bent by the lowest rim over the path, fixed at load |
| Shade hangs in empty glass under a lifted rim | Shade rule (decision 1) |
| Flat takes get a few cm of lift from a foot below the surface | 3 cm dead-band |
| Camera takes (they contain `RecordedSceneBubble`) get a rim | Explicit gate; camera-take check |
| Reading the ground is slow (no BVH for raycasts) | Draw ground triangles into the grid instead of raycasting; cached per model; skip and log above ~300k candidate triangles |
| Several cards build the field at once | Cache per model; build deferred one frame if over budget, rim 0 until ready, no easing on first appearance |
| A large uniform array exceeds phone uniform limits | Rim heights in a 180×1 half-float texture |
| Quick Look differs from the feed | Accepted; recorded in styleguide 3.4 |
| `floor-proof.ts` asserts the unbent dome | Its `outsideGlass` test moves to the bent inside test over drawn points |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Reviewed 2026-10-27 |
| Implementer | To assign (Standard tier) | `packages/xr-ui-core` (rim from field, smoothing, bend and inverse, bent inside test, bent framing points), `packages/xr-ui-three/src/ThreeCloche.ts` (`setRim`, `clocheBend` chunk, shade), `packages/xr-ui-r3f/src/Cloche.tsx` (optional `rim` prop), `apps/viewer-web/src/features/hologram/groundField.ts` (new), `sphereClipShader.ts` / `sphereClipping.ts` / `useSphereClipping.ts` (feed-only dome clip; IWSDK shells unchanged), `apps/viewer-web/src/features/feed/HologramCardCanvas.tsx` (fit, framing, gate, `hitTest`, `throughGlass`), `PointingHighlights` bubble fade, `e2e/floor-proof.ts`, `e2e/bubble-fixture.ts`, `bubble-capture.pipeline.spec.ts`, a new feed perf check, `docs/product/design/styleguide.md` 3.4 and 5.1, `tokens.json` (`edge.cloche.rim`) |
| Independent verifier | Codex (different vendor) | Read-only verification; test artifacts only |

## Design decisions

Chosen from mockups: the rim follows the ground. Reviewed mechanics:

1. **Shade.** Decided once at load: if the largest rim lift over the path
   exceeds 0.05 m, the shade is not drawn and the recorded ground stands in
   for it; otherwise today's shade. Flat and camera takes keep the shade, and
   nothing pops during playback. Styleguide 5.1 gains that exception.
   Confirmed by the user 2026-10-27 over a shade draped on the ground.
2. **Reading the ground.** At load, in `fitClocheNow`, cached per model. Over
   a grid of 0.2 m cells covering the path box + max(rx, rz) + 0.5 m:
   - Candidates: meshes inside `RecordedSceneBubble` only (no avatar,
     recorded objects, bubble sphere, camera or chrome); skip materials with
     opacity < 0.5 or transmission > 0.
   - Draw triangles whose world normal.y ≥ 0.35 into the cells, keeping up to
     4 height layers per cell (layers within 0.1 m merge).
   - Water counts as ground when its material is opaque enough and it joins
     the shore; the rim may rest on the water's surface (user, 2026-10-27).
     The implementer records `Agua`'s alpha mode and opacity here.
   - Flood-fill from the cell under the author's feet at t = 0 and from each
     path sample, stepping to a neighbour's layer when |Δh| ≤ 0.35 m. Cells
     not reached have no ground.
   - Build the rim field: fill cells with no ground from the nearest ground
     cell up to 0.7 × max(rx, rz) (the old inward search limit), then
     Gaussian blur σ = 0.3 m. This replaces the per-frame inward step search.
   - Expose `rimReady` on the test probe.
3. **Rim per direction.** 180 bins, θ = atan2(z/rz, x/rx) for both bins and
   samples. Each frame per bin: raw = field(edge point) − foot,
   lift = min(max(0, raw − 0.03 m), 0.6 × ry). Across bins: max filter ±2
   bins, circular Gaussian σ = 1.5 bins, then max(result, raw), biased upward
   because the dome clip cuts the ground cleanly at a rim slightly high, while
   a low rim shows empty glass. Over time: exponential easing τ_up = 0.05 s,
   τ_down = 0.2 s; snap on loop, seek, a bubble jump > 1 m, or reduced motion.
   Constants live in `tokens.json` under `edge.cloche.rim`.
4. **Bend on the GPU.** bend(p) = p + ŷ · L(θ) · w(ρ) · (1 − y/ry), with ρ the
   footprint's superellipse norm of (x/rx, z/rz) and w = smoothstep(0.4, 1, ρ).
   Heights go in a 180×1 `HalfFloatType` `DataTexture` with linear filtering
   and u wrapping, sampled in a `clocheBend` chunk in `ThreeCloche`'s `COMMON`.
   The shell bends position while `vLocal` stays unbent; embers bend
   `position` before drift; sparks bend their birth site. Normals approximate
   as normalize(n.x, n.y / s, n.z) with s = 1 − L·w/ry. `ThreeCloche` gains
   `setRim(heights)` and `Cloche.tsx` an optional `rim` prop. `fitCloche`
   and `ClocheShape` are unchanged.
5. **Clip follows the bent dome (feed only).** The recorded scene is clipped
   with a hard edge by unbending y and testing y ≥ 0 and the superellipsoid
   ≤ 1, in place of the sphere clip; the avatar and recorded objects are
   exempt. One inside test in `xr-ui-core` with a GLSL twin; `hitTest`,
   `throughGlass`, `PointingHighlights` and `clocheOpacityAt` use it.
   XR, IWSDK and AR keep the sphere clip. Confirmed by the user 2026-10-27:
   the feed's drawn edge is the dome's glass, crisp, not the sphere's fade.
6. **Framing.** At load, the lowest rim per bin over about 16 path samples;
   `clocheFraming` frames the dome bent by it, fixed for the take.
7. **XR later.** Not adopted and not queued: in AR the dome stands on the
   room floor by rule, and in a headset the dome fades out around the viewer.
   The maths in `xr-ui-core` keeps it possible.

## User decisions (2026-10-27)

All three review recommendations accepted: no shade on takes whose rim
lifts; the feed clips the scene by the bent dome; opaque water counts as
ground.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Rim on the ground | New synthetic fixture in `e2e/bubble-fixture.ts` (a mound with a cut edge, a post, an 8 m wall, a roof box, a glass pane, a water plane, a buried slab, a bubble walking up the slope); capture pipeline on `scene.glb` (`bubble-capture.pipeline.spec.ts`); rim report from `floor-proof.ts` | `*-report.json` with rim − ground per bin at three times; pending |
| Nothing outside the glass | `floor-proof.ts` `outsideGlass` on the bent inside test; feed orbit on the fixture | Count in the report; screenshot contact sheet; proof video; pending |
| Smooth | Rim per bin per frame over the take | Max per-frame and neighbour change in the report; pending |
| Flat takes unchanged | Existing feed and cloche checks plus a fixed-time screenshot diff against `main` | Pixel diff and lift in the report; pending |
| Camera takes and old exports unchanged | Existing camera-take checks | Pass; lift 0 in the report; pending |
| Cost | New feed perf check (none exists yet), desktop and 4× CPU throttle | Build and per-frame timing in the report; pending |

A manual orbit of the production hill take closes the loop.

## Physical-device limits

Feed rendering on flat screens only; no headset check applies. A phone
browser check of the hill take confirms frame rate and the half-float
texture's filtering on real hardware.
