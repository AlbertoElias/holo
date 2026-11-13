# The way down II: beat sheet

It covers a 60 s loop played in the feed at Follow, with the inner layers
reached by the viewer's deep zoom ("The nesting"). Intensity runs from 1
(stillness) to 10 (the storm's peak). The beats are where the traveller is;
every layer runs all loop.

## What the spike showed

- **Growing the world by a node's scale breaks the framing.** The feed fits its
  dome once, from samples taken across the take. With node scale, the dome came
  out 230 m tall and the camera stood 620 m back.
- **Growing each layer with morph targets on a still node works.** The feed
  fits only the base vertices. Through the whole 10 s zoom, the camera,
  target and distance stayed fixed (8.9 m), and the man's chest grew past
  the camera.
- **What the spike got wrong:** its zoom centre sat 0.8 m off the Follow
  target, so the chest slid sideways out of view instead of swallowing it. In
  the build, the zoom centre is the feed's target, computed at build time
  from the same fit the feed uses. The dome is shaped by the home size of the
  inner layers, which makes it a bell jar a little taller than the man.
  That puts the target at his heart.
- **The ear stays put.** It stays 2.5 m in front of the target whatever the zoom
  does. Each layer's sound sits just in front of that ear while its layer is
  "home". When the next zoom carries a layer outward, its sound flies past and
  fades (linear rolloff, 0.9 to 2.3 m), and the next layer's sound grows in
  from the centre. The crossfade is the zoom itself, not a mix automation.

## The nesting (sixth pass, 2026-11-13: a still nesting)

The clip no longer zooms. Every layer is built once, still, in its own units
under a static `HologramLayer_*` node, and the viewer zooms into them
(`docs/features/archive/deep-zoom.md`). The passes below describe the old morph zoom
and `HologramZoom`; they are history.

| Layer node | Inside | World size | Where |
|---|---|---|---|
| (layer 0) the man, 1.8 m | the dome | 1 | |
| `HologramLayer_gas` | the man | 0.01 | C, his heart: the point in his chest farthest from his surfaces |
| `HologramLayer_liquid` | the gas | 2.5e-4 (×1/40) | a slowly spinning knot under the traveller |
| `HologramLayer_dark` | the liquid | 6.25e-6 (×1/40) | a dark knot under the sea |

Each layer's nearest layer ancestor is the one before; no siblings. No layer
node or ancestor has a track, and nothing is sized for the feed's fit: the
build checks that the fit is the same with and without the inner layers.
Meshes in layers are rigid and unlit (morph targets only).

**What always runs.** All four layers are alive all 60 s and loop
seamlessly: the man's acting; the gas's ambient puffs (whole numbers of
crossings and turns a loop), its gusts at 12.5–21 s and the spinning knot;
the sea's swell (whole-loop harmonics), its 21 waves at 27.5–34.5 s and 22
ambient ones; the child in the dark, sobbing until the hug and resolving in
it; every sound. A viewer can zoom into any layer at any time.

**The traveller** is one rigid rig per layer, each keyed in its layer's
units, handed over at the doors by STEP scale keys 0 ↔ 1 on the 30 Hz grid.
The rigs meet exactly at each door (pelvis frames 0.00 mm apart):

| Rig | Shown | Handover in | Handover out |
|---|---|---|---|
| man (on his chest, 4 cm) | 0–9, 57.6–60 | | 9.0 into the gas |
| gas | 9–25.2, 56.8–57.6 | 9.0 from the man | 25.2 into the knot |
| liquid | 25.2–37, 56–56.8 | 25.2 from the gas | 37.0 under the sea |
| dark | 37–56 | 37.0 from the liquid | 56.0 back up |

On the way back (56–57.6) each rig rises out of its layer's door at the size
it entered with, so the way home reads at every depth.

**Every way down is a trap door, and every door is found by letting go.** He
cannot fight his way out of the gas or the liquid. Only when he calms down
and accepts where he is do the gas or the paint relax, and the relaxing
reveals the door to the next layer.

## Sound (sixth pass)

Background, sparse and succinct: it accompanies the picture and never leads
it (the user: the audio "is just accompanying the imagery"). Seven seamless
60 s loops, each a static emitter in its layer, so the viewer's depth mixes
them: the stage's waltz and the man's heart (layer 0); the gas's notes and
the traveller's racing heart; the sea's line; the dark's sobs and lullaby
with the child's heart.

## Beats

| # | Time (s) | Int. | Scale | Picture | Sound (positional) | Acting |
|---|---|---|---|---|---|---|
| 1 | 0–7 | 2 | 1 | **The composed man.** A 1950s suit and hat, standing in the bell jar. A 4 cm glow hides at his breast pocket, easy to miss. | **The tune:** a celesta and muted-clarinet waltz in a minor key over a low tritone pedal. Light and ominous. **Heartbeat:** 66 bpm at his chest, soft. | He breathes, his weight settles, he straightens his tie and checks his watch. His smile holds a beat too long. **Traveller:** he climbs out of the pocket onto the man's shirt, small and curious. |
| 2 | 7–12 | 3→5 | 1→100 (he grows with it to 5×, then stays that size on screen) | **Going in.** He finds a trap door between two shirt buttons and lifts it. Light spills out and he drops through. The chest fills the frame, and we pass through the shirt into a ribbed torso cavity full of coloured haze. | The tune slows and bends flat, as if the tape is stretching. The heartbeat swells as we reach it and speeds up (66 → 100). Gas hiss rises from the centre. | **Man:** his hand drifts to his chest, a held breath, and he freezes. **Traveller:** he kneels, pulls the door up with his whole body, and drops through feet first, arms up. |
| 3 | 12–22 | 5→7 | 100 | **Gas: gusts that hit him.** The gas is close, not a landscape: soft, see-through puffs (pastel pink, mint, lilac, butter, sky) stream past him and past the camera along a turbulent flow, some so near they wash across the frame. Each day-to-day demand is a gust of its own colour: it gathers off to one side, then blasts across at him. When a gust hits, he is knocked sideways and tumbles, and his limbs trail in the flow. Gusts come from several sides and faster and faster, so he is shoved before he can right himself. | **Nagging, quantized:** each demand is a short MIDI-like loop on its own voice (square, pulse, triangle, a chip-noise click), each in its own meter, so the loops drift against one another. A gust's loop is loudest as it hits him. Heartbeat racing (100 → 140). | He fights to hold his place. Between gusts he does the man's watch check, faster and faster, then straightens his tie in mid-air, as if putting himself back together were one more demand. |
| 4 | 22–27 | 7→3 | 100→4,000 | **Letting go of the day.** He stops fighting and lets the flow carry him: his arms fall open and he breathes out. The gusts die down, the puffs slow and thin out, and the gas below him opens (see the doors below). He drifts through it, and the gas sweeps out past the camera as the paint rises from below. | The loops drop out one at a time. The heartbeat slows (140 → 90) and his long breath out is heard. The first low note of the liquid arrives from below. | Held breath, then a long exhale: shoulders drop, hands open. He floats a beat, then sinks through the opening feet first. |
| 5 | 27–35 | 8→10 (peak at 33) | 4,000 | **Liquid: hit from every side.** Thick streams of paint in many colours (cadmium red, orange, ultramarine, viridian, magenta, ochre, white) fly in at him fast from several directions and burst into splashes on him. The colours mix where they land and run down a slow, churning pool behind him. The hits come on the beat and get denser, two or three at once by the peak at 33 s, each one knocking him back. There is no silhouette and no mould. | **The waltz, abstract and heavy:** its 4-bar tune as hard square-wave chords, quantized, one chord stab per hit, over a gritty pulse bass. Sub hits land with the biggest streams (30 and 33 s). The heartbeat pounds, then drowns under it at the peak. | He shields his face, gets knocked back, staggers up, and is hit again. By the peak he stops getting up. |
| 6 | 35–40 | 10→1 | 4,000→160,000 | **Acceptance.** He goes limp and lets the paint hold him. The streams stop, the pool settles and opens under him (see the doors below), black underneath. He slips through it, and the paint sweeps past and is gone. Nothing of the liquid stays in view after the cut. | **A hard cut** at 37 s, on his surrender, to near silence: one high square note, barely there, and his breath. The heartbeat is gone. | He falls limp and slow, turning once. |
| 7 | 40–45 | 1→2 | 160,000 → ×10 into him | **The dark.** Black everywhere; he is the only light, lighting a small circle of floor. The world grows slowly round him so that, by the time he reaches the child, the two figures read. Then, at the edge of his light, a shape. | Near silence. A faint, uneven, sob-like breath (synthesized) from where the shape will be. | He gets up, holds his light out and steps carefully. He stops when he hears the child. **The child appears only as he reaches him:** hunched, knees up, face hidden, his shoulders heaving with sobs. |
| 8 | 45–55.5 | 3→1 (release) | ×2 → ×16 into the pair (×8.5 at 52.5 s, the feed's last motion sample; the climax swells after it to about half the frame) | **The hug, filling the frame.** The traveller kneels, reaches out, hesitates, and touches the child's shoulder. The child flinches, then turns into him. They hold on, and the sobs slow and settle. The traveller's light opens up to warm both of them. | **Heartbeat returns**, slowly, as the child's (48 → 60 bpm). **The tune returns transformed:** half tempo, now a lullaby in 3/4 on a music box and a soft pad. The tritone pedal resolves into an open fifth, and the dissonant note turns into a suspension that finally resolves. | The hug is a long hold that settles: the shoulders slow from sobbing to breathing, the traveller's chin comes to rest on the child's head, and their breathing syncs (about 10 s). |
| 9 | 55–60 | 1→2 | to 1 | **The way back.** The world zooms back out through the calmed layers, pausing on the still liquid and the settled gas, onto the man. His hand is on his chest and his eyes are closed. He exhales, straightens and is composed again (the loop). | The lullaby's last note becomes the waltz's first. Heartbeat at 66, now even. | **Man:** a deep breath out and his shoulders drop, then he straightens his tie (beat 1 again). |

## The heartbeat thread

It is one emitter voice whose position travels:

- his chest at 66 bpm,
- racing in the gas (100 → 140),
- slowing as he lets go of the gas (140 → 90),
- pounding, then lost under the hits in the liquid,
- gone in the dark,
- returning as the child's (48 → 60),
- the man's again at 66, now even.

## The tune

It is a 4-bar minor waltz. Its first statement has the tritone pedal and a
held, uneasy note. On its return it is slower, in 3/4 as a lullaby, played on
the music box. The pedal opens to a fifth, and the same uneasy note now
resolves. The return changes the pacing, the timbre and the resolution, not
just the key.

From the third pass the whole score sounds like MIDI rather than an
orchestra: notes on a fixed grid, square, pulse and triangle voices, chip
noise for clicks, and General MIDI-like timbres (music box, synth bass, a
soft synth pad). The waltz opens on a thin pulse lead; the child's lullaby
is the music box. The heartbeat stays a body sound, not a MIDI drum.

## How it is built

- **Grey draft first:** flat colours, placeholder synth sound, real timing and
  acting. Then a real-time proof video on a local feed, judged against this
  sheet. Then an independent critic (Codex) reviews the video, then refinement.
- **Acting** is key-framed poses with eased holds and breath on every
  figure. Shoulders and chest rise and settle, with weight shifts before each
  move. There are no looping procedural gestures.
- **Quick Look budget:** split as the converter splits it, deformed (morph)
  points × frames under 100 M and rigid moving points × frames under 500 M.
  It is measured at build time, and the build fails if it is over.

## Decided with you

1. **The dome is the viewer's, and it wraps the man.** The viewer's deep
   zoom goes into the layers (sixth pass); the piece no longer zooms itself.
2. **The child's sobbing is synthesized**, like every other sound.
3. **The way back** rises through the calmed layers: out of the dark at 56 s,
   the liquid at 56.8 s and the gas at 57.6 s, to the pin on his chest by
   58.4 s for the man's exhale (58.5–60 s).

## Decided for the gas and the liquid (2026-11-12)

The user chose the "Tugged" gas and "The mould" liquid, with these changes:

- **The traveller is a he.** The scene code still names him `HER` and
  `herPaint`; rename those in the rebuild.
- **Each layer is left by letting go.** Fighting never opens a way down. When
  he calms down and accepts the layer, the gas or the paint relaxes, and
  that reveals the trap door to the next layer. This replaces the knot he
  claws open (gas) and the seam that opens when he goes limp (liquid);
  beats 4 and 6 above are the two surrenders.
- **The liquid is waves of thick paint, not slabs.** The waves roll, fold
  and rope, and their crests take the man's silhouette.
- **Gas and liquid move realistically.**
  - **The gas:** billows that roil, curl and tear, as if advected by a
    turbulent flow (curl noise is the usual way).
  - **The paint:** waves with viscous weight, where crests fold over and
    collapse slowly, and strands stretch and snap back.
  - **The cost:** today's morph-target layers are stiff blobs. Realistic
    motion needs more moving vertices or more key frames. Quick Look's
    load is 50.9 M of the 100 M budget, so there is room for about 27 k
    more moving points over the take. Measure it at build time, as now.

## Decided before the rebuild (2026-11-12)

*Superseded by the third pass below: the relief and the gas hatch are gone,
and the five voices became quantized loops.*

- **The silhouette is a legible relief.** As each paint wave rears up, its
  crest holds for about half a second as a clear bust of the man in the
  paint: hat crown and brim, head, shoulders, lapels. It is in the paint's
  own colours, so it reads as paint taking his form. Then it folds over and
  presses the traveller into the same outline at his own size.
- **The gas door is a hatch in a cloud floor.** Under him, a denser and
  slower bank of gas swells into a mound round C. When the billows part, they
  uncover a hatch set in the mound's face, where the line from C toward the
  feed leaves it, the same door as on the man's shirt. Through it is the
  liquid's dark red.
- **Each nagging voice has its own emitter on its own billow** (buzz,
  chime, tick, kettle, clatter), carried by the gas's zoom. Five more
  60 s stems make the file larger than today's 25 MB upload limit; the user
  is raising the limit to 100 MB.

## Decided for the third pass (2026-11-12)

The user watched draft 9 and said:

- the gases feel like satellite clouds with little impact;
- the liquid should mix more colours, all hitting him ferociously;
- a silhouette of the man appears in the inner layers, which makes no sense;
- the trap doors all reveal themselves in different, odd ways, and the shirt
  door looks like a post-it;
- in the child scene there is a red horizontal line;
- the music should be more abstract, more of a MIDI vibe.

They chose to keep this build pipeline (script-made geometry, morph targets,
Quick Look) and get more out of it, rather than switch tools.

- **The gas is close and hits him.** It becomes a few hundred soft,
  see-through puffs: flat sprites with a generated alpha texture, each turned
  to the feed's fixed camera. They are scattered round him and between him and
  the camera, and they ride a turbulent flow. Each demand is a gust: a stream
  of its colour that gathers to one side and then blasts across him. On each
  hit he is knocked sideways and tumbles. The distant billows and the cloud
  floor go.
- **The liquid is many colours, thrown at him.** It becomes streams of paint
  (tapered tubes) in many hues. They fly in fast from several directions and
  burst into droplet splashes where they hit him, and they leave colour
  running into a churning pool behind him. The hits land on the music's grid
  and get denser toward 33 s.
- **No silhouette.** The mould reliefs go; nothing in the gas or the liquid
  takes the man's shape.
- **One door, in every layer: the layer opens.** The user chose this (below).
- **Nothing outlives its layer.** The red line is the old liquid sea, held at
  its largest zoom, seen edge-on above the dark for the whole child scene.
  Every outer layer now shrinks to nothing (or folds away) once the next one is
  home, and comes back only for the way back.
- **The music is abstract and MIDI-like.**
  - Quantized patterns on square, pulse and triangle voices, with chip noise.
  - The man's waltz is a thin pulse lead. The gas demands are short loops,
    each in its own meter. The liquid is hard square chord stabs, one per hit,
    over a gritty bass. The dark has one high square note. The child's
    lullaby is the music box.
  - The heartbeat thread and the tune's transformed return stay as they are.
- **Quick Look budget.** The cost is moving points × key times; draft 9 used
  89.2 M of 100 M. The moulds and the dense sea grid go, which frees their
  points. A sprite is 4 points and a stream is a few dozen, so the new gas and
  liquid fit if layers that are off screen stop moving: their key times are
  shared and they cost the same at every time. The build still measures this
  and fails over budget.

### The door (decided: the layer opens)

- **The layer opens (recommended).** No door objects. At each way down, the
  material he is in parts into a round opening that widens like an iris, with
  the next layer's colour showing through: the shirt fabric parts between two
  buttons, the gas thins into a hole, the paint pool swirls open into a black
  well. The same motion and shape each time; it reads as the layer letting
  him go.
- **A hatch everywhere.** One square hatch, with a frame, a lid that swings up
  on a hinge, and light underneath. It sits on the shirt, then floats in the
  gas, then floats on the paint. It is clearer as "a door", but in the gas
  and liquid it is an object that has to come from somewhere.

## Decided for the fourth pass (2026-11-12)

The user watched draft 10, agreed with the critic (he is too small in the
gas and the paint, the dark from 38 to 44 s is nearly empty, and the hug is
too small and far away), and said:

- the gases should feel like there are more of them at the same time;
- the liquid should not be one wave hitting him and then the next. He is in
  a sea, with several waves of different colours clashing on him at once,
  and it should feel like a sea. Draft 10 read as a multicoloured pool, with
  splashes hitting his head;
- the portals all look weird. The first should feel like zooming in inside
  him, and the gas is what is inside his body;
- the fact that he has to relax to uncover each door does not come across.

They chose **a see-through body** for the way in and **calm clears the way**
for the ways down.

- **Bigger.** He fills about a fifth of the frame's height in the gas and
  the sea, against a few percent in draft 10. In the dark he stays near that
  size while he walks, and the hug grows to about half the frame.
- **The gas is crowded.** Gusts overlap: from the first hit, two to four are
  in flight at once, gathering on several sides while another lands. The
  ambient puffs are denser close to him, so he is always among them.
- **The way in: a see-through body.** As the camera closes on his chest, his
  suit and body turn to a glassy outline from the heart outward, and the gas
  is already there, swirling inside his torso. The camera passes through the
  outline, and the gas that was inside him is all around. The shirt door
  goes.
- **The liquid is a sea.** He is in open water up to his chest, the
  camera just above the surface, with the sea running to the horizon. Swells
  of different colours roll in from several directions, two to four at a
  time, rise over him, crest and break on him, and cross each other where
  they meet, so the colours clash in the water. The thrown paint ropes and
  the pool go.
- **Calm clears the way; no doors after the first.**
  - In the gas, while he is fighting, nothing opens. When he breathes out and
    goes limp, the gusts die and the gas thins outward from him in a ring,
    uncovering the dark of the sea below. He drops into it.
  - In the sea, when he stops fighting, the waves fall still and the water
    goes flat. He sinks, the surface closes over the camera, and its
    coloured underside falls away above him into the dark.
  - The gas iris's coloured rim and the black well in the pool go.
- **The dark is not empty.** The sea's underside stays in view as it
  recedes, while he sinks, lands and starts to walk at his larger size.

### How the fourth pass is built

- **The way in.** From 7.15 s the statue's parts shrink to their own centres
  in six bands, from the heart out to the hands and feet (about 1.5 s).
  Under them is a glass copy of his surface, 2 mm in, at 20% opacity in his
  colours paled. His torso holds the gas: the far half of its wall, drawn
  from inside in the gas sky's colours, and puffs in the gas's colours,
  swirling. More puffs sit just behind the spot the zoom enters, small near
  the shirt, so the view fills with gas up to the switch. The traveller
  kneels with his palms on the shirt as it clears, then sinks through. On the
  way out the body sets again, hands and feet first, before 58.5 s.
- **The sea.** One sea, 8 m round him, marbled in the paint colours at
  about a quarter of their strength. Twenty-one waves, each one colour, run
  as long swells across it from the far side and the flanks (never from the
  camera's side). They are low far out, steepen near him, and curl only
  where they meet him. Between him and the camera the water stays low, so
  the waves rise behind and beside him and sink as they roll on toward us.
  At 30 s and 33 s two or three break on him at once. Calm (34.6–35.6 s)
  stills the swell; the sea climbs over him and the camera, and the dark's
  sky takes over from the frame the camera is under.

### Decided for the fifth pass

The user's notes on draft 11, taken as given:

- **The music steps back.** It should be more succinct, with less of a
  leading role.
- **The sea is beautiful.** Rothko's colours, but beautiful: the still sea
  above all.
- **Letting go reads in three steps.** He breathes, then the gas or the sea
  calms, then he passes to the next layer.
- **The dark at 38–44 s is not plain black.**
- **He comes home small.** At 58.3 s he no longer crosses the man's chest at
  a large size.

### How the fifth pass is built

- **The still sea** is painted in Rothko's soft horizontal fields by depth
  across the frame:
  - near: oxblood;
  - middle: a red field, then a plum band;
  - far: a glowing orange horizon.
  
  The fields are scumbled with a slow marble and fade at the edge into a
  deep red sky.
- **The waves** rise out of the sea's own red at the foot and the ends into
  their colour up the face. Each keeps some of the red, under a faint cream
  lip. Their colours are all one warm family: cadmium, vermilion, saffron,
  burnt orange, oxblood, plum, magenta, a deep ultramarine and a warm white.
  The pigment names stay, because the music keys on them. The water between
  him and the camera stays lower than before.
- **Letting go, gas.**
  - 21.6–22.2 s: still.
  - 22.6 s: one big breath in (chest open, head up, arms wide), held to
    23.2 s.
  - 23.2–23.9 s: a long breath out. During the breath the puffs round him
    draw in, then are pushed out, his glow swells and lets go, and the
    panting stops.
  - 23.5–24.3 s: the gas calms.
  - 24.0–24.7 s: it opens under him.
  
  The breath starts after 22.5 s because the feed fit samples that frame,
  and the swelling glow would pull the dome off C.
- **Letting go, sea.**
  - 34.75 s: a breath in, as the last wave passes.
  - To 35.7 s: a breath out, into limp, with the same glow swell.
  - 35.5–36.1 s: the swell calms.
  - From 36.05 s: the sea rises over him.
- **The dark** shows the sea's underside from the frame the camera is under
  until 44.6 s. It is a wide arc behind and above him, fading to black at
  its ends, in soft fields: black,
  oxblood, a glowing red seam, plum, black. It rises out of the frame as he
  sinks, until only his own light is left. It is built at a tenth of its
  size and drawn at s = 10, like the skies, so the feed fit stays on C.
- **Home.**
  - 57.7–58.4 s: he shrinks with the world toward the pocket pin, and the
    child goes down with him.
  - 58.5 s: the pin takes over at his pocket size.
- **The music** is sparser and quieter:
  - Gas: eighths only, fewer hats, crashes about 60% as loud, and a falling
    square on every other gust.
  - Demand voices: gather for 0.75 s.
  - Sea: the bass is in quarters, and stabs come only on the big waves.
  - Every layer is normalised lower.
  - The breath and opening cues moved to the new times.
