# Feature brief: Hand traces (v0)

**Lead:** Claude Code  
**Status:** Complete
**Layer:** Meaning (read)

Product decision and trial plan: [PRD-023](../../product/prds/PRD-023-hand-path-ribbons.md),
approved 2026-10-28.

## User outcome

In the feed portal on a phone or desktop, a viewer pauses a headset take and
sees where each of the author's hands went in the 3 s before that moment, as
a thin tapering trace at true scale. They can orbit it to read its depth, size
and direction. A Traces toggle adds a fading 1 s tail behind each moving hand
during playback.

## Scope

**Included:**
- Capture: record each frame's `HandPoseSource` per side, and write
  `recorded` motion spans over each side's hand and finger bones for the
  stretches where tracked hands drove them, in `HOLOIM_meaning.spans`, even
  when the take has no pointing.
- Viewer: sample each hand's index fingertip world path from the primary
  clip over a 3 s window ending at the paused time, inside recorded spans
  only, with stillness and travel suppression.
- Rendering in the feed portal (`HologramCardCanvas`), shown while paused; a
  Traces control that also draws a 1 s fading tail while playing.
- Pipeline e2e checks on IWER-scripted headset takes (shapes, walk, teleport,
  snap turn) and on the real headset fixture, with a numeric report and
  screenshots.

**Excluded:** detected demonstration spans and a stored `trace` mark (slice
2); traces in the VR and AR viewers, stills and Quick Look; desktop-take
traces; controller traces; speed encoding on a paused trace; cleaned shapes
(IDEA-004); smoothing of tracking jitter.

## Acceptance criteria

- [x] **Signal.** A headset take's export carries `HOLOIM_meaning` with
  `recorded` motion spans over `leftHand`/`rightHand` and their finger bones
  for frames whose source was `xr-hand`, whether or not the take has pointing.
  `controller`, `mock`, `held`, `fallback`, `none` and hands-in-menu
  (`neutralizeAuthoringSpans`) frames are excluded; spans shorter than
  0.25 s are dropped. The record still validates as v0. A desktop take
  writes no recorded hand spans.
- [x] **Presence.** Paused on a headset take, each hand whose fingertip
  moved more than 5 cm in spatial extent (largest distance from the end
  point) within the window shows a trace ending at its fingertip; a hand
  under that shows none, however much it jittered.
- [x] **Recorded only.** A trace segment is drawn only when both of its end
  samples fall inside a recorded span whose `bones` include `${side}Hand`.
- [x] **Fidelity.** Every drawn trace point is within 2 mm of the fingertip
  node's world position at the same recording time.
- [x] **Shape.** On the scripted take (a 30 cm circle at mid-reach and a
  figure-eight), the report gives the avatar fingertip's error against the
  IWER ground-truth path, and the drawn circle's fitted radius matches the
  avatar fingertip's own circle within 1 cm. Nothing is drawn while the
  scripted hands are still.
- [x] **Orbit.** A paused card shows the same trace from two orbit angles.
- [x] **Travel.** No segment is drawn while the hips' horizontal speed,
  averaged over 0.25 s, is above 0.3 m/s, or across a root jump (teleport,
  snap turn) between two samples. Proven on a scripted headset walk, a
  teleport and a snap turn. Leaning and crouching while drawing do not
  suppress.
- [x] **Time.** Scrubbing while paused recomputes the trace for the new
  time; the window clamps at the clip start and does not wrap across the
  loop.
- [x] **Playing.** With Traces off, nothing is drawn while playing; with it
  on, a tail of at most the last 1 s fades behind each moving hand. Resuming
  clears the paused trace.
- [x] **Control.** The Traces control shows only on cards with recorded hand
  spans, its state is per card, and it follows the control rules in the
  styleguide.
- [x] **Older and other takes.** A desktop take, a headset export with only
  inferred spans, and one with no `HOLOIM_meaning` show no traces and play
  unchanged.
- [x] **Style.** Traces use the Ink inferred style (styleguide 1.1, 4): the
  pointing highlight hue, lighter than recorded marks, never gold, never
  hollow; they taper in width and opacity toward the oldest end, with a
  minimum on-screen width that stays legible on a phone card.
- [x] **Cost.** Measured with `performance.now()` around the trace work via
  the card probe: under 5 ms once per pause or scrub, and p95 under 0.5 ms
  per frame with the tail on.
- [x] **Compatibility.** Export → upload → render stays compatible; the AR
  and VR viewers and other glTF loaders load the new export unchanged.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A headset take with no pointing writes no `HOLOIM_meaning` (today it is written only from pointing) | Composer builds hand spans separately and registers the plugin when either part has content |
| Hands switch to controllers, tracking drops (`held`), or hands are in a menu | Per-frame source recorded; only `xr-hand` counts; menu spans excluded; both segment ends must be in a span |
| One-frame source flicker floods the record with tiny spans | Minimum span length 0.25 s |
| Desktop take: IK and procedural arm swing traced | No recorded hand spans on desktop takes; desktop fixture shows nothing |
| Jitter on a still hand adds up to centimetres of path length | Stillness uses spatial extent, not path length |
| Author walks, teleports or snap-turns | Smoothed horizontal hip speed, and root-jump breaks; scripted headset walk, teleport and snap-turn takes |
| Leaning or crouching while drawing suppresses the trace | Horizontal hip speed only, over 0.25 s |
| Rig has no index tip end site | Viewer uses capture's rule (first child bone that is not canonical), falls back to index distal, then the hand bone; fallback rig is Unverified unless a headset take on such a rig runs |
| Tip tag is removed on export, so the tip is not in `HOLOIM_humanoid` | Find the tip by the child-bone rule from the resolved `indexDistal` |
| Non-bone parents (`HumanoidFacing`, a scaled Armature) shift the world path | Walk the whole chain to `clonedScene`, each node from its track or its static local matrix |
| Mixer stepping to sample updates the whole scene and costs frames | Sample with track interpolants at keyframe times, no mixer |
| Paused at t < 3 s, at the clip end, or scrubbed | Window clamps, no loop wrap, recompute on paused-time change |
| The trace counts as scene content for the cloche fit, drawn points or hit tests | Flag it as chrome (`chromeFlag`) |
| The trace is culled when orbiting, or hides the avatar | Frustum culling off (or a live bounding sphere); `depthWrite` off |
| Toggle state leaks across cards or remounts | `traces` and `hasTraces` in the per-card portal store |
| Older or third-party GLB without the signal | No recorded spans, no traces; the event plays unchanged |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review, done 2026-10-28 |
| Implementer, capture | To assign | `apps/capture/src/recording/FrameCaptureStore.ts`, `GltfExportComposer.ts`, a new hand-span builder beside them, `apps/capture/src/systems/RecordingSystem.ts` |
| Implementer, viewer | To assign | New `apps/viewer-web/src/features/meaning/HandTraces.tsx` and its sampler, the mount in `HologramCardCanvas.tsx`, `portal/portalStore.ts`, `PortalControls.tsx`, `VIEWER_CONTROL_NAMES` in `@holoim/xr-ui-core` |
| Implementer, e2e | To assign | New `apps/viewer-web/e2e/hand-traces.pipeline.spec.ts`, a scripted IWER take beside `apps/capture/scripts/lib/pointing-iwer-replay.ts` |
| Independent verifier | Different vendor from the implementer | Read-only verification; artifacts and proof video under `output/` |

`packages/meaning` needs no schema change.

## Design decision

Decided after the design review on 2026-10-28:

- **The trace is the event's own data.** The viewer samples the fingertip
  node's world position from the primary clip (`compareTakeClips`) at its
  keyframe times, by walking the chain from the tip up to `clonedScene`: each
  node from its track's interpolant if the clip has one, else its static
  local matrix. No mixer, no stored path. Capture export and upload leave
  positions untouched (no quantization or meshopt).
- **Bones.** `indexDistal` and `hips` resolve through
  `readHumanoidDeclaration` / `resolveHumanoidAnchors` and `mapNodeIndices`.
  The tip is the first child bone of `indexDistal` that is not canonical
  (capture's own rule in `HumanoidSkeleton.ts`), falling back to the distal,
  then the hand.
- **The tracked-hands signal is `recorded` motion spans**, the complement of
  the existing `inferred` spans, over each side's hand and finger bones. This
  was chosen over a take-level flag because it can express a switch to
  controllers, a dropout and a menu. Capture stores `HandPoseSource` per frame
  and side. Only `xr-hand` counts; hands-in-menu spans are cut out; spans
  under 0.25 s are dropped. The composer writes them even without pointing, so
  every headset take now carries `HOLOIM_meaning`. The record stays at v0
  (the schema already allows recorded motion spans), and no viewer reads
  `spans` today.
- **Suppression.** Stillness is spatial extent under 5 cm. Travel is
  horizontal hip speed averaged over 0.25 s above 0.3 m/s, or a root jump
  between samples.
- **Rendering.** One ribbon per hand, expanded in screen space in the vertex
  shader with a minimum pixel width, tapering in width and opacity toward the
  oldest end, in the pointing highlight's inferred colour. Flagged as chrome,
  `depthWrite` off, no frustum culling. Recomputed when the paused time
  changes. The scene is drawn at true scale (`<primitive object={clonedScene}/>`),
  so the trace needs no extra scaling.

### Decided during implementation (2026-10-29)

- **Root jumps are a rate, not a distance.** Capture's respawn (its
  teleport) moves the recorded hips about 7 cm in one frame, under any
  distance a walk could not also reach. A jump is a hip step over 3 cm
  faster than 2.5 m/s, or a hip turn over 12° between samples
  (`handTraceSampler.ts`).
- **Snap turns break on the fingertip.** A take is recorded in the rig's
  frame, so a snap turn never turns the exported hips; it moves the arms
  instead (the fingertip steps about 23 cm in one frame). A fingertip step
  over 8 cm faster than 6 m/s also breaks that hand's trace.
- **The scripted teleport is capture's respawn.** A headset that jumps more
  than 0.5 m is re-origined by capture and never moves the avatar
  (`HEAD_TRACKING_JUMP_METERS`), so the travel take respawns the character
  (`__respawnCharacter`) instead.
- **Ribbon values.** 8 mm wide in the world; the oldest end is half as
  wide; never under 3 CSS px anywhere along it (the cross-vendor review
  caught the floor applied before the taper, which drew a 1.5 px hairline
  on a phone card); opacity 0.85 at the newest end, 0.3 at the
  oldest (the tail fades to 0); double-sided, not tone mapped. The first,
  thinner values drew the circle about 1 px wide at 20 % opacity.
- **The sampler caches keyframes ahead of a pause.** While a card plays it
  samples keyframes into its cache for up to 0.5 ms a frame, so a pause
  mostly reads the cache. A cold first pause measured 4.6 to 5.0 ms; warmed,
  it is 1.6 ms at most.
- **The control.** Its accessible name, "Trace the author's hands", lives in
  the viewer's `VIEWER_CONTROL_NAMES` (`controlNames.ts`). Its glyph, a
  dashed stroke ending in a dot that turns solid when on, is added to the
  styleguide's glyph table.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Signal, v0 validity | Pipeline spec: scripted headset take → export; read `HOLOIM_meaning` | `output/hand-traces/report.json` `shapes.signal`: v0, valid, recorded spans 0–10.72 s over 16 bones per hand, listed in `extensionsUsed` only. The travel take is cut at the controller second (spans 0–9.68 s and 10.72–11.74 s per hand). Desktop take: no `HOLOIM_meaning`. Hands-in-menu take: the recorded span (0.656–1.424 s, right) does not overlap the authoring spans. Pass |
| Presence, recorded only, fidelity, shape | `hand-traces.pipeline.spec.ts`: take made by setting `IWER_DEVICE.hands.*.position` per manual-clock step (as in `generate-iwer-pose-fixture.ts`), uploaded, paused in the feed | Report `shapes`: still extents 0.4 and 2.5 cm (nothing drawn); circle 30 cm, figure-eight 15 cm, the other hand none. Every drawn segment sits in a span. Fidelity against the mixer-posed fingertip: max error 0 (188 and 189 points, limit 2 mm). Circle radius drawn = avatar = IWER = 0.15 m. Avatar fingertip vs IWER: circle mean 3.2 cm, figure-eight 0.6 cm, lean 2.9 cm (a constant offset of the rig). `shapes-1-circle.png`, `shapes-2-figure-eight.png`. Pass |
| Orbit, time, playing, control | Same spec | `shapes-3-orbit-a.png`, `shapes-4-orbit-b.png`. Window clamps at 0 (paused at 1 s, window starts at 0). At the clip end the window is 7.72–10.72 s with no wrap. Scrubbing back recomputes the same trace. Traces off while playing: mode `none`. Tail: 63 points spanning at most 1 s (`shapes-6-tail.png`); resuming clears the paused trace. The control shows only on cards with recorded spans, and its state is per card (two cards). Pass |
| Travel | Same spec on scripted headset walk, teleport and snap-turn takes | Report `travel`. Walk at about 0.8 m/s: 127 samples suppressed for travel, and the fastest drawn segment's hip speed is 0.28 m/s. Teleport (capture's respawn) and snap turn (one snap, rig yaw −30°): each breaks the trace once (`jumps` 1). No drawn step exceeds 1.6 cm, and nothing is drawn during the controller second. Lean and crouch: hip speed 0.038 m/s at most, 125 samples drawn, none suppressed. `travel-*.png`. Pass |
| Older and other takes | Same spec on a desktop take, the new export with recorded spans stripped, and one with `HOLOIM_meaning` removed | Report `olderAndOther`: all three have no control and no traces mounted, and they play. `negative-*.png`. Pass |
| Real gesturing | Same spec on a take replayed from `headset-open-fist-pinch-point-wave-reach.json` | Report `realFixture`: traces drawn at fist, point, pinch, wave and reach, with extents of 10–18 cm and no suppression. `real-*.png`. Pass |
| Style | Screenshot review against the styleguide (cross-vendor) | Codex hit its usage limit, so Muse (Meta) reviewed. It passed style, the control glyph and placement, no gold or hollow, and hue consistency with the pointing highlights. It failed phone legibility: the oldest end was 1.5 px because the minimum was applied before the taper. That is fixed, and `shapes-4-orbit-phone.png` shows a 3 px minimum along the whole ribbon. Muse's other suggestion, adding the glyph to `tokens.json`, was left out: the highlights glyph is not tokenized either. Pass after fix |
| Cost | Same spec, card probe timings | Report `shapes.cost`: pause or scrub 1.4 ms max, 0.4 ms p50 (9 pauses; the keyframe cache warms while playing, at most 0.5 ms a frame). Tail frame p95 0.2 ms. Pass |
| Compatibility | `pnpm run verify:pr` | Passed on the tree merged with `main` (2026-10-29): doctor, checks, unit, build, shards, knowledge, pipeline 27/27 (including all 4 hand-traces tests), portal 10/10, XR smoke 30/30. The last three ran on spare ports because another agent held 3199. Pass |
| Proof video | Real-time recording of pause, trace, orbit, scrub, toggle | `output/hand-traces/proof/hand-traces-proof.mp4` (H.264), watched and sent to the user. Pass |

## Physical-device limits

IWER proves the pipeline and the drawn geometry against recorded data. It
does not prove how a real Quest's hand jitter looks as a trace, how the
`xr-hand` source behaves through real dropouts, the feel on a real phone, a
rig without fingertip end sites in a headset take, or the PRD's recipient
trial. Those are Unverified until run on devices with new headset takes of
real demonstrations.
