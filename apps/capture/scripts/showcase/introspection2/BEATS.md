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
| The dark, with the child | a trap door under the liquid | ×40 | only his light |

**The traveller is a he, 4 cm on the man's chest; then the camera follows him
in.** The first zoom carries him through the door until he is 5× that (20 cm
on screen, about 4% of the frame). Among the gases and liquids he is 12×
(47 cm, about 10% of the frame): at 5× he was a 12 px speck against the busy
layers. He shrinks back to 5× as he falls through the last door, and keeps that
while the dark grows round him. Each zoom grows the walls 40–100× around him,
so he still gets relatively smaller: that is the descent. At the core, the zoom
goes into him and the child instead, so the hug fills the frame.

**Every way down is a trap door, and every door is found by letting go.** He
cannot fight his way out of the gas or the liquid. Only when he calms down
and accepts where he is do the gas or the paint relax, and the relaxing
reveals the door to the next layer.

## Beats

| # | Time (s) | Int. | Scale | Picture | Sound (positional) | Acting |
|---|---|---|---|---|---|---|
| 1 | 0–7 | 2 | 1 | **The composed man.** A 1950s suit and hat, standing in the bell jar. A 4 cm glow hides at his breast pocket, easy to miss. | **The tune:** a celesta and muted-clarinet waltz in a minor key over a low tritone pedal. Light and ominous. **Heartbeat:** 66 bpm at his chest, soft. | He breathes, his weight settles, he straightens his tie and checks his watch. His smile holds a beat too long. **Traveller:** he climbs out of the pocket onto the man's shirt, small and curious. |
| 2 | 7–12 | 3→5 | 1→100 (he grows with it to 5×, then stays that size on screen) | **Going in.** He finds a trap door between two shirt buttons and lifts it. Light spills out and he drops through. The chest fills the frame, and we pass through the shirt into a ribbed torso cavity full of coloured haze. | The tune slows and bends flat, as if the tape is stretching. The heartbeat swells as we reach it and speeds up (66 → 100). Gas hiss rises from the centre. | **Man:** his hand drifts to his chest, a held breath, and he freezes. **Traveller:** he kneels, pulls the door up with his whole body, and drops through feet first, arms up. |
| 3 | 12–22 | 5→7 | 100 | **Gas: pulled every way at once.** Realistic gas: pastel billows (pink, mint, lilac, butter) that roil, curl and shear, with soft edges and wisps that stretch and tear. Each billow is a day-to-day demand that pulses in its own rhythm. When one pulses, a wisp reaches out, catches one of his limbs and pulls it toward it. He is stretched between two or three at once; as he frees one, the next one catches him. Every time he starts to dive, a billow rolls across his path and turns him round. | **Nagging, out of time:** each billow has its own voice from its own place: a buzz pattern, a two-note chime, a ticking, a kettle-like rise, a clatter. The voices stack up and get denser. Heartbeat racing (100 → 140). | He fights each pull. Between tugs he does the man's watch check, faster and faster, then straightens his tie in mid-air, as if putting himself back together were one more demand. |
| 4 | 22–27 | 7→3 | 100→4,000 | **Letting go of the day.** He stops fighting. He lets the wisps hold him, his arms fall open and he breathes out. The gas relaxes: the billows slow, thin and part, and the wisps let go one by one, revealing a trap door in the haze below him. He opens it and drops through, and the gas sweeps out past the camera as the paint rises from below. | The voices fall away one at a time. The heartbeat slows (140 → 90) and his long breath out is heard. The first low swell of the liquid arrives from below. | Held breath, then a long exhale: shoulders drop, hands open. He floats a beat, then reaches the door, lifts it and drops through feet first. |
| 5 | 27–35 | 8→10 (peak at 33) | 4,000 | **Liquid: pressed into who he's supposed to be.** Not slabs: thick, heavy waves of paint (maroon, cadmium orange, oxblood, plum) that roll, fold over and stretch into ropes, with slow, viscous crests that collapse under their own weight. As each wave rears up, its crest takes the man's silhouette, in his suit and hat, huge and composed: who he is supposed to be. The wave folds onto him and presses him into that outline. He struggles out, and the next wave presses him into it again (30 s, then 33 s, the peak). | **His "proper" tune, the waltz, huge, slowed and heavy,** pressing down from above. Sub-bass clamps land as each wave closes over him. The heartbeat pounds, then drowns under it at the peak. | He hides his face, curls small, tries to hold the man's pose (straight back, tie hand) and can't. Pressed into the pose, he breaks out of it, gasping. |
| 6 | 35–40 | 10→1 | 4,000→160,000 | **Acceptance.** At the bottom he stops fighting the mould and goes limp, and lets the paint hold him. The waves relax into a slow swell and part, revealing a trap door, small and black, at the bottom of the trough. He slips through it, and the paint sweeps past and is gone. | **A hard cut** at 37 s, on his surrender, to near silence: one high sine, barely there, and his breath. The heartbeat is gone. | He falls limp and slow, turning once. |
| 7 | 40–45 | 1→2 | 160,000 → ×10 into him | **The dark.** Black everywhere; he is the only light, lighting a small circle of floor. The world grows slowly round him so that, by the time he reaches the child, the two figures read. Then, at the edge of his light, a shape. | Near silence. A faint, uneven, sob-like breath (synthesized) from where the shape will be. | He gets up, holds his light out and steps carefully. He stops when he hears the child. **The child appears only as he reaches him:** hunched, knees up, face hidden, his shoulders heaving with sobs. |
| 8 | 45–55.5 | 3→1 (release) | ×2 → ×16 into the pair (×8.5 at 52.5 s, the feed's last motion sample; the climax swells after it to about half the frame) | **The hug, filling the frame.** The traveller kneels, reaches out, hesitates, and touches the child's shoulder. The child flinches, then turns into him. They hold on, and the sobs slow and settle. The traveller's light opens up to warm both of them. | **Heartbeat returns**, slowly, as the child's (48 → 60 bpm). **The tune returns transformed:** half tempo, now a lullaby in 3/4 on a music box and a soft pad. The tritone pedal resolves into an open fifth, and the dissonant note turns into a suspension that finally resolves. | The hug is a long hold that settles: the shoulders slow from sobbing to breathing, the traveller's chin comes to rest on the child's head, and their breathing syncs (about 10 s). |
| 9 | 55–60 | 1→2 | to 1 | **The way back.** The world zooms back out through the calmed layers, pausing on the still liquid and the settled gas, onto the man. His hand is on his chest and his eyes are closed. He exhales, straightens and is composed again (the loop). | The lullaby's last note becomes the waltz's first. Heartbeat at 66, now even. | **Man:** a deep breath out and his shoulders drop, then he straightens his tie (beat 1 again). |

## The heartbeat thread

It is one emitter voice whose position travels:

- his chest at 66 bpm,
- racing in the gas (100 → 140),
- slowing as he lets go of the gas (140 → 90),
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
