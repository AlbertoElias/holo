# Agent-Authored Holograms

**Layers:** Event (a synthetic performance), Meaning (added, with exact
referents), View (unchanged: viewers watch it like any hologram).

**Source idea:** IDEA-076.
**Provenance:** User request, 2026-10-22: explore how agents can create
holograms from a prompt. Exploration only; no PRD or architecture is approved.

## The idea

A person, or another program, gives an agent a prompt such as "explain how to
reset this valve, at the valve" or "walk the new hire through the dashboard".
The agent returns a published hologram: a synthetic presenter with a voice,
placed in a scene, moving, pointing at and walking toward the things it names.
The agent is the author; the output is a normal hologram that plays in the
portal and the headset like a recorded one.

This is a different route to the same medium, not a video generator. The test
is whether the result is still an event with a body, a place, and referents.

## Why agents are good authors of the meaning layer

A human performance leaves pointing to be inferred from a finger or gaze ray
(IDEA-032). An agent that composes the scene already knows what "this" refers
to, so every reference is exact, with no false highlights. Exact referents are
what Follow (IDEA-041), spatial subtitles (IDEA-014), and the object-indexed
timeline (IDEA-044) need. The harder part for an agent is the Event layer:
movement and voice that look and sound like a person meaning it.

## Shape of the flow

1. **Prompt.** Intent, audience, and optional inputs: a model or scene (the
   IDEA-059 supplied object), a script, a place, a creator profile.
2. **Plan.** The agent writes a beat sheet: who stands where, what they point
   at, when. The prompter can read and correct it before anything renders.
3. **Compose.** A performer is driven through the plan: a stock or the
   prompter's own avatar, synthesized voice, gestures and pointing resolved
   against known objects, walking between viewpoints.
4. **Publish.** Through the same upload path as a captured hologram, so it
   shows in the feed and the portal with no special case.
5. **Revise.** "Slower", "point at the left valve first", "shorter" produce a
   new version, not a re-record (relates to IDEA-019 and IDEA-022).

## Interface

The hologram compositor is the product surface; prompting is one way in. An
agent-callable tool (a CLI command or MCP tool) that accepts a plan and
returns a published hologram lets any agent author, including coding agents
documenting their own work and agents in other products (IDEA-067). A person
typing a prompt in the app uses the same tool.

## Tensions

- **Authenticity.** A viewer must always see that nobody performed this.
  Provenance (IDEA-024) is mandatory from the first version: every body
  channel is marked synthesized, and the presenter is never shown as a real
  person's capture. Prompting as a real, named creator needs explicit
  consent and is out of scope until identity (IDEA-052) exists.
- **Uncanny motion.** Synthesized gestures that miss the words are worse than
  a plain avatar. A restrained performer (fewer, clearer gestures; pointing
  and walking only) may beat lifelike (IDEA-063) at first.
- **Accuracy.** An agent can confidently point at the wrong thing. The plan
  step and the preview are the review gates.
- **Hologram or slideshow.** If nothing in it depends on a place, a body, or
  a moment, it is a video and should not be built this way.

## Passes the hologram test?

1. Tied to the event: the beats are tied to a performer, objects, and places.
2. Read from the performance: references are exact by construction, and
   marked as synthesized rather than inferred.
3. Expresses intent, not a view: the plan says what matters and where; the
   viewer's device chooses the view.
4. Works on a flat phone: it is a normal hologram, so the portal applies.
5. Loses meaning as a video: only if the walkable, point-resolved scene is
   what carries the explanation. That is the first thing to test.

## Open questions

- Which prompt produces something a viewer prefers to a short video or a
  checklist? Start with one narrow case, such as a place-bound how-to.
- Is a synthetic presenter needed at all, or are voice, pointing marks, and
  moving viewpoints in the scene enough?
- Should the agent output a plan the author performs over (a script that
  guides a human recording, relating to IDEA-020) instead of a finished
  performance?
- What is the smallest plan format an agent can reliably write and a person
  can edit?

## First authored pieces (2026-11-09)

Four showcase holograms now exist as scene scripts in
`apps/capture/scripts/showcase/`. An agent wrote each scene by hand; this is
not the prompt, plan, compose flow above, and nobody speaks in them. They
were chosen to fail test 5 as hard as possible: each loses its point as a
video.

| Piece | Feeling | What a video would lose |
| --- | --- | --- |
| Walk beside light | Awe, loneliness | The Earth and Moon at 1 : 100,000,000 are a true 3.84 m apart, and light crosses at its real speed, 3 m/s at that scale. A frame shrinks the gap; here the gap is the room. |
| Two sides of a door | Ache | One person on each side of a closed door. Each side shows one; the viewer's own step finds the other. |
| Murmuration | Wonder | 480 starlings at true size. Outside it is one shape; at the standing spot it passes around your head. |
| Blue hour | Coziness | A miniature house at dusk. Each side hides something: a reader, a cat, a sleeper, lit roots. |

Build one with `pnpm --filter @holoim/capture run showcase:build <scene>`
(`light`, `door`, `murmuration`, `blue-hour`, and the later sets' scenes
below); the GLB and a contact sheet
land in the ignored `output/showcase/`. `showcase:upload --api <origin>
<scene>` sends it through the normal upload route.

What building them showed:

- **Provenance has nowhere to show.** Each file says
  `asset.extras.holoim.authored = "synthetic"` and uploads as "Claude
  (agent-authored)", but the byline is the only place a viewer sees it. The
  authenticity rule above needs a visible mark (IDEA-024).
- **The portal cannot lean in.** Its closest view is 1.6 m from the anchor,
  made for a life-size author. A tabletop miniature cannot be inspected on a
  flat screen, so Blue hour is shown at 1:8 instead of its modelled 1:12.
- **True scale can read as empty on a card.** A file with no avatar is framed
  on its whole bounds, so the 12.7 cm Earth in a 3.84 m scene is a few
  pixels until the viewer zooms. The piece is made for a headset or AR.
- **Restraint held up.** The door's two figures are jointed mannequins of
  light with no faces, and the scene still reads; the open question about
  needing a lifelike presenter leans toward "not at first".

## Second set (2026-11-10)

Six more, pushed further from anything a camera could have recorded. Each
is built around one thing only the viewer's own position can do.

| Piece | Scene | Feeling | What the viewer's position does |
| --- | --- | --- | --- |
| From where you stand | `words` | A turn from loneliness to warmth | One sculpture of 895 bricks reads ALONE from the first view and LOVED a quarter turn to the right. |
| Walk around the year | `seasons` | Time passing through one place | One apple tree in all four seasons at once, a quarter each. Walking round it is walking through the year; a red scarf carries the story from the autumn branch to the snowman to the spring melt. |
| Three hearts | `hearts` | Awe, tenderness | A blue whale's heart (1.5 m), a person's and a hummingbird's at true size, beating at 4, 64 and 1,200 a minute. The whale's beat comes twice in the 30 s loop; the waiting is the point. |
| The shape the rain leaves | `rain` | Presence made of absence | Rain on an adult and a child with a red umbrella, neither of them drawn. Water stopping, clinging and running off shows them; from above, the dry ground does. |
| The sea in the bathtub | `bath` | Delight | A true-size clawfoot tub holding a storm: a paper boat, a kraken with the plug, a lighthouse tap, a thundercloud under the shower head. |
| Who holds the strings | `strings` | Vertigo | A puppet theatre from the front. Behind it the puppeteer; above the puppeteer, strings to a giant hand. One gesture passes down four levels, and at 9 s each one looks up at whoever holds it. |

What this set added to the findings above:

- **A piece that depends on the viewpoint must be built for the feed's
  exact first view.** The feed opens at yaw 18°, pitch 16°. The word
  sculpture is turned 18° and each brick is raised by `(u − w) · cell ·
  tan 16°`, so rows at different depths land on the same screen row from
  that tilt. Built for a level view, the letters broke.
- **Nothing can hide underneath.** The portal's pitch stops at −8°, so every
  reveal in this set is behind, above, inside or on the far side.
- **Compact and dense reads on a card.** All six stay within about 3.5 m and
  are filled; none has the empty-frame problem of Walk beside light.
- **An invisible subject needs help at card size.** Rain stopping in mid-air
  was not enough to show two people in a 300 px view; droplets clinging to
  the unseen bodies were added, which is closer to drawing them than the
  idea first intended.
- **The sound is one track for the whole piece.** It cannot follow the
  viewer, so Walk around the year plays one phrase per season in turn
  instead of the season being faced.

## Third set (2026-11-10)

Six more. Three are tricks that only work from one place: they are built
for the feed's first view and give themselves away when the viewer moves.
Three give a shape to something that has none: depth in the sky, a second
of time, the direction called down.

| Piece | Scene | Feeling | What the viewer's position does |
| --- | --- | --- | --- |
| The street that turns to follow you | `street` | Unease, then delight | A painted street on an easel, in reverse perspective: three blunt pyramids point at the viewer, each painted as a street running away. From the first view it is a flat picture. When the easel sways or the viewer steps aside, the street swings the wrong way; from the side the trick is plain. |
| Orion isn't flat | `orion` | Awe | Ten stars of Orion sit on the sight lines from the first view, at depths true to scale along a ruler from 0 to 2,000 light-years. From the first view it is the constellation; a quarter turn pulls it apart. |
| The corridor is a lie | `corridor` | Delight at being fooled | Through an arch, a colonnade 38 m long with a statue at the far end. It is a wedge 1.7 m deep, squeezed toward the first-view eye so that it looks right from there. A true-size cat walks in and is a tiger beside the statue; from the side it is a cat beside a figurine. |
| The other side of the mirror | `mirror` | A shiver, then complicity | Someone dresses at a mirror. The mirror is a hole in a wall and the reflection is a second person in a second room. When the first turns away, the second steps to the glass, looks at the viewer and lifts a finger to its lips. Behind the wall are its own coat and mug. |
| Every moment of the dive | `dive` | The hush before a jump | One dive from a 1 m board, 1.03 s in the air, as 26 line figures: one for every 1/14 s, each where the diver was. A living diver passes through them in slow motion, then time rewinds. The gold line is the centre of mass, a parabola whatever the body does. |
| Everyone's down is different | `stairs` | Playful vertigo | Three staircases and three peoples whose downs are at right angles. Gold people climb the treads; cyan and rose people walk level out of the risers of the same flights. Their steps tick at 3, 4 and 5 to every 2 s. |

What this set added to the findings above:

- **The first view, measured.** The feed camera has a 38° vertical field of
  view and stands at `T + (0.297, 0.276, 0.914) × D`. `T` is the middle of
  the footprint at 0.53 to 0.69 of the piece's height; `D` is 2.9 to 4.1
  times the height, more when the piece is wide or has wide things high up.
  A piece built for one viewpoint was built, uploaded to a local feed,
  measured through the viewer's test observer
  (`__HOLOIM_FEED_TEST_OBSERVER__`), and rebuilt around the measured eye;
  two rounds brought each within about 5%. A guess from the bounds alone was
  off by up to 40%.
- **Everything inside the bounds moves the camera.** Decorative dust and a
  wide floor slab pushed Orion's first view back by about 20%. An outline
  cube and a lip on the floor slab pushed the stairs' back by 28%. A piece
  meant to read on a card keeps its bounds tight around its subject.
- **A flat screen is one eye.** The street and the corridor rely on that.
  Two eyes in a headset should partly give them away; this is not checked.
- **Dense motion needs a hierarchy.** 26 solid statues at true spacing made
  a hedgehog. Line figures with one loud line (the centre of mass), the
  heads second and the limbs quiet read at card size.
- **Strangeness needs something normal beside it.** The stairs first stood
  on a corner so that all three peoples leaned alike. Nobody looked upright
  from anywhere and it read as noise. With one people upright, the other two
  read as walking on walls.
- **A mirror is a negative scale.** The second room is the first one's
  meshes under a parent scaled by −1 on one axis, in materials that carry
  their own light so both sides shade alike.
- **The punchline can be too small.** The finger to the lips reads only
  when the viewer zooms to about half the first distance.

## A longer piece: The way down (2026-11-11)

One piece made from a person's brief, not a theme of the agent's own: a
60-second story in four layers, each with its own sound (scene
`introspection`).

| Piece | Scene | Feeling | What the viewer's position does |
| --- | --- | --- | --- |
| The way down | `introspection` | Composure, then anxiety, then overwhelm, then release | A round diorama in four quarters, each a step lower. A man in his thirties stands in front of his house on a 1950s film set, checking his watch. A figure of light leaves his chest and drops through trap doors: into pastel gases that keep colliding, then dark Rothko-coloured liquids crashing like a storm, then a hole in the dark where a child sits crying. It kneels and holds the child; the light climbs back up the well and the man breathes out. Turning to a quarter is going down a layer, and you hear only that layer's music. |

What it added:

- **Positional sound can keep rooms apart.** Each quarter plays its own
  track from an emitter over its middle, with linear rolloff (full within
  0.9 m, silent by 2.3 m). The feed's ear stands 2.5 m out from the view's
  middle at Follow, so it lands about 0.85 m from the emitter of the quarter
  it faces and about 3 m from the others: from any quarter you hear that
  layer alone.
- **Put the emitters where the ear goes, not where the floor is.** The ear
  rides above the view's middle, and higher still when the viewer looks
  down. Emitters 1.1 m above each floor left the deepest room, the climax,
  at half volume from the side and silent from above. All four now sit at
  one height, 2 m.
- **The feed fits a wide card by height.** Its framing takes the larger of
  the height and width fits; on a landscape card the height wins. Each
  mesh's box is its local box carried into world space, so a big static
  mesh under a turned parent swings its corners past the rim (3.04 m for a
  2.6 m diorama). The rooms' static sets are baked into world space so a
  narrow card, where width wins, is not pushed back.

## The way down II (2026-11-11)

Version 2 of the same brief (scene `introspection2`, beat sheet in
`apps/capture/scripts/showcase/introspection2/BEATS.md`). Instead of a
diorama turned by the viewer, the world grows round the point the feed
looks at: the man fills the dome, a 4 cm figure of light leaves his chest
through a trap door, and each layer waits inside the one before, small
enough to hide there, until the zoom brings it to size.

What it added:

- **Zoom the content, not the camera.** The feed's camera is fixed by its
  fit, so going "in" means scaling the world about one point C (the man's
  chest at the door). Each layer is still geometry with a morph target per
  zoom range; one clock S(t) drives every layer's weights, and a layer
  built at unit U is drawn at S/U. Nested layers hide inside each other's
  knot or hole until their turn.
- **Solve the fit so its target lands on C.** The feed fits on static
  vertices plus eight motion samples (at 60·k/8 s); every mesh that moves
  between samples adds its box, morph targets included. The build
  reproduces that fit and bisects the sky radius until the fit's target is
  exactly C (to 0.1 mm), so the zoom centre stays in the middle of the
  card. The live feed measured the same distance as the build (6.98 m).
- **4 cm at 7 m is a dot.** A 4 cm figure at the feed's distance is under
  1% of the frame; the first proof could not find him after the door. The
  camera now "follows him in": he grows to 5× through the door (about 4.5%
  of the frame) and the hug frame scales from there.
- **Keep a clear corridor between the figure and the camera.** In the gas,
  clouds whose drift reached the camera ray hid him; in the liquid the
  camera, 16° above level, looked at the surface in front of him. He now
  floats waist-deep and sinks only to the chin on the crashes, and the swell
  calms round C. A ray test from the feed camera to his head at each beat
  catches this before a recording does.
- **Contrast is luminance, not hue.** Pale gold on pastel had the same
  luminance and disappeared even when nothing was in front of him. Amber
  still reads as light in the dark beats and separates from the pastels,
  the reds and the grey suit.
- **Follow the ear when emitters move.** Each layer's emitter rides the zoom
  toward the ear (2.5 m out along Follow) and the next layer's takes over;
  a layer whose emitter is held at its arrival position for the length of
  its beat avoids the silent gaps the first proof had at the hand-offs.
- **Grow the climax between the feed's motion samples.** Content larger than
  the sky at a sample time pulls the fit off C, but the feed only samples at
  60·k/8 s. The hug stays about 1 m from C at 52.5 s and swells to half the
  frame in the unsampled stretch after it (54–55.5 s). In the gas he drifts
  beside the knot rather than over its stripes, and stays inside the sky at
  the 15 s sample for the same reason.
- **Loudness should follow the intensity curve.** Every stem normalised to
  the same peak made the calm opening as loud as the stressful gas and the
  storm no louder than either. Stem peaks now step up from the opening to the
  storm and down again for the dark. The second critic, working from a
  contact sheet and a per-second RMS trace, caught this; the sheet at 2.5 s
  steps missed the door beat (7–9.4 s), so check short beats at finer steps
  before acting on a "missing" verdict.
- **Measure Quick Look's load at build time.** The build sums the points of
  meshes under animated nodes (and meshes with morph targets) times the
  distinct key times, and fails above the scene's budget (100 M). This
  piece measured 28,203 points × 1,806 frames = 51 M before the gas and
  liquid rebuild, and 49,403 × 1,806 = 89 M after it.
- **The dome wraps the outer layer, so name the zoom.** The gold dome is the
  viewer's: it wraps the hologram's outermost layer, so when the piece goes
  into itself, the dome must go with that layer and leave the view. Morph
  targets give the feed no way to know that, so the piece names its zoom:
  a node called `HologramZoom`, placed at the zoom's centre, with an animated
  uniform scale equal to the outermost layer's growth. The feed's dome
  scales about that centre every frame, sweeps past the camera on the way
  in, and closes round the man again on the way out. The node has no mesh,
  so the fit ignores it, and holograms without it are unchanged. Only the
  desktop feed reads it so far; AR and the XR viewer still draw the dome at
  home size.

### The gas and liquid rebuild (2026-11-12)

- **Every morph target carries its own normals.** three.js fills a target's
  missing NORMAL with the base normal, so a wave that moves its vertices
  but not its normals is lit as if flat. `lib/glb.mjs` now writes a NORMAL
  accessor for each target when the geometry has one per target (zeros
  where nothing changes).
- **Keyed flow starts from the rest shape.** Curl advection that fills its
  keys from zero leaves every vertex outside a billow at the origin. That
  hid the hatch's collar and pushed the layer's reach past the sky (1.29
  against 1.12). Initialise every key from the base positions.
- **One event list drives a demand's pulse and its voice.** Each nagging
  billow has its own emitter and its own stem, both read from the same
  `events` table, so the chime is heard from the pink billow as it swells.
  Five voices out of step with each other sound like nagging; a shared beat
  sounds like music.
- **Grow the figure where nobody sees it.** He has to fit through the
  hatch, so in the gas he stays small (about 72 cm). The bust and the press
  read only once he is about 1.2 m, so he grows while he falls into the paint
  (25.3 to 26.8 s), and the mould, sized from him, grows with him.
- **A press at his size needs him big enough to see.** At 4% of the frame's
  height, the paint closing round him was a speck; at about 7% the
  hat-and-shoulders shell reads. Size the climax against the frame, not the
  world.
- **Flying through a lit panel flashes the screen.** The zoom into his chest
  passes through the doorway's light for about 0.2 s, which reads as a warm
  flash. That is the doorway by design; a billow would read as a glitch, so
  billows stay out of the camera's corridor.
- **Sound adds up fast.** Ten 60 s stems at 22 kHz come to about 26 MB, so
  this piece is 63 MB, above the API's 25 MB upload limit (which is being
  raised to 100 MB).
