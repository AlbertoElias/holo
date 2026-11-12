# The way down II: beat sheet

Draft for approval, written before any building. It covers a 60 s loop played
in the feed at Follow. Scale is the world's zoom, where 1 means the man fills
the dome. Intensity runs from 1 (stillness) to 10 (the storm's peak).

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

## The nesting

Each layer is built at the size where it fills the dome. It waits inside the
previous one, shrunk by the step factor.

| Layer | Lives inside | Step | Walls vs the traveller |
|---|---|---|---|
| The man, 1.8 m | the dome | 1 | 45× |
| Pastel gas, in his torso cavity | his chest | ×100 | about 75× |
| Rothko liquid, in a knot of gas | a gas vortex | ×40 | about 75× |
| The dark, with the child | a seam under the liquid | ×40 | only her light |

**The traveller is 4 cm on his chest; then the camera follows her in.** The
first zoom carries her through the door until she is 5× that (20 cm on
screen, about 4% of the frame). Among the gases and liquids she is 12×
(47 cm, about 10% of the frame): at 5× she was a 12 px speck against the busy
layers. She shrinks back to 5× as she falls into the hole, and keeps that while
the dark grows round her. Each zoom grows the walls 40–100× around her, so
she still gets relatively smaller: that is the descent. At the core, the zoom goes into her and the child instead, so the
hug fills the frame.

## Beats

| # | Time (s) | Int. | Scale | Picture | Sound (positional) | Acting |
|---|---|---|---|---|---|---|
| 1 | 0–7 | 2 | 1 | **The composed man.** A 1950s suit and hat, standing in the bell jar. A 4 cm glow hides at his breast pocket, easy to miss. | **The tune:** a celesta and muted-clarinet waltz in a minor key over a low tritone pedal. Light and ominous. **Heartbeat:** 66 bpm at his chest, soft. | He breathes, his weight settles, he straightens his tie and checks his watch. His smile holds a beat too long. **Traveller:** she climbs out of the pocket onto his shirt, small and curious. |
| 2 | 7–12 | 3→5 | 1→100 (she grows with it to 5×, then stays that size on screen) | **Going in.** She finds a trap door between two shirt buttons and lifts it. Light spills out and she drops through. The chest fills the frame, and we pass through the shirt into a ribbed torso cavity full of coloured haze. | The tune slows and bends flat, as if the tape is stretching. The heartbeat swells as we reach it and speeds up (66 → 100). Gas hiss rises from the centre. | **Man:** his hand drifts to his chest, a held breath, and he freezes. **Traveller:** she kneels, pulls the door up with her whole body, and drops through feet first, arms up. |
| 3 | 12–24 | 5→7 | 100 | **Gas.** Pastel clouds (pink, mint, lilac, butter) collide and shear. Gusts cross her path, and a vortex knot tightens below. | **Busy and stressful:** arpeggios in 5 against 7, ticking clicks and rising sirens. Each cloud has its own voice and position. Heartbeat racing (100 → 140). | Buffeted: she shields her face, spins in a gust and recovers. She swims down against it and is knocked back. **Clawing:** she tears at the knot's edges, and it opens. |
| 4 | 24–27 | 7→8 | 100→4,000 | **The knot is a portal.** We follow her down the vortex throat. The gas sweeps out past the camera, and dark red light floods up from below. | The arpeggios smear upward and are cut off. The first low surge arrives from below. | She is sucked in head first with her arms trailing. |
| 5 | 27–37 | 8→10 (peak at 33–35) | 4,000 | **Liquid.** Slabs of maroon, cadmium orange, oxblood and plum heave and crash into each other. They are viscous and heavy, with soft Rothko edges. | **An abstract storm at sea**, made entirely of synths: sub-bass surges, detuned saw swells and metallic FM hits on the crashes. There is no water, wind or noise texture. The heartbeat pounds, then drowns under the storm at the peak. | **Pulled under** (30 s): a wave drags her down, she breaks the surface gasping, and is dragged under again (33 s, the peak). **Reaching:** her hand stretches up out of a trough, and the slabs close over her. |
| 6 | 37–40 | 10→1 | 4,000→160,000 | **The hole.** At the bottom of the trough, the liquid parts for a moment to show a tiny black seam, easy to miss. She slips through, and the liquid sweeps past and is gone. | **A hard cut** to near silence: one high sine, barely there, and her breath. The heartbeat is gone. | She falls limp and slow, turning once. |
| 7 | 40–45 | 1→2 | 160,000 → ×10 into her | **The dark.** Black everywhere; she is the only light, lighting a small circle of floor. The world grows slowly round her so that, by the time she reaches him, the two figures read. Then, at the edge of her light, a shape. | Near silence. A faint, uneven, sob-like breath (synthesized) from where the shape will be. | She gets up, holds her light out and steps carefully. She stops when she hears him. **The child appears only as she reaches him:** hunched, knees up, face hidden, his shoulders heaving with sobs. |
| 8 | 45–55.5 | 3→1 (release) | ×2 → ×16 into the pair (×8.5 at 52.5 s, the feed's last motion sample; the climax swells after it to about half the frame) | **The hug, filling the frame.** She kneels, reaches out, hesitates, and touches his shoulder. He flinches, then turns into her. They hold on, and the sobs slow and settle. Her light opens up to warm both of them. | **Heartbeat returns**, slowly, as the child's (48 → 60 bpm). **The tune returns transformed:** half tempo, now a lullaby in 3/4 on a music box and a soft pad. The tritone pedal resolves into an open fifth, and the dissonant note turns into a suspension that finally resolves. | The hug is a long hold that settles: the shoulders slow from sobbing to breathing, her chin comes to rest on his head, and their breathing syncs (about 10 s). |
| 9 | 55–60 | 1→2 | to 1 | **The way back.** The world zooms back out through the calmed layers, pausing on the still liquid and the settled gas, onto the man. His hand is on his chest and his eyes are closed. He exhales, straightens and is composed again (the loop). | The lullaby's last note becomes the waltz's first. Heartbeat at 66, now even. | **Man:** a deep breath out and his shoulders drop, then he straightens his tie (beat 1 again). |

## The heartbeat thread

It is one emitter voice whose position travels:

- his chest at 66 bpm,
- racing in the gas (100 → 140),
- pounding, then lost in the liquid,
- gone in the dark,
- returning as the child's (48 → 60),
- the man's again at 66, now even.

## The tune

It is a 4-bar minor waltz. Its first statement has the tritone pedal and a
held, uneasy note. On its return it is slower, in 3/4 as a lullaby, played on
the music box. The pedal opens to a fifth, and the same uneasy note now
resolves. The return changes the pacing, the timbre and the resolution, not
just the key.

## How it is built

- **Grey draft first:** flat colours, placeholder synth sound, real timing and
  acting. Then a real-time proof video on a local feed, judged against this
  sheet. Then an independent critic (Codex) reviews the video, then refinement.
- **Acting** is key-framed poses with eased holds and breath on every
  figure. Shoulders and chest rise and settle, with weight shifts before each
  move. There are no looping procedural gestures.
- **Quick Look budget:** moving vertices × 1,800 frames must stay under 100 M,
  so roughly 55 k moving vertices in total, split across the layers. It is
  measured at build time, and the build fails if it is over.

## Decided with you

1. **The dome is the viewer's, and it wraps the outer layer.** When the
   piece goes into the man, the dome grows with him and leaves the view, and
   it closes round him again on the way back. The piece names its zoom with
   a `HologramZoom` node, which the feed's dome follows.
2. **The child's sobbing is synthesized**, like every other sound.
3. **The way back zooms out** through the calmed layers: from the hug, held 55–55.5 s,
   it pauses on the liquid (56.3 s) and the gas (57.2 s), then the man is whole
   again at 58.5 s for his exhale (58.5–60 s).

## Proposed: what the gas and the liquid are about (for your choice)

Your note (2026-11-12): the gas is the day-to-day stresses pushing and pulling
you; the liquid is the badly learnt fears of who you're supposed to be, the
lack of acceptance of yourself. No words, but being in them should make you
feel that way. Today both layers read as weather: pretty clouds, then a
storm, with nothing that acts on her for a reason.

The thread that ties both layers to the man is his **composed gestures**
(he straightens his tie, checks his watch). In the gas they become her
compulsions. In the liquid they become the shape she is pressed into.

### The gas: pulled every way at once

**A. Tugged (recommended).**
- **The clouds:** each one is a demand with its own rhythm and its own
  voice. They pulse out of time with one another: a buzz pattern, a
  two-note chime, a ticking, a kettle-like rise, a clatter.
- **The tethers:** when a cloud pulses, a thin strand shoots out and latches
  onto one of her limbs, and pulls that limb toward it. She is stretched
  between two or three at once. As she frees one, the next one latches.
- **Getting nowhere:** every time she starts to swim down, a cloud slides
  across her path and turns her round.
- **Her acting:** between tugs she does the man's watch check, faster and
  faster, then his tie straighten in mid-air, as if putting herself back
  together is part of the stress.
- **The sound:** the nagging voices stack up, each from its own cloud, and
  get denser as the heartbeat races (100 → 140). The portal opens when she
  tears the last strand off and dives.

**B. Rush hour.**
- **The clouds:** streams of them cross in lanes, like crowd or traffic
  currents.
- **Her path:** she has to cross the lanes. She is jostled and swept
  sideways, and keeps getting carried back to where she started.
- **The sound:** each lane sounds as it passes her ear.
- **What it trades:** it is simpler to read than A, but it says "busy"
  more than "pulled apart".

### The liquid: pressed into who you're supposed to be

**A. The mould (recommended).**
- **The slabs:** their soft edges resolve into the man's own silhouette,
  in his suit and hat, huge and composed: who she is supposed to be.
- **The pressing:** the slabs close on her and press her into that outline.
  She is held in the pose, his straight back and tie hand, and struggles
  out. Then the next slab presses her into it again. That is the
  "pulled under" beat, now with a reason.
- **The tune:** the waltz, his "proper" tune, comes back huge, slowed and
  heavy, pressing down from above. Sub-bass clamps land when the slabs
  close. The heartbeat drowns.
- **Her acting:** she hides her face, curls small, tries the man's pose
  and can't hold it.
- **The turn:** at the bottom she stops fighting the mould and goes limp.
  Only then does the seam open, so letting go of who she should be is
  what lets her find the child. The hard cut at 37 s lands on that
  surrender.

**B. The faces that turn away.**
- **The figures:** looming, perfect, upright copies of her, amber and
  composed, stand in the liquid.
- **Her reaching:** she reaches toward each one, and each turns its back.
  The liquid between them gets heavier.
- **The turn:** at the bottom she stops reaching and sinks through the seam.
- **What it trades:** it is more about rejection by others than
  self-rejection, and adds three more moving figures, which costs Quick
  Look budget.

### What it costs

- **Both A options reuse what exists:** the layers' morph-target zoom, the
  key-framed acting and the positional emitters.
- **New geometry:** the tethers are thin strips with a few key frames each.
  The mould is the man's silhouette extruded into the slabs' shape, so it
  adds no new moving figure.
- **Quick Look:** it stays under the 100 M point-frame budget (today 50.9 M).
- **What it means for the sheet:** beats 3 to 6 change, in picture, sound
  and acting. Timing, the zoom and the hug stay.
