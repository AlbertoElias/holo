# Design Principles

**Status:** Draft, 2026-10-21. Step 2 of the design-language work: inventory,
principles, visual foundations, styleguide, then redesigned screens.
**Lens:** [what a hologram is](../concepts/what-a-hologram-is.md). A hologram
is a recorded event, viewed through a portal on flat screens.
**Sources:** the [HoloIM Moodboard](https://claude.ai/artifact/6ofHzWfmFmQTiQXBryNfMU)
([plain copy](../research/moodboard.md)), mainly the user's hologram concept
art and the two syntheses, "The golden wrapper" and "What your pins agree on";
the [design-language concept](../concepts/design-language.md); and the golden
wrapper and design options IDEA-071 to IDEA-075 in the [idea registry](../IDEAS.md).

These principles hold whichever design option wins. Options A to D (IDEA-072
to IDEA-075) compete over where controls live and what the inbox is; every
one of them must pass all seven principles. Card names in quotes are moodboard
cards.

## 1. A hologram is an event you look into, not a video you watch

**Why:** The product is a moment that happened in a place, and the viewer
chooses where to stand in it. Video habits like a full-bleed player, autoplay
and endless scrolling turn it back into a clip and throw away the reason it
exists.

- **Do:** Show a hologram as a place with someone in it, waiting to be looked
  into. In "Why does the shadow miss?", a slab of another place sits on the
  table and asks a question.
- **Don't:** Build TikTok in 3D. A vertical feed of autoplaying holograms
  ("TikTok", in Avoid) or a play bar laid over a flat frame is a video app
  in disguise.

## 2. One golden edge, at every size

**Why:** The golden wrapper is the brand. It is an irregular, torn-paper edge
of warm gold light around a slice of another place. Because it is the same
object on a phone card, on a table and as a life-size doorway, people
recognize a hologram at any scale. It sits on real surfaces and lights them,
so it belongs to the room it is in.

- **Do:** Keep one edge and let it change shape: a slab with thickness
  ("Counterweight"), a doorway ("Last light out."), a cloak around a body ("I
  wore my worst jump"), a bubble ("A pocket of light"). The same kitchen keeps
  the same edge on a phone and in a doorway ("This is the entire kitchen.").
- **Don't:** Give the hologram a second frame or look. The blue scanline
  hologram ("Star Wars Hologram", which Joi in "Blade Runner 2049" rejects) or
  a plain rectangle around the scene loses the identity. Anything else that is
  distinctive, such as a signature control, takes its light from the edge's
  gold and never competes with it.

## 3. Design in 3D, then compress to 2D

**Why:** The hologram is three-dimensional, so the space is the design and
flat screens are a projection of it. A design drawn as a flat card first
never becomes a believable object when it is put in a room.

- **Do:** Design each element as an object in space, then derive its flat
  form. The wrapper becomes deckled paper on cream ("Room for you", "A piece of
  elsewhere"); a scene rises from a page like a pop-up ("Kirigami"); the
  phone looks into a small world on its stage ("Ours: the hologram on a
  phone").
- **Don't:** Start from a phone screen of cards, tabs and pill buttons and
  then extrude it into XR. That is how capture ended up with desktop status
  cards and a head-locked "Start Recording" pill.

## 4. Viewpoints are the main interaction

**Why:** What only a hologram can do is let the viewer choose where to stand.
Changing the angle is often the point of the message: the second view is the
punchline or the answer. The author suggests viewpoints and the viewer moves
freely; nobody dictates the camera (Follow or Free).

- **Do:** Show another angle as a small golden portal in the scene. In
  "Finally taller than you.", "A little to the side" reveals that one friend
  is standing on books; in "Rooftop's ready", "From the seat" shows where the
  sender wants you to sit. Time can use the same language: in "Memory Loom",
  gold threads lead from a bowl to earlier moments.
- **Don't:** Use a rectangular inset with a scrubber ("Stand where I stood
  (rectangle inset)", "How did they see me?"). It reads as a picture-in-picture
  video player and breaks the wrapper's language.

## 5. The interface hides until you reach for it, and is unmistakable when it comes

**Why:** The people and the place should fill the view. Controls appear when
they are wanted, from where the hand or cursor is, and leave afterwards. When
they appear they must feel like HoloIM and nothing else. Hiding is not the
same as being hard to find, the lesson of "Magic Leap Lumin OS", which was
sometimes too minimal.

- **Do:** Show real wood that reveals a display only when touched ("mui
  Board"); let the world itself point the way ("Ghost of Tsushima: the guiding
  wind"); keep chrome to almost nothing until you reach for it ("Tiny Glade").
  Keep a few always-there controls, such as Play, Free and Return, small and
  close to the edge.
- **Don't:** Talk about the system ("Capture Runtime", "READY", "DESKTOP"), fill
  the view with keyboard help, or ask people to wave their arms at a gesture
  wall ("Minority Report", in Avoid). A generic blue play button or pill
  button hides nothing and is not distinctive.

## 6. Warm light inside, blue hour outside

**Why:** The user's boards agree on one mood: a navy, blue-hour ground with
warm amber light from inside, and homey materials (walnut, cream fabric,
brass, clear glass, small warm lamps). That combination is cozy and elegant,
not clinical sci-fi. Light is a material that falls on things and fades to
dark, not a glowing outline.

- **Do:** Light the hologram from within and let the light spill onto the
  surface around it ("Counterweight", "Pavilion over a pond at dusk"). Take
  surfaces from the furniture palette ("Walnut cart with a mushroom lamp") and
  frames from round windows and Art Nouveau curves ("Library with round
  windows into the forest", "Art Nouveau glass house by a lake"). Judge every
  color against what is behind it ("Josef Albers").
- **Don't:** Use cool, neutral, thin emissive lines or frosted-glass panels
  (looks A and C in the design-language concept), cyan holograms, or bright
  white screens. Don't overgrow the interface either: vines on everything is
  a warning in "The aesthetics of solarpunk worlds".

## 7. People's marks are handwritten; the app's never are

**Why:** The viewer must always be able to tell what a person said from what
the app shows, and what was recorded from what was inferred or added later.
Handwriting is the human mark layer, so only people get to use it.

- **Do:** Pin handwritten notes into the scene at what they refer to: the
  "This side" arrow at a monitor dock ("This is where it plugs in."), the "not
  attached yet" tag on a half-built joint ("I stopped at this joint."). Marks
  are in the author's own hue and replay with their original timing.
- **Don't:** Set app labels, buttons or onboarding in a handwriting face, or
  give a person's note the same look as a system message. Don't give a
  mark gold chrome or put it in a box locked to the screen; it is tied to a
  body part, an object, a place or a moment in the event.

## What changes from the earlier model

The [design-language concept](../concepts/design-language.md) and
[PRD-021](../prds/PRD-021-design-language.md) still hold for:

- The three materials and their layers: Presence shows the event, Ink shows
  meaning, Light is the view's chrome. Chrome never looks like an authored
  mark, and marks never look like chrome (principle 7).
- No interactive UI is locked to the head; everything comes out of its source
  and goes back there; parity of capability across devices, with a native
  idiom on each.
- Angular units, per-input target sizes and the design tests.

The moodboard replaces:

- **The cool look.** Look A (Light), the recommended one, used neutral, thin,
  emissive lines; Look C (Glass) used frosted panels. Chrome now takes the
  wrapper's warm gold on a navy ground (principles 2 and 6). Look B's paper
  and card return only as the compressed 2D form of the wrapper (principle 3).
- **Atkinson Hyperlegible as the one family.** The concept art uses two
  voices: a geometric sans for UI and a serif for titles and captions, with
  handwriting kept for people's marks. The legibility requirement behind
  Atkinson still applies: the styleguide must test the chosen sans at headset
  resolution.
- **Amber as a reserved signal.** "Open amber" for unresolved items cannot
  stay a special color when warm amber is the interior light of everything.
  The styleguide needs a different signal for unresolved items; record red is
  not affected.

## The test

Before a screen or element ships, check:

1. Does it show an event to look into, rather than a video to watch?
2. Does the golden edge stay the only signature, at this size and on this
   device?
3. Was it designed as an object in space, with this flat form derived from it?
4. Can the viewer change where they stand, and are other viewpoints golden
   portals?
5. Is it hidden until reached for, and recognizably HoloIM when it appears?
6. Is the light warm and inside, the ground blue hour, the materials homey?
7. Can a viewer tell people's marks from the app's chrome at a glance?
