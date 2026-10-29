# Feature brief: Capture drops set triangles the hologram never shows

**Lead:** Claude (Opus)  
**Status:** Reviewed: not ready; blocked on a user decision (2026-10-29)
**Layer:** Event (the recorded set; see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

A take carries only the set geometry a viewer can see. Capture stops
exporting triangles buried under the ground's top surface (a rock's sunk
foot, a hill's flank under the grass, the underside of ground the grass
closes over) and triangles past the reach of any viewer's bubble. Takes are
smaller and the viewer draws, raycasts and fits less, while the feed, the
XR and AR viewers and Quick Look draw the same picture.

Queued in `TODOS.md` (user, 2026-10-27) as the follow-up to
[`archive/cloche-rim-follows-ground.md`](archive/cloche-rim-follows-ground.md).

## Background (measured 2026-10-29)

`SceneBubbleSampler` already clips the set (B-028): it keeps a triangle whose
closest point lies within 6 m of a bubble sample, splits long straddling
triangles so the set ends about a metre past the bubble, drops a flat
triangle with any other scene geometry above it, and exports only the
vertices the kept triangles use.

- **Bubble samples are not the viewer's bubble.** The samples are the
  camera (the head in XR, the desktop camera) and the avatar root. The
  viewer's clip follows `RecordedBubbleSphere`, whose only track is the
  avatar root (`GltfExportComposer`), radius 6 m. A camera take's sphere has
  no track and stays at the set's origin, while its samples follow the
  camera's path.
- **The feed's dome can draw past 6 m.** On a take whose rim lifts, the
  feed clips by the bent dome instead of the sphere
  (`sphereClipShader.ts`, `u_domeOn`), and `fitCloche` scales the dome past
  the farthest drawn point, so the ring B-028 keeps past the bubble is drawn
  there. On a camera take the gate keeps the sphere; XR, AR and the USDZ
  converter clip by the sphere.
- **The dome is fitted to drawn vertices.** `fitClocheNow` fits to every set
  vertex within the sphere at load (`drawnPoints`, all vertices below 3,000
  per mesh). Changing which vertices lie within 6 m of the fit-time centre,
  or how a straddling triangle is split, moves the dome.
- **What is hidden today.** The pipeline's walk take on `scene.glb` (fresh,
  `test:e2e:pipeline:shard1`): 675 set triangles, 37 KB of a 2.53 MB GLB
  (the avatar dominates). About 67 triangles lie under other geometry by a
  one-ray test, of which 21 are under another mesh (the grass over a rock's
  flank and the hill's buried flank); the rest are a rock's own lower faces,
  which a one-ray test wrongly calls hidden. 28 triangles lie past 6.5 m of
  the sphere's track. The production hill take
  (`w0ynfm6ikpzj6xcnb4sgqku8.glb`, exported before B-028's compaction) has
  592 set triangles, ~140 KB of 4.4 MB.

So the size win is real but bounded: a few per cent of the set's triangles
and a fraction of a per cent of a performer take's bytes on `scene.glb`;
larger on dense or deep sets.

## Scope

**Included (capture export only, `apps/capture/src/recording`):**
- Buried pass: after the clip, drop a kept triangle that is enclosed by the
  exported set (rule below).
- Reach pass: drop clipped pieces that lie wholly beyond the reach of the
  viewer's clip centre: the sphere's track for a performer take, the set's
  origin for a camera take.
- A test-only switch to export the same take untrimmed, for the comparison.
- A pipeline check that compares the same recording exported both ways.

**Excluded:** the viewer, its clip, the dome fit and the rim (unchanged);
the USDZ converter (unchanged; it reads fewer triangles); exact clipping at
the sphere (cutting triangles at 6 m: new vertices move the dome fit, and on
rim takes the dome draws past 6 m); the existing "anything above a flat
triangle" occlusion rule (unchanged, though it is broader than this one;
noted as a follow-up); old exports (not rewritten).

## Design decisions (proposed, before review; superseded by the review)

1. **Enclosed, not merely covered.** A point is enclosed when, from it, a ray
   in each of 17 directions (straight up, 8 azimuths at 45° up, 8 azimuths
   at 5° down, the lowest a feed orbit reaches being 8° under the target)
   first meets an opaque exported set surface from behind (the hit
   triangle's geometric normal points along the ray). Its own mesh counts
   (a rock's buried face rays into the rock and meets the rock's far side
   from behind). A triangle is dropped when its centroid, three points 90%
   of the way to its corners and its three edge midpoints (nudged 1%
   inward) are all enclosed. One ray that escapes or meets a front face
   keeps the triangle. A rock standing on the grass keeps its lower faces
   (rays downward-outward meet the grass's front); a floor under a table
   keeps (rays sideways escape); a floor under a one-sided roof keeps.
2. **The occluders are the export.** Rays are cast against the clipped set
   (after the clip and the reach pass), never the source scene: a surface
   the take does not carry does not hide anything, and a ray leaving
   through the clip's cut edge escapes. Opaque means: not `transparent`
   with opacity < 1, no `alphaTest` cutout or `alphaMap`, no transmission.
   Non-opaque hits are passed through.
3. **Reach.** A clipped piece is dropped when its closest point is farther
   than the reach from every centre: 7 m (6 m + B-028's 1 m straddling
   edge, so the ring the dome draws stays) around the sphere's track for a
   performer take, 6 m around the origin for a camera take (sphere clip
   only). Centres are the exported track deduplicated at 8 cm and found
   through a grid of 7 m cells. Splits are decided with today's samples, so
   every vertex within reach of a centre is the vertex exported today and
   the dome's fit does not move.
4. **One clip, then two passes.** Each mesh is clipped as today (split,
   occlusion), then the reach pass, then the buried pass against the whole
   clipped set, then compaction. `clipsAnything` (Record's refusal) is
   unchanged.
5. **Budget.** The buried pass is skipped (logged, set exported as clipped)
   above 60,000 clipped triangles, since three's raycaster has no BVH.
   Visible triangles exit on the first escaping ray.
6. **Test switch.** `__reexportLastTake({ trim: false })` re-exports the
   retained take with both passes off; the product never calls it.

## Design review (2026-10-29, `design-reviewer`, Opus): not ready

The reviewer's findings, all accepted by the lead:

1. **The cut wall shows what is under the ground.** The viewer clips at the
   moving sphere (or the bent dome); the export runs past it. A buried
   point 0.3 m deep at 5.9 m, seen from 30° outside, is seen through grass
   the shader has already cut away, so today a ring of buried rock feet and
   flanks shows in the cut wall and sweeps across the set as the sphere
   moves; Quick Look's static clip shows it from every side. Enclosure
   against the export (decision 2) would drop those visible triangles. A hit
   must count only inside the clip of every track centre whose clip holds
   the point.
2. **On `scene.glb` the enclosure rule drops nothing.** The above-rule
   already removes the grass cylinder's bottom cap, so the 5° downward rays
   leave through the open bottom. Confirmed by measurement below: 0
   triangles.
3. **"Met from behind" is not "unseen".** Hut floors, caves and vehicle
   interiors are enclosed by back faces and an XR viewer stands inside
   them; `scene.glb`'s winding was never visible (all double-sided) and a
   mirrored node flips it.
4. **Buried vertices can set the dome.** A performer's dome stands on the
   lowest drawn vertex (no `floorY`), and above 3,000 vertices per mesh
   `drawnPoints` samples by stride, so any drop moves which points it reads.
5. **The dome reaches past 7 m.** Exponent 2.6 and `fitMargin` 1.04 put its
   diagonal 8–14% past its radii, plus the base's offset; reach must be
   derived (about 8 m) or measured on the fixtures.
6. **Reach moves a camera take's bounds.** `drawnBounds` reads every
   exported vertex: the card's framing, AR height, the XR hit box and the
   gallery tile follow it, and B-028's framing rule. Exempt camera takes or
   compare those bounds.
7. **Cost.** Without a BVH a buried triangle costs 119 rays × N; the budget
   belongs in ray×triangle tests (about 5e7) or needs `three-mesh-bvh`, and
   export also runs on a Quest's CPU.
8. **Opaque** must exclude MASK, alpha maps, vertex alpha and transmission;
   animated nodes never occlude.

Its simpler option: ship the reach pass only (radius derived from the dome,
camera takes exempt), or only stop counting the camera as a performer's
clip sample; park the buried pass until a dense set shows a gain.

## Measured (2026-10-29)

The implementation as drafted (both passes, reach 7 m / 6 m), one walk
recording on `scene.glb` exported trimmed and untrimmed
(`output/pipeline-takes/walk-{trimmed,untrimmed}.glb`):

| | Untrimmed | Trimmed |
|---|---|---|
| Set triangles | 675 | 664 (−11, all reach: grass past 7 m) |
| Enclosed dropped | — | 0 |
| GLB bytes | 2,529,496 | 2,529,140 (−356, 0.014%) |

The set is 37 KB of the 2.53 MB take; the avatar and its motion are the
rest. An offline count on the same take (`apps/capture/output/trim/`) bounds
the most any trim could take: 21 triangles under another mesh's surface and
65 past 6 m of the sphere's track, about 13% of the set's triangles and
under 0.3% of the file. The production hill take
(`w0ynfm6ikpzj6xcnb4sgqku8.glb`) has 592 set triangles in 4.4 MB, with the
same proportions.

## Decisions for the user

1. **Is it worth doing?** On `scene.glb` the gain is at most ~13% of the
   set's triangles and under 0.3% of bytes, and the safe part (reach that
   keeps what the dome draws) is 1.6% and 0.014%.
2. **Do the cut wall and views from under the ground count as "shows"?**
   Today the sphere's and dome's cut shows buried geometry (and Quick Look
   from every side). Dropping it changes what those viewers see: the cut
   would show empty space under the grass sheet instead.
3. **May capture depend on `three-mesh-bvh`** for the buried pass on large
   sets, or must the pass stay limited to small sets?
4. **May a camera take's framing move** (the reach pass on a camera take
   changes its unclipped bounds), or is the reach pass performer-only?

## Acceptance criteria

- [ ] **Smaller.** On the same recording of the pipeline's walk take
  (`scene.glb`), exported trimmed and untrimmed: fewer set triangles and
  fewer GLB bytes trimmed, with the counts per mesh recorded; the same for
  the camera take on `pointing-targets.gltf`.
- [ ] **Feed looks the same.** Both exports uploaded and drawn in the feed;
  at three take times, from 80 views (pitches −8°, 12°, 30°, 55°, 78° × 8
  yaws × 2 distances) and the card's own framing: at most 0.05% of pixels
  differ by more than 8/255 in any channel in any view, the largest
  recorded.
- [ ] **The dome does not move.** Fitted base and radii equal within 1 mm;
  rim heights at the three times equal within 1 cm; the rim's gate, lift
  decision and shade decision equal.
- [ ] **B-028 holds.** `test:xr:marks` and `test:xr:ar-record` keep
  `PointingFloor_RecordedBubble` in every take.
- [ ] **Pipeline compatible.** `test:e2e:pipeline` shard 1 (feed and AR), 3
  (camera take and its USDZ) and 5 (capture to viewer, Quick Look) pass.
- [ ] **Cost.** The two passes add ≤ 250 ms to the walk take's export on
  this desktop, recorded.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A visible lower face of a prop is dropped (rock on grass, box bottom, overhang) | Enclosure over 17 directions, not one upward ray; feed pixel diff |
| Floor under a table, a deck or a one-sided roof is dropped | Sideways rays escape; the existing above-rule is untouched (follow-up) |
| A triangle partly above the ground is dropped | Seven sample points must all be enclosed |
| Something seen through the clip's cut edge disappears | Occluders are the clipped export, so rays leaving through the cut escape |
| Something seen through water or glass disappears | Non-opaque surfaces never occlude |
| The dome or the rim moves because vertices changed | Splits decided as today; reach ≥ the B-028 ring; dome and rim compared |
| A buried vertex was the dome's lowest point | Dome compared on the fixture; if it moves the brief returns to the lead |
| Geometry the rim dome draws past 6 m is dropped | Reach 7 m for performer takes |
| A camera take's floor framing changes (B-028 framing rule) | Reach 6 m around the origin keeps everything the origin's sphere draws; camera-take spec |
| Pointing resolves onto a dropped triangle | Resolution casts against the trimmed set; marks and pointing pipeline checks |
| A large set makes export slow | Early exit; 60k triangle budget; cost recorded |
| A non-plain mesh (morphs, interleaved) cannot be compacted | Its triangles are still dropped from the index; vertices kept as today |
| Old exports or the USDZ converter break | Format unchanged; pipeline shards 1, 3, 5 |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer | Claude (Opus, lead) | `apps/capture/src/recording/SceneBubbleSampler.ts`, `GltfExportComposer.ts`, `RecordingSession.ts`, `AvatarRecorder.ts`, `CameraRecorder.ts`, `src/runtime/automationHooks.ts` and its wiring; `apps/viewer-web/e2e/export-trim.pipeline.spec.ts` (new), `e2e/pipeline-takes.ts` |
| Independent verifier | Codex (`-p standard`) | Read-only verification; test artifacts only |

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Smaller; feed looks the same; dome does not move | `export-trim.pipeline.spec.ts` (new): one walk recording exported trimmed and untrimmed, both uploaded, drawn and compared | `output/export-trim/report.json`, per-view diff images; pending |
| B-028 holds | `test:xr:marks`, `test:xr:ar-record` | pending |
| Pipeline compatible | `test:e2e:pipeline:shard1`, `shard3`, `shard5` | pending |
| Cost | export timing in the report | pending |

## Physical-device limits

None: export runs the same on every device, and the comparison is on the
viewer's own renderer. A headset take's head samples no longer widen the
clip; that is covered by the reach rule, not a device behaviour.
