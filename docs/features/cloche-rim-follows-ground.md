# Feature brief: The cloche's rim follows the ground

**Lead:** Claude (Opus)  
**Status:** In verification
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
  neighbouring bins is ≤ max(0.05 × dome height, the ground's own step
  between them + 5 cm) (user decision, 2026-10-28).
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
     `Agua` in `scene.glb` (mesh `Agua_blinn1_0`, material `blinn1`, shared
     with `Mar_e_moto`): alpha mode `BLEND`, opacity 0.640 (base colour
     alpha), no transmission, so it counts. The hill take's export clips the
     scene to its bubble and holds no water.
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

## User decision (2026-10-28): hug the ground

On `scene.glb` the ground steps by up to a metre between neighbouring bins
at its crags, so "rim on the ground" and "neighbours ≤ 0.05 × dome height"
cannot both hold: limiting the step floats the rim 0.24–1.08 m over the
lower side. The user chose the ground ("Hug the ground"): the rim steps
with the ground at crags, and the neighbour criterion becomes |Δrim| ≤
max(0.05 × dome height, |Δground| + 5 cm), where Δground is the raw lift
between the two bins before smoothing. No neighbour limit runs in the rim.

Where the dome's edge crosses a crag's lip, or the take climbs faster than
the rim may move, the ground under a bin changes faster than 2 cm a frame
(the "Smooth" criterion, `maxRate`), and the rim lags it; while it lags,
its step from its neighbour is the ground's history, bounded by the
per-frame limit. So `floor-proof.ts` judges the neighbour rule on the rim's
target every frame, and on the rim itself where both bins have settled
(within 2 cm of their target); at least 5% of pairs must be settled.

## Implementation notes (2026-10-27)

Where the decisions above could not meet the acceptance criteria as written,
the criteria won. Each deviation is a token in `edge.cloche.rim`, measured on
the hill fixture:

- **Exact ground, no fill or blur** (decision 2). The grid and the flood
  fill stay, but the cells now index the ground triangles, and the ground's
  height at a point is the highest joined triangle over it, as drawn. The
  blurred, nearest-filled grid read `scene.glb`'s low-poly diorama 3–50 cm
  off at its creases and facets (36, 48 and 18 of 180 bins failed at the
  three times); exact triangles fail none. The `blur` token is gone.
- **The lip measured inward** (decision 2). A bin whose edge stands past the
  ground's edge reads the first ground inward toward the foot's centre, in
  5 cm steps up to `fillShare` × the wider radius, as the criterion measures
  it. The nearest ground on an oblique cut edge is down the slope: it read
  up to 0.6 m low.
- **Dead-band as a ramp, not a subtraction** (decision 3). Ground less than
  3 cm over the foot lifts nothing; from 3 cm the lift ramps back to the full
  height by 6 cm. Subtracting 3 cm everywhere puts every lifted rim exactly
  at the criterion's −3 cm bound, with no room for the smoothing.
- **No max filter** (`maxFilter` 0, decision 3 said ±2). One bin either side
  already stands the rim +10 cm over a 30° flank and ±2 bins +31 cm, against
  +5 cm. The Gaussian across bins stays, never below the raw lift, and now
  never more than `smoothRise` 3 cm over it, so a cliff's corner does not
  float its neighbours.
- **A rate limit** (`maxRate` 1.18 m/s, decision 3's easing). A brisk walk up
  a 30° flank moves the ground under the far edge by about 1.45 m/s; the
  easing alone moved the rim 2.1 cm in a 60 fps frame. The rim now lags
  rather than exceed 2 cm a frame.
- **The take advances first.** drei's `useAnimations` advanced the mixer in
  the card's own frame callback, after its children, so the shell, the rim
  and the dome clip read the bubble a frame late (5 m off for a frame at
  each loop). The card now advances its mixer at the start of the frame
  (`useTakeAnimations`), ahead of the cloche.
- **Takes that never lift** keep the flat foot, the shade and the sphere
  clip; the bend and the dome clip run only on takes whose rim lifts more
  than 5 cm somewhere on the path, decided at load.
- **Ground below the foot.** A bin whose ground lies below the dome's foot
  passes when the rim stays at the foot (lift is never negative; the floor
  cuts that ground).
- **Bounded on any upload.** Besides `maxCandidates`, the field is
  skipped (flat foot, logged) when its grid would pass `maxCells` (a path
  box 100 m across) or its triangles would make more than `maxEntries`
  cell entries, so a broken or hostile export cannot exhaust the tab.
- **"Nothing outside the glass" on the GPU.** Every drawn pixel of the
  recorded scene (avatar aside) from 16 orbit views, read back to its world
  point and tested against the bent dome by the test's own formula. A
  silhouette test is the wrong proxy: from the uphill side the eye looks
  under the clipped hill sheet, through the dome's open, bent floor, at
  scene that is inside the dome.

## Independent verification (Codex `-p standard`, 2026-10-28)

Round 1: changes required. Product defects fixed: a full cell replacing its
lowest layer now cuts the triangles that had joined it (buried layers no
longer inherit the new layer's connectivity); every triangle joins every
cell it overlaps, at the cell centre's height or its nearest point, so a
sliver of ground stays connected; and the rim snaps whenever the take's
time moves other than the frame moved it (by > 1 ms), so every seek snaps.
The GLSL twin now reads the rim's two texels and mixes them itself, in
full precision, since a texture unit's 8-bit filter weights put the clip
centimetres off its CPU twin across a metre's step between bins. Oracles
tightened: the glass check is metric (1 cm across the floor or out through
the wall, not a 1% value), reads back surfaces drawn without depth (glass,
water), and runs 24 views at all three snapshot times; ledges count only
when opaque; a bin over ground below the foot must stay within `smoothRise`
of the foot; and the neighbour rule is also checked against the test's own
raycast ground at each snapshot.

Two readings for the lead:

- **Capped bins.** Where the ground stands higher than 0.6 × the dome's
  height, the rim stays at the cap (the failure cases above: "Lift capped
  at 0.6 × dome height"), so "rim on the ground" is measured there as the
  ground at or above the cap. On the hill's start and `scene.glb`'s end the
  path climbs past that height.
- **Cost per frame.** JavaScript cannot promise a hard per-frame maximum (a
  garbage collection lands in some frame), and the browser's timer reads in
  0.1 ms steps. The check is the 99th percentile of the last 600 frames
  ≤ 0.25 ms, with the mean and the worst frame reported beside it. Bench:
  mean 0.067 ms, p99 0.19 ms, a single 2.3 ms outlier in 2,400 frames.

Round 2: changes required; Codex accepted both readings, the generation fix,
the seek snap and the GLSL twin. Fixed since: a triangle joins only the cells
it actually overlaps (an edge-line test per cell), not every cell of its
bounding box, so a prop no longer joins across empty ground or evicts the
seeded layers; the rim's per-frame update allocates nothing (edge directions
cached per exponent, the smoothing scratch reused); the hill check reads the
cost over a full 600 frames; and the glass check's wall give is at most 1 cm
anywhere (the dome scaled by 1 cm over its farthest reach), not 1 cm along
the smallest radius.

Left open, for the lead:

- **Cost budgets on CI** (decided below, 2026-10-28). In
  `scripts/ci-emulate.sh`, with the host's load average at 30–40 from other
  agents, the build took 60.6 ms (168 ms at 4× throttle) and the update p99
  0.9 ms, mean 0.22 ms, against 9.3 ms and 0.2 ms on this desktop.
- **Oracle limits.** The playback neighbour check reads the product's own
  ground lift per frame (the snapshots use the test's raycast), and a
  ledge's exception does not establish that the ledge is connected ground.
  Codex's pipeline recheck in Docker once reported one pixel 2 cm outside on
  `Montanha` mid-take and an AR entry failure; neither reproduced on the host.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Rim on the ground | Hill fixture in `e2e/bubble-fixture.ts` (`cloche-rim.spec.ts`); capture pipeline on `scene.glb` (`bubble-capture.pipeline.spec.ts`); `measureRim` in `floor-proof.ts` | `output/cloche-rim/hill-report.json`, `output/bubble-rendering/capture/rim-report.json`: 0 of 180 bins off the ground at start, middle and end on both (2026-10-28) |
| Nothing outside the glass | `measureGlass`: every drawn scene pixel from 24 orbit views at each of the three snapshot times (72 views) read back to its world point and tested against the bent dome, 1 cm give; control with the sphere's clip | Hill 0 outside (control 1,552), `scene.glb` 0 outside of 72 views |
| Smooth | `sampleRimMotion`: rim per bin every drawn frame over the take | Per-frame max 1.97 cm on both; neighbour excess over max(5% of height, ground step + 5 cm): hill −0.20 m, `scene.glb` −0.08 m on settled pairs and −0.05 m on the target |
| Flat takes unchanged | `cloche-rim.spec.ts` flat take, plus a fixed-time reduced-motion screenshot diff against `main` | Lift 0, shade drawn, sphere clip; 0 differing pixels of 1280×720 against `main` |
| Camera takes and old exports unchanged | `cloche-rim.spec.ts` camera take and old export | Pass; no rim, today's dome |
| Cost | `cloche-rim.spec.ts` feed perf, desktop and 4× CPU throttle | Field build 7.3 ms on desktop (27.9 ms at 4× throttle, ≤ 60 ms); rim update p99 0.2 ms, mean 0.10 ms over the last 600 frames |

**Cost on CI (lead decision, 2026-10-28).** The cost budgets above (build
≤ 15 ms, ≤ 60 ms at 4× throttle, update p99 ≤ 0.25 ms) are a desktop's and
are asserted whenever `CI` is unset; the host run is the evidence. Under CI
(`CI` set, as `scripts/ci-emulate.sh` sets it), where timing on a shared
runner is noise, the reports still record the timings and only a catastrophe
is asserted: build ≤ 150 ms and update p99 ≤ 2 ms, with no 4× throttle
assertion.

A manual orbit of the production hill take closes the loop.

## Physical-device limits

Feed rendering on flat screens only; no headset check applies. A phone
browser check of the hill take confirms frame rate and the half-float
texture's filtering on real hardware.
