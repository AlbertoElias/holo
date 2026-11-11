# Feature brief: Positional audio in holograms

**Lead:** Claude (Opus), session `feature/positional-audio`
**Status:** Delivered (merged to `main` 2026-11-11); the user heard the
difference in the live feed; a physical headset is unverified, see
"Physical-device limits"
**Layer:** Event (a sound has a place in the recorded event, like a voice or
an object). Where the ear sits while watching is the view's reading of it.

**Branch:** `feature/positional-audio`, merged to `main` at `b180e6aefc40`
on 2026-11-11 together with `feature/showcase-holograms`, which it was
stacked on.

## User outcome

A hologram can carry several sounds, each coming from a place in its scene:
the drumming of rain on a child's umbrella comes from the umbrella and moves
with it as the child hops, the lamp hums from the lamp, while the rain itself
stays all around. Watching in the feed portal, orbiting the view swings each
sound from one side to the other and zooming in brings it closer and louder;
in the headset, turning your head or walking around the hologram does the
same. A hologram with one sound for the whole take (every recorded take
today, and every file already uploaded) plays exactly as it does now. New
recorded avatar takes place the author's voice on their head, so it comes
from where they spoke.

This unblocks showcase pieces whose point is a sound with a place (a flock
rushing past your head, four singers you can walk between).

## Scope

**Included:**

1. **File format, additive only.** `KHR_audio` (the draft extension the repo
   already writes) with several `audio` entries and `sources`, `positional`
   emitters referenced from nodes (`nodes[i].extensions.KHR_audio.emitter`)
   with the draft's distance settings (`distanceModel`, `refDistance`,
   `maxDistance`, `rolloffFactor`), alongside optional `global` emitters
   referenced from the scene. Source `gain` and emitter `gain` are honoured.
2. **Viewer** (`apps/viewer-web`), one audio module shared by both players:
   - one `PannerNode` per positional emitter instance (per referencing node),
     set every frame from that node's world position, so an animated node
     carries its sound;
   - the ear rides the zoom on flat screens and is the head in XR
     (decision 1);
   - HRTF panning on both (decision 3);
   - mute, pause and the loop-restart sync work for every source; every
     source starts from the same clip clock and restarts with it at a wrap;
   - distance settings scale with the hologram's world scale, so a shrunk
     hologram sounds like the same scene seen from proportionally further
     away (a hologram at recorded scale is unchanged).
3. **Writers.**
   - The showcase `Glb` gains `sound(bytes, { node, name, gain, mimeType,
     distanceModel, refDistance, maxDistance, rolloffFactor })`: with `node`,
     a positional emitter on that node; without, a global one listed by the
     scene. `audio()` now calls it and writes byte-identical GLBs for every
     scene that uses it.
   - Capture (`GLTFAudioPlugin`) writes a new avatar take's voice as one
     positional emitter, `voice`, on the avatar's head node (decision 2).
     A take without a tagged head (a camera take) keeps one global emitter,
     as every take does today.
4. **Test piece.** `rain` ("The shape the rain leaves") is split into its
   layers: the rain bed global; the umbrella's patter positional on the
   `umbrella` node (it bobs and hops); the landing splash positional on a new
   `SplashSound` node at the child's feet (a child of `ChildFrame`, so it
   moves with the child); the lamp's hum positional on a new `LampHum` node
   at the lamp head (static). Three positional sources, one global, each
   point source at `refDistance` 1.5 m. Chosen over `murmuration` because its
   sound already is separate layers with separate places, one of them
   animated, and the scene is small enough (1.5 m) that every source sits
   inside the framed cloche.
5. **Quick Look stays whole.** The USDZ converter converts positional
   emitters too, as non-spatial `UsdMedia.SpatialAudio` like the global one,
   so a Quick Look viewer hears the whole mix, unplaced (before, it read the
   scene's emitters only and would have dropped a head-placed voice).

**Excluded (follow-ups):**

- Placed sound in AR Quick Look (USDZ). Every source plays there, unplaced;
  `UsdMedia.SpatialAudio` with `auralMode = "spatial"` under the node's prim
  would place them; separate change. (`rain` does not convert at all: the
  converter stops at "Animation exceeds channel limit", which predates this
  feature and is why no showcase piece has Quick Look.)
- Emitter cones (`coneInnerAngle`, `coneOuterAngle`, `coneOuterGain`): every
  positional emitter is omnidirectional; the writer does not write cones and
  the viewer ignores them.
- External `uri` audio (only embedded `bufferView` audio, as today).
- Retrofitting the other nine showcase pieces, and uploading anything to the
  live feed (needs the user's go-ahead).
- Moving already-recorded takes' voice: they stay global and play as today.
- Listening by ear and a physical headset (see "Physical-device limits").

## Product decisions (put to the user)

The user's answers, 2026-11-10 (relayed by the lead session, quoted):

1. "Ear rides the zoom (Recommended)" (option B).
2. "From the avatar's head": "New takes write the voice as a sound placed on
   the avatar's head, so it comes from the author's mouth. Needs a capture
   change in this feature." Existing takes with a global voice play as today.
3. "HRTF everywhere": "3D cues on flat screens too. Best on headphones; can
   colour the sound on speakers."

The options as put:

1. **Where the ear sits on a flat screen.** The Follow camera stands several
   metres back (6.6 m for `rain`'s card view), so a literal ear at the camera
   makes every placed sound about 16 dB quieter than the bed and nearly
   centred (sources 1 m apart are about 8 degrees apart).
   - A. *Ear at the camera.* Literal; quiet and narrow at Follow, wide and
     loud only when zoomed fully in.
   - B. *The ear rides the zoom* (recommended). The ear looks the camera's
     way from the point the camera looks at, at a distance that maps the
     camera's zoom range onto a shorter hearing range: fully zoomed in it is
     exactly the camera (eye level, 1.6 m from the author); at Follow it is
     `HEAR_OUTSIDE` = 2.5 m from the target instead of 6.6 m. Orbit swings
     sounds left and right; zoom changes level all the way through.
     (`hear(d) = inside * (d / inside) ^ k`, `k = ln(2.5 / inside) / ln(outside / inside)`,
     so it is one smooth function of the camera's distance, including Follow
     and the eased return to it.)
   - C. *Ear in the middle of the cloche,* facing the camera's way. Widest
     panning; zoom changes nothing.
2. **Recorded takes' voice.** Keep it global (recommended for this feature:
   no capture change, and on a flat screen a voice at the head would be
   quieter than today at Follow) or write new takes' voice as positional on
   the avatar's `Head` node (old takes stay global).
3. **Panning model.** HRTF everywhere; equal-power everywhere; or HRTF in
   the headset and equal-power on flat screens (recommended: HRTF needs
   headphones or a headset's near-ear speakers to place a sound, and colours
   it on laptop and phone speakers, where equal-power gives clean
   left/right).

## Acceptance criteria

- [x] A hologram with at least two positional sources (one on an animated
      node) and one global plays in the local viewer feed; under real pointer
      drag-orbit the left/right gain difference of a static off-centre source
      changes sign, and under real wheel zoom-in its level rises; numbers in
      the e2e report.
- [x] Each frame, the animated source's panner is sent its node's position
      as the ear sees it (within 1 cm of the test's own transform of the
      node's world position into the ear's coordinates), and the panner's own
      value, which ramps to it over the frame, stays within about a frame's
      motion of it (median under 2.5 frame steps plus 1 cm). Amended
      2026-11-10 after independent verification: the panner itself cannot be
      within 1 cm of a moving node, since it ramps by design.
- [x] Mute zeroes every voice, pause stops every source, resume starts every
      source at the motion's time, and a motion wrap restarts every source.
- [x] In the XR viewer (IWER), turning the head swaps the static source's
      left/right gains, and the ear follows the head pose.
- [x] A new avatar take recorded in capture carries its voice as one
      positional emitter on the head node named by `HOLOIM_humanoid`; a
      camera take keeps one global emitter; both convert for Quick Look with
      their audio.
- [x] A file with one global emitter builds the same audio graph as today
      (one source into one gain into the destination), and a legacy file with
      `audio` and `sources` but no emitters still plays its first clip; the
      existing camera-take pipeline, redesign and XR viewer checks pass.
- [x] `rain` builds with three positional sources and one global, under the
      25 MB cap, and plays in the local feed with the same measured changes.
- [x] The other showcase scenes build byte-identical GLBs to before.
- [x] `pnpm run verify:agent` passes; proof video under `output/`.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A single-global file's graph or timing changes (compatibility break) | Unity-gain voices connect source → voice gain → destination, the voice gain carrying mute, exactly as today; camera-take pipeline check (one voice, gain 1 unmuted, restart per wrap) and redesign check |
| Legacy file with `audio`/`sources` and no emitters (the redesign fixture) | Explicit fallback: no emitter referenced anywhere → first source (or first clip) as one global voice; redesign check |
| Emitter referenced by nothing | Not played (the draft's rule); covered by the decoder's reference walk, documented |
| Positional emitter's node not found in the clone | Heard unplaced with a warning, never silently lost |
| Out-of-range indices in `KHR_audio` | Decoder bounds-checks every reference and skips the bad one with a warning |
| One of several clips fails to decode | That source is skipped; the rest play (today one failure silences all) |
| Animated node read before its world matrix is current | Node world matrix updated after the mixer each frame; e2e compares panner and node positions while moving |
| The ear is in the wrong place, or several cards fight over one listener | The context listener never moves; each playing hologram sends its panners positions in its own ear's coordinates. e2e reads the ear against the camera (feed) and head (XR), and checks each panner holds its node as that ear sees it |
| A placed sound bursts at the origin before its first placement | Each emitter's input gain stays 0 until its panner has been placed once |
| Panner jumps each frame (zipper noise) | Each frame ramps linearly over the frame's time (5 to 100 ms); a suspended context jumps instead, since ramps do not advance while it is suspended |
| Many emitters (HRTF cost) | The first 16 panners per hologram pan HRTF, further ones equal-power, at most 64; beyond that they are not played, with a warning |
| Resized hologram sounds wrong for its size | Distances scale with the hologram root's world scale (largest axis) |
| Sound started while the feed is muted and the context suspended stands still while the motion runs, so it lags after unmuting | Unmuting restarts every source where the motion is, as each mute change did before; the camera-take pipeline's voice-sync check caught this (1.27 s behind) before the fix |
| Sources of different lengths report the wrong clock | The lead voice is the longest looping one (else the first); its offset is the one the player syncs to |
| A head-placed voice on an old viewer build or converter | Main's viewer plays `audio[0]` whatever the emitter says, so it plays as today; the converter that understands node emitters ships in the same deploy as the capture change |
| A head-placed voice is quieter than today at Follow | `refDistance` 2 m: at Follow (ear 2.5 m from the target) it is about 2 dB under today's level, at today's level within 2 m, and falls off beyond |
| Sources of different lengths drift apart | All start from the clip clock and restart at each wrap; each loops by its own buffer, as today |
| Quick Look plays a source louder than the viewer | Its gain is the source's gain times the emitter's, as in the viewer; the inspector expects the product (found by independent verification: the converter wrote the emitter's gain alone) |
| Upload or Quick Look conversion breaks on node emitters | Converter converts them non-spatial and the inspector expects them; run on the e2e fixture and on a real head-voice take (`capture-to-viewer` pipeline) |
| File size | `rain` grows from 6.91 MB to 9.22 MB, under the 25 MB cap |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (Opus) | Brief, integration, viewer audio module and both players, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer (writer, test piece) | Subagent (Sonnet) | `apps/capture/scripts/showcase/lib/glb.mjs`, `apps/capture/scripts/showcase/rain.mjs` |
| Implementer (viewer, e2e) | Lead | `apps/viewer-web/src/features/hologram/gltfAudio.ts`, `useGltfAudio.ts`, new `portalEar.ts`, `features/xr/hologramPlayback.ts`, `viewerWorld.ts` probe, `features/feed/HologramCardCanvas.tsx`, new `e2e/spatial-audio.spec.ts` and `spatial-audio-fixture.ts`, `e2e/xr-viewer.spec.ts`, `e2e/pipeline-takes.ts`, `e2e/camera-take.pipeline.spec.ts` |
| Implementer (capture voice, Quick Look) | Lead | `apps/capture/src/recording/GLTFAudioPlugin.ts`, `apps/viewer-api/tools/glb_to_usdz.py`, `inspect_usdz.py` |
| Independent verifier | Codex (`-p standard`), a different vendor | Read-only verification; test artifacts only |

## Design decision

Reviewed by the `design-reviewer` subagent (Opus) before implementation; its
findings are folded in below.

**Reading the file** (`gltfAudio.ts`, `decodeGltfAudio`). Every referenced
clip is decoded once; a failed clip skips its sources and the rest play.
Rules, chosen so every file uploaded today plays as it does now:

- a global emitter plays whether or not the scene lists it;
- a file with no emitters plays `sources[0]` (or `audio[0]`) as one global
  voice (the redesign fixture's shape);
- a positional emitter no node references is not played (the draft's rule);
- `autoPlay` is ignored: sound follows the hologram's clock, as today;
- `loop` defaults to true, against the draft's false, because every take
  today loops its voice with the motion.

**The graph** (`ScheduledGltfAudio`, used by the feed card and the XR
player). Per voice, `AudioBufferSourceNode` → `GainNode` (source gain ×
emitter gain; mute sets it to 0). A global voice connects to the
destination, so a single global take builds exactly today's graph. A
positional emitter has an input gain (0 until first placed) feeding one
`PannerNode` per node that references it, found in the hologram's clone by
`userData.gltfExtensions.KHR_audio.emitter` (three's GLTFLoader keeps unknown
node extensions there and clones copy them). An emitter whose node is not in
the clone is heard unplaced, with a warning. The lead voice, whose offset
the players sync to, is the longest looping voice, else the first.

**The ear.** The context's listener never moves. Each frame the player
passes an ear pose, and each panner is sent its node's world position in
that ear's coordinates (the inverse of the ear's basis), so cards and
holograms never contend for one listener. Distances (`refDistance`,
`maxDistance`) are multiplied by the root's world scale.

- Feed (`portalEar.ts`): the ear looks the camera's way from the orbit
  target at `hear(d)`; fully zoomed in it is the camera, at Follow 2.5 m
  from the target (4.2 m in front of the camera on the fixture).
- XR (`hologramPlayback.ts`): `player.head` while presenting (this frame's
  viewer pose), else the camera.

**Capture's voice.** `GLTFAudioPlugin` notes the node tagged as the
humanoid `head` while the exporter writes nodes, then writes emitter 0 as
`{ name: "voice", type: "positional", positional: { distanceModel:
"inverse", refDistance: 2, maxDistance: 10000, rolloffFactor: 1 } }` on that
node, with no scene emitter list. Without a head it writes today's global
emitter and scene list. This stays inside the export contract: `KHR_audio`
is unchanged as an extension, the API is unchanged, older viewers play
`audio[0]` whatever its emitter, and the converter that reads node emitters
ships with it.

Alternatives considered: moving the context listener per frame (one listener
for every card; the ear-space panners avoid that and Firefox's missing
`positionX`); three's `AudioListener`/`PositionalAudio` as children of the
nodes (they follow world matrices for free, but cannot seek, run on three's
own context, and add objects to the clone that bounds and framing walk);
IWSDK's `AudioSystem` (cannot seek; already unregistered for that reason).

## Test plan and evidence

Verification cannot listen, so it measures. A test-hook probe taps each
positional emitter before its panner (mono) and after it (left and right
analysers) and reports the panner's gain per ear in dB over a short window
(post-panner RMS over pre-panner RMS, which does not depend on what the clip
is playing at that moment).

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Left/right and distance change under orbit and zoom | `e2e/spatial-audio.spec.ts` (`test:e2e:mocked:shard2`): mocked feed with a generated fixture (a still bell and an orbiting sphere, both placed, and a global tone); unmute; real mouse drag and wheel; reads the probe | Pass, HRTF. Follow: bell left 4.25 dB louder in the left ear (azimuth -23 degrees, 2.66 m). Orbited 178 degrees: 3.98 dB louder in the right. Zoomed fully in (ear at the camera, 2.12 m): +3.01 dB measured against +2.81 dB predicted by the distance model. `output/test-results/spatial-audio-report.json` |
| Animated node carries its sound | Same spec, over 60 frames: what the panner was sent against the node put into the ear's coordinates by the test, and the panner's own value against what it was sent; XR case the same against the head | Pass: sent against the test's transform 1e-15 m (feed) and under 1 cm (XR); the panner's own value trails by about a frame (median 8.5 cm at 7.7 cm a frame on a loaded machine) |
| Every source in step | Same spec: each voice's place in its buffer against the motion's time after unmute, after resume, and just after a wrap; the fixture's global tone is 5 s against an 8 s clip, so it is in step after the wrap only if the wrap restarts it | Pass: every source within 16 ms of the motion after unmute, 32 ms after resume and 92 ms just after a wrap, the 5 s tone included |
| Mute, pause, resume, wrap | Same spec | Pass |
| XR head turn | `e2e/xr-viewer.spec.ts` "VR spatial audio:" (`test:e2e:mocked:shard3`) with IWER head poses | Pass. Ear at the head (under 1 cm, under 1 degree); bell 7.1 dB louder in the right ear facing one way and in the left facing the other; stepping 1.61 m to 0.85 m made it 3.84 dB louder against 4.12 dB predicted; orbiter panner on its node (gap 0) |
| Capture voice on the head, camera take global | `test:e2e:pipeline:shard5` (`capture-to-viewer`: a real walk take, uploaded, converted for Quick Look, inspected) and `test:e2e:pipeline:shard3` (camera take) | Pass: the walk take's one emitter is positional on the head node `HOLOIM_humanoid` names, and its USDZ passes inspection with its audio; the camera take's stays global, loops and stays with the motion across wraps |
| Single-global and legacy unchanged | `test:e2e:pipeline:shard3` (camera take), `test:e2e:mocked:shard2` (redesign and the feed spatial spec), `test:e2e:mocked:shard3` and `test:e2e:xr-viewer-vr` (XR viewer) | Pass: camera take 6/6 and redesign shard 10/10. Every XR viewer test passed on the final code, but not all in one run: on a machine at load average 21 to 28 (other agents' browsers), two full runs each lost a different one or two tests to a 20 s load wait or a click the card's own controls intercepted, and those tests passed when rerun alone |
| `rain` retrofit | `showcase:build rain`; the built GLB in the viewer feed (API mocked to serve it), real slow drags and wheel, measured by the probe; scratch spec under `output/proof/` | Pass. Follow (ear 2.5 m from the target, camera 10.7 m): umbrella patter -7.45/-10.07 dB (16 degrees left); orbited 186 degrees: -10.10/-7.16 (16 degrees right); zoomed fully in (camera 1.6 m): 2.61 dB louder against 2.37 predicted. Lamp hum centred, 2.95 dB louder against 2.93. The splash sounds only on landings and was silent at the reading moments. `output/test-results/rain-spatial-report.json` |
| Quick Look converter | `glb_to_usdz.py` and `inspect_usdz.py` on the e2e fixture, and on a copy whose bell source has gain 0.25 | Pass: three audio files, the two placed ones non-spatial; the bell's prim gain is 0.25 (source gain times emitter gain, as the viewer plays it) |
| Other scenes unchanged | Build every scene before and after, compare bytes | Pass: identical |
| Repo checks | `pnpm run verify:agent`, `pnpm run check:e2e-shards` | Pass (docs links; lint, typecheck and unit tests of api, capture and web); every e2e test in exactly one shard |

## Independent verification

Codex (`-p standard`), read-only against this brief and the tree,
2026-11-10. Its three findings, each fixed and re-checked:

1. The animated-source check compared two positions both read from the
   node, and the criterion claimed the panner itself within 1 cm, which a
   ramped panner cannot be. Now the test puts the node into the ear's
   coordinates itself, and the criterion states the one-frame trail.
2. Nothing checked that several sources stay in time after resume or across
   a wrap, and every fixture clip was as long as the motion. Now the global
   tone is 5 s against an 8 s clip and each voice's place is checked against
   the motion after unmute, after resume and after a wrap.
3. Quick Look wrote the emitter's gain alone, so a quiet source played
   louder there than in the viewer. Now it is the source's gain times the
   emitter's, and the inspector expects that.

Separately, the camera-take pipeline caught a regression from this change
before review: an unmuted voice lagged the motion by 1.27 s (see the
failure cases). Fixed; the pipeline passes.

The proof video (real time, the `rain` piece orbited and zoomed in the feed
with the probe's per-ear levels drawn beside it) is under `output/proof/`,
not committed.

## Physical-device limits

On 2026-11-11 the user listened to the live `rain` card in the feed and
reported "I could tell the difference", on headphones. Every other claim
here is a measured gain, not a heard one: whether each placement is
convincing, how HRTF sounds on laptop and phone speakers, the `rain` balance (the layers sum to the old mix, but the point
sources now fall off with distance) and the voice's 2 m reference distance
are unverified by ear. The XR
evidence is IWER emulation; a physical Quest (its browser's HRTF, its
speakers) is unverified.

The brief stays open on two checks: someone listens on speakers (headphones
were heard 2026-11-11), and tries the XR viewer on a Quest. Then it closes per step 6
of [`../FEATURE_WORKFLOW.md`](../FEATURE_WORKFLOW.md).

The retrofitted `rain` piece is on the live feed, uploaded 2026-11-11 at the
user's go-ahead as a new card, `cmwc1glil0001oeiqy1n2s45h`. It is built on
`main` (`f64690f4c033`), 9,219,760 bytes, with one global emitter (the rain)
and three positional ones (umbrella, splash, lamp), and the stored file is
byte-identical to that build. In the live viewer it renders with no page
errors and builds three HRTF panners (`refDistance` 1.5). Its four 12 s
sources start, and the panners move under a quarter-turn drag and come
closer under zoom. The earlier single-mix card, `cmwamqg2a0009oeir4p2qzv7j`,
is still on the feed. Listening and a headset are unverified there too.
