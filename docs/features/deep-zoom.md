# Feature brief: Deep zoom into nested holograms

**Lead:** Claude Code (Opus)  
**Status:** Verifying (2026-11-13): built and checked locally; independent verifier, merge and production upload open
**Layer:** view (how a recorded event is looked at), with an authored piece
(`introspection2`) as its first user; see
`docs/product/concepts/what-a-hologram-is.md`.

Queue item: `TODOS.md`, "The way down", deep zoom (2026-11-13).

## User outcome

In "The way down II", a viewer zooms with the wheel, a pinch or the keyboard
from the man (1.8 m) into his chest, into the gas (×100 smaller), into the
liquid in a gas knot (×40 smaller again), and into the dark with the child
(×40 smaller again, about 160,000× in all). Every layer is always there at
its real nested size, always playing its own action and music. The traveller
keeps running the 60 s loop down through the layers and back up. The viewer
can stop in any layer, hear that layer's music, zoom back out, and find the
traveller wherever the loop has taken him.

The camera goes in (the user's choice, 2026-11-13): the zoom carries it
through his chest into each layer, the dome is left behind, and deep in, the
layer fills the whole card. The traveller's descent plays inside the
hologram on its own clock; the viewer's zoom is theirs, never baked in.

Any author (agent or person) can get this for a piece by declaring its
layers. A hologram without the declaration behaves exactly as today.

## Scope

**Included:**

- A glTF declaration of nested layers (below) that the viewer reads.
- A deep-zoom range in the feed's portal (desktop and phone) past today's
  inside end, for declared pieces only: each layer's aim point, camera near
  and far that follow the camera's distance, positional sound scaled and
  faded per layer, outer layers left behind on the way in.
- Return, reset and scroll-away from any depth.
- The upload reducer made layer-aware, so the served `-light.glb` keeps the
  inner layers' motion (no endpoint change; undeclared GLBs reduce
  byte-identically).
- The XR and AR players hear a declared piece at depth 0 (layer gains and
  distances applied), so its inner music does not play over the man.
- A rebuild of `introspection2` as an always-running nesting with static
  per-layer node scales, re-uploaded to production with `usdzStatus: ready`.
- Quick Look: the converter leaves out emitters inside a `HologramLayer`,
  and writes placed (positional) emitters as spatial `UsdMedia.SpatialAudio`
  at their node, so Quick Look plays the outer layer's sound from where it
  is. This applies to every hologram with placed sound.
- A stop at the inside end for the wheel (below).
- An e2e check; a pipeline check through the reducer; a proof video; lessons
  in `docs/product/concepts/agent-authored-holograms.md`.

**Excluded:** deep zoom in AR, the XR viewer and Quick Look (the user named
no surface beyond the feed). On those surfaces the piece plays its outer
layer: the man, and the traveller's comings and goings at his chest; the
inner layers are present but too small to see. No scale label (the user's
choice: depth shows in the layer itself, and Return reverses it). No change
to capture or the API's endpoints.

## Undo

None. The feature adds no capture authoring action; it is a viewing control
and an agent-built piece.

## The declaration

A layer is a glTF node named `HologramLayer` followed by anything
(`HologramLayer_gas`). GLTFLoader keeps the prefix: it only replaces
whitespace, strips `[]./:` and appends `_N` to make names unique.

- **Chain:** layers nest. Each layer's nearest `HologramLayer` ancestor is
  the layer before it (the first has none). Siblings are invalid.
- **Aim:** the node's world origin, read every frame, so a layer may move by
  translation and rotation.
- **Size:** the node's world uniform scale over the model root's. It must be
  below 1, static over the take (the viewer samples it across the clip), and
  each layer at least 2× smaller than the one before.
- **Membership:** a mesh or sound emitter belongs to its nearest
  `HologramLayer` ancestor, or to layer 0 (the hologram itself) if none.
- **Units:** anything seen deep in is built and animated in its own layer's
  units under its layer node. glTF stores keys as float32 and three.js
  interpolates into float32, so a node keyed in the man's metres moves in
  steps of about 0.1 µm, which is about 8 px at the deepest home. Something
  that travels between layers is one rig per layer, each keyed in its
  layer's units, handed over at each door with STEP scale keys 0 ↔ 1.
- **Materials:** rigid meshes with unlit (or scene-lit) materials. Skinned
  meshes, punctual lights, transmission and the recorded bubble work in
  float32 world space, which shakes or mis-lights deep in; the viewer warns
  when a layer holds one.
- An invalid declaration (siblings, non-uniform or changing scale, size ≥ 1,
  a step under 2×) is ignored with a console warning, and the hologram
  behaves as one without it.

This is pure glTF: no extension and no extras. The reducer and the USDZ
converter read node names they already carry. It replaces the
`HologramZoom` node for this piece; the viewer keeps reading `HologramZoom`
for any hologram that has it.

## Design decision

### Zoom: a depth past the inside end

The store's `zoom` (0 inside, 1 Follow) stays as it is. Declared pieces get
a second value, `depth`, in nepers (natural log units): the camera's
distance from the aim is `insideDistance × e^(−depth)`.

- Zooming in spends `zoom` down to 0, then the rest goes into `depth`;
  zooming out spends `depth` to 0 first. Pinch and keys cross the boundary
  without a stop. A wheel gesture that reaches the inside end from outside
  stops there (the user's choice), and the next wheel gesture goes on in, so
  a wheel-in from Follow does not run on into his chest.
- Past the inside end, wheel and keys move at 2× their rate (a mouse notch
  is about 0.3 nepers, so the 12-neper descent is about 40 notches, about 10
  per ×40 step). Pinch stays 1:1 under the fingers (about eleven 3× pinches
  for the whole descent).
- Layer `i` (size `s_i`) is "home" at `depth_i = −ln(s_i)`: the camera is as
  far from that layer's aim, in its own units, as it was from the man at the
  inside end. The range ends 16× past the deepest home
  (`depth_max = depth_n + ln 16`), so the viewer can lean into the core.
- The aim: between two homes the look target is the next layer's aim plus
  the offset to the outer aim, shrunk by the camera's distance
  (`e^−(depth − depth_from)`) and eased out with a smoothstep. The next aim
  holds a fixed angle in view while the camera closes in and is centred when
  its layer is home. Layer 0's aim is today's inside-end target.
- Orbit (yaw, pitch) and tilt work unchanged at every depth.
- Return retraces the zoom path to Follow in log distance (depth first,
  then zoom) over 0.45 s plus 0.12 s per neper, so it passes back through
  each layer instead of leaping. Reset and scroll-away clear `depth`.
- Hit testing: at `depth > 0` everything in view is the hologram, so a new
  wheel gesture over an empty part of a layer keeps zooming instead of
  scrolling the feed (which would reset the depth).

### Precision at 160,000×

three.js composes each object's model-view matrix in float64 on the CPU and
uploads it relative to the camera, so a rigid unlit mesh only ever puts
layer-local vertices and camera-relative transforms through float32. Every
layer is built in its own units under its static layer node, and the
declaration rules out what is computed in world space (above).

### Camera near and far

For a declared piece, once the camera is nearer than the inside distance:
`near = distance / 100` with no 1 cm floor, and `far = distance × 400`. This
is computed from the camera's actual distance each frame, so a Return glide
from depth keeps the inner layer drawn. Otherwise today's values apply.

### Outer layers left behind

The far plane does not hide the parent layer (it is only 40–100 camera
distances away), and the gas is translucent. So a layer's own meshes are not
drawn once the camera is two homes deeper (`depth > depth_{i+2}`); only the
current layer and its parent draw. They come back on the way out at the same
point.

The cloche is not drawn once the camera is inside its glass at `depth > 0`
(the camera crosses it at about depth 0.8 with a dome fitted to the man), so
the glass never shows as a sliver. The stage light stays: it changes nothing
for unlit pieces.

### Sound per layer

- Each emitter's distances (ref, max) scale by its layer's size, on top of
  the hologram's placement scale (`gltfAudio.ts` already applies the root's).
- A layer gain fades each layer's emitters by depth: full at its home,
  handing over to the next layer with equal power across the middle half of
  each step, so going in the outer music falls away as the inner rises.
- Global (unplaced) emitters get no layer gain; a layer's music is a
  positional emitter in that layer.
- The ear: in the deep range `portalEar` already puts the ear at the camera.
- The XR and AR players apply the layers at depth 0.

### The upload reducer

`reduceAnimations` (`apps/viewer-api/src/services/animation-reduce.ts`)
bounds translation error at 1 mm in world space, which is 160 m in the
dark's units. It becomes layer-aware: each bound and the world-error check
scale by the size of the node's nearest `HologramLayer` ancestor, so the
error stays under 1 mm in that layer's own units. For a GLB without layers
every size is 1 and the output is byte-identical.

### The piece (`introspection2`)

- Layers: the man (layer 0); `HologramLayer_gas` (size 0.01) on a static
  node at his chest (not on the breathing joint: the joint would make every
  inner vertex "moving" for Quick Look and turn the layer under the orbit);
  `HologramLayer_liquid` (2.5e-4) in a gas knot; `HologramLayer_dark`
  (6.25e-6) under the liquid's door.
- No morph-target zoom, no `HologramZoom` node, no skies sized for the feed's
  fit. The feed fits the man; the build checks the fit is the same with the
  inner layers removed.
- The man is alive for the whole loop (no statue phase).
- Each layer's ambient action (gas flow, the liquid's waves, the child in the
  dark) and its music run through the whole 60 s loop, seamless at the loop
  point. Events aimed at the traveller (gusts, the knock, the doors opening)
  keep their beat-sheet times; the beat sheet gets a section for the
  always-running layers.
- The traveller: one rigid rig per layer, keyed in that layer's units,
  handed over at each door by STEP scale keys, and back up through the
  calmed layers in the last beat.
- Sound: each layer's music, and a heartbeat in each layer (racing in the
  gas, the man's at his chest, the child's in the dark), as positional
  emitters in their layer. The user's direction (2026-11-13): the sound is
  background, sparse and succinct; it accompanies the imagery and never
  leads it.
- Quick Look: every channel on one 30 Hz grid. The build splits its
  estimate as the converter does (deformed and rigid moving points × frames,
  against 100 M and 500 M), and the real converter runs locally before
  upload (its 100 CPU-second cap cannot be estimated).

### Alternatives considered

- **The zoom gesture drives the 60 s descent, or a timeline scrub.** The
  user chose free deep zoom instead.
- **One `zoom` value running negative.** Simpler store, but its meaning
  would change with the card's framing (the span depends on the Follow
  distance), so a resize would move the camera in depth. A separate depth
  in nepers is framing-independent.
- **Logarithmic depth buffer.** Each card owns its WebGL context, but the
  declaration is only known after the GLB loads, after the context exists.
  Near and far that follow the distance are enough at a 40,000:1 ratio.
- **A floating origin (re-centring the scene on the aim).** Not needed with
  rigid unlit nodes and CPU-composed model-view matrices; it would touch
  every world-space consumer (cloche, clip uniforms, ground field).
- **One traveller rig keyed across layers.** Float32 keys shake him by about
  8 px deep in (design review).

## Acceptance criteria

- [x] With the declaration, zooming in from Follow reaches each layer's home
  in turn (camera distance to that layer's aim within 5% of
  `insideDistance × s_i`, the aim centred within 2% of the view), with the
  layer's own geometry drawn on screen (pixels of its marker colour), and
  its own animation playing there.
- [x] Zooming back out from the deepest layer returns to Follow; Return from
  any depth retraces to Follow through each layer; scrolling the card away
  and back resets depth; a new wheel gesture at depth over an empty part of
  the frame keeps zooming and does not scroll the feed.
- [x] Two homes in, the outermost layer is not drawn; the cloche is not
  drawn once the camera is inside its glass.
- [x] Each layer's emitters are at full gain at its home and silent at the
  next layer's home; their distances scale with the layer.
- [x] A hologram without the declaration: the zoom clamps at today's inside
  end (`depth` stays 0); near and far, the dome and the sound are as today.
  Existing portal and spatial-audio checks pass unchanged.
- [x] The reducer keeps the deepest layer's motion in the served GLB, and
  reduces an undeclared GLB byte-identically.
- [x] The rebuilt piece: every layer animates at every moment of the loop;
  the traveller is in the layer the beat sheet puts him in, at every moment;
  the feed's Follow framing fits the man; the local converter produces the
  USDZ within its budgets.
- [ ] Production: the piece re-uploaded with the agent token, `usdzStatus`
  `ready`.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Float32 jitter deep in the nesting | Rigid unlit nodes in layer units, one rig per layer; warnings for skinned meshes, lights, transmission, bubble in a layer |
| The reducer flattens inner-layer motion | Layer-aware bounds; pipeline check on the served GLB |
| Near plane cuts the layer being looked at, or far drops its walls | Near and far from the camera's distance; e2e pixel check at every home |
| Outer layers (translucent gas) show around an inner one | Layer meshes hidden two homes in; e2e reads visibility |
| A hologram without the declaration changes | `depth` only exists with a valid declaration; e2e on an undeclared twin plus the existing portal and spatial-audio specs; reducer byte-identity check |
| A new wheel gesture at depth scrolls the feed and resets depth | Hit test true at depth; e2e wheels over empty frame after a pause |
| The camera jumps when crossing `zoom` 0 into `depth` | One log distance across the boundary; e2e checks distance is continuous |
| Return from depth leaps out | Retraced log-distance glide; e2e samples it |
| Resizing the card while deep moves the camera in depth | `depth` is in nepers, independent of framing |
| The dome shows as a sliver | Hidden once the camera is inside its glass at depth |
| Outer music drowns the inner layer | Layer gain crossfade; gains read through the audio probe |
| Inner music plays over the man in XR and AR | Players apply the layers at depth 0 |
| Sibling layers make the aim jump between unrelated places | Chain rule; invalid declaration ignored |
| The feed's dome fit grows from inner layers | No sky sized for the fit; build compares the fit without inner layers |
| Quick Look budget blown by always-moving layers | Static layer anchor; one 30 Hz grid; split estimate; local converter run |
| The animated `HologramZoom` path regresses for other pieces | Left as is |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, integration, handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review, done 2026-11-13 |
| Implementer | Claude Code (Opus) | `apps/viewer-web/src/features/portal/` (store, triggers, new `deepZoom.ts`), `features/feed/HologramCardCanvas.tsx`, `features/hologram/gltfAudio.ts`, `features/xr/hologramPlayback.ts`, `apps/viewer-api/src/services/animation-reduce.ts`, `apps/viewer-web/e2e/` (new spec and fixture), `apps/capture/scripts/showcase/introspection2*` |
| Implementer (Quick Look) | Claude Code (Opus) | `apps/viewer-api/tools/glb_to_usdz.py`, `inspect_usdz.py` |
| Independent verifier | `verifier` subagent (Opus, fresh context) and `/code-review high`; Codex had no quota | Read-only verification against this brief |

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Reaches each layer; out; Return; reset; wheel at depth; undeclared unchanged; sound per layer | New `deep-zoom.spec.ts` beside `portal.spec.ts` in `test:e2e:portal` (run by `verify:pr` as `test:portal`), on a four-layer rigid fixture GLB and an undeclared twin | `output/test-results/deep-zoom-report.json`: homes at depth 4.77, 8.34, 11.91 with each marker's colour at the aim; Return 89 samples 14.7 → 0 through every home; undeclared camera at the inside distance (2026-11-13) |
| Reducer | Reducer unit test for byte-identity; the pipeline check uploads the fixture and reads the deepest layer's motion in the served GLB | `hologram-budgets.test.ts`, "judges motion inside a nested layer in the layer's own units": declared keeps the full-size keys within 1 mm of the layer; undeclared flattens as before. Byte identity by construction: with no layer node every unit is 1, an exact multiplier, and the existing reducer tests pass unchanged |
| Existing behaviour | `portal.spec.ts`, `portal.pipeline.spec.ts`, `spatial-audio.spec.ts`, viewer and API unit tests | `test:e2e:portal` 16/16, `spatial-audio.spec.ts`, viewer vitest 41/41 (2026-11-13) |
| The piece | `node scripts/showcase/build.mjs introspection2` (fit, layers, split Quick Look estimate) and the local converter | Build: 169 channels on the 30 Hz grid, fit unchanged without the inner layers, Quick Look 22.3 M deformed and 44.8 M rigid; converter 15 s CPU, 15.2 MB USDZ, inspector passed; `check_usdz_tools.sh` passed |
| Whole | `pnpm run verify:pr` | `verify:pr` passed in 1634 s on the viewer commit (2026-11-13) |
| Proof | Real-time H.264 recording in the local feed, zooming into each layer and back out to find the traveller | Recorded in the local feed on the rebuilt piece: one gesture stops at the inside end, then in through his chest to the gas, liquid and dark homes, all playing, and Return out (under `output/deep-zoom-proof/`) |

## Physical-device limits

Wheel and keys are proven in headless Chromium; pinch through the existing
raw-touch path. Pinch feel on a real phone and audio on a real device are not
proven by emulation.

## The user's answers (2026-11-13)

1. Brief approved.
2. Quick Look: "Outer only + try spatial": the converter drops emitters
   inside a `HologramLayer` and writes placed sounds as spatial. On the
   question, the user added: "the audio should also be way more
   background-y, more succinct. it's just accompanying the imagery".
   Whether AR Quick Look places spatial sound is unproven until it is heard
   on an iPhone.
3. No scale label.
4. The wheel stops at the inside end; the next gesture goes on in.
