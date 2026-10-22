# Design Direction

**Status:** Round 1 decided; round 2 in progress (items 1 to 3 decided), 2026-10-22. Step 3 of the design-language work:
[inventory](inventory/README.md), [principles](principles.md), visual
foundations, styleguide, then redesigned screens.
**Tool:** [HoloIM Direction Studio](https://claude.ai/artifact/F8R4gG6Csp3j9EXY9UsP5h),
where each choice below can be seen in a 3D room, on a desktop and on a phone.

Step 3 runs in rounds:

1. **Character** (decided): the mood and the edge's personality.
2. **Foundations** (in progress): exact colours and contrast, type scale, sizes across
   devices, edge parameters, motion timing.
3. **Stress test**: the hardest screens from the inventory, such as errors,
   AR in a bright room, recording, and legibility in a headset.
4. **Styleguide**: write it down, then redesign every inventoried screen.

## Round 1: the chosen mix

The principles fix a golden edge around every hologram. Round 1 chose its
character across five axes.

| Axis | Choice | What it means | Also tried |
| --- | --- | --- | --- |
| Ground | **Blue hour, blue-green horizon** | Deep blue-green at the top, warming through a muted grey to an amber horizon at the bottom | Night navy, cream paper; and the blues twilight violet, ink navy, Prussian, storm slate, lagoon, dusk horizon, Prussian horizon, lagoon horizon |
| Edge | **Burnt** | A torn, flickering gold edge, the closest to the concept art | Deckled paper with gold leaf; a smooth iridescent glass rim |
| Type | **Soft** | Fraunces for titles, Figtree for interface and captions | Outfit with Cormorant Garamond; Newsreader with Caveat handwriting |
| Controls | **Edge glyphs** | Thin gold glyphs that take their light from the edge; no buttons or pills | Printed small-caps words with a stamped dot; glass pebbles |
| Motion | **Sparks** | Embers drift off the edge and the glow flickers | Still; a slow breathing glow |

The blue was picked last, in a head-to-head between seven finalists.
Blue-green over Prussian trades a little contrast with the gold for a
colour that is less like every other tech product (and the current app),
and closer to the moodboard: blue-green outside, amber inside.

## Starting values

These are the studio's values, a starting point for round 2 rather than final
tokens.

**Colour**

| Role | Value |
| --- | --- |
| Ground, top | `#0c2228` |
| Ground, surface | `#1f4d55` |
| Ground gradient | `linear-gradient(180deg, #0c2228 0%, #17424a 48%, #575f5a 80%, #b8835e 100%)` |
| Text | `#fff6ea` |
| Muted text | `#bfd0cc` |
| Gold edge | `#ffc872` |
| Glow | `#ffb066` |
| Edge highlight | `#fff3cf` |

**Type:** Fraunces 600 for titles and the wordmark; Figtree 400 to 600 for
interface text, captions and timecode (tabular figures). Handwriting is
reserved for people's own marks (principle 7), so it has no place in the app's
type.

**Edge (burnt):** an irregular outline around a rounded rectangle (corner
radius 7% of the short side), displaced by low waves (3 to 9 per loop, about 2%
of the short side), finer tears (16 to 38 per loop, about 0.9%) and per-point
jitter (0.7%). It is drawn as three strokes: a blurred glow halo (6% wide), a
gold core (1.4%) and a thin cream highlight (0.4%). The same outline is used in
SVG, on canvas and in the 3D scene, so the edge is one object at every size.

**Controls (edge glyphs):** gold line icons with a soft glow, labels in
tracked uppercase, a thin gold ring around Play, and timecode in the title
face's italic. The always-there set is Play with "Paused · 0:08", Free and
Return.

**Motion (sparks):** embers rise and fade off the edge over 2 to 4 seconds
while the glow flickers gently; in 3D the warm light on the table flickers
with it. With reduced motion, the edge holds still.

## Design review of round 1

An independent design review (2026-10-22) checked the direction against the
principles, the [inventory](inventory/README.md) and the design-language
concept. Its main findings:

- **The amber horizon fails contrast where the controls sit.** Muted text
  drops below 4.5:1 from about 78% down the gradient, body text from about
  88%, and the gold edge and glyphs below the 3:1 non-text minimum from about
  90%. At the horizon, gold is 2.1:1. Phone controls, captions and recording
  states all sit in that band.
- **Gold and amber are 12° apart in hue,** so a hologram low on the screen
  loses its edge. A dark char band just outside the gold core (as real burnt
  paper has) restores it: gold on char is 11.3:1 and char on amber 5.3:1.
- **AR has no ground colour.** Over a white wall gold is 1.5:1, and glow
  disappears in bright rooms. Text needs a chip of at least 82% opacity. The
  inventory's AR captures use a synthetic room, so round 3 needs real-camera
  captures.
- **"No buttons or pills" must not drop the chip.** Text never floats bare in
  3D; the chip stays as the text container, retuned for blue-green.
- **Burnt is loud in a feed.** Sparks only on the focused hologram, a small
  global particle budget, flicker at or below 10% luminance and 1 Hz, none in
  VR peripheral vision, and never on real-surface lighting in AR.
- **Edge sizes need angular clamps.** As percentages, the tears vanish on
  small cards and the halo covers the glyphs on large ones.
- **Thin glyphs shimmer in a headset** and edge-hugging targets collide with
  phone gestures. Try a 2 px stroke and 20 to 24 px icons, with hit areas of
  24, 44, 56 or 72 angular px by input.
- **Warm hues are used up.** Gold, glow and horizon take every warm hue, so
  "open amber" can no longer mean unresolved, record red needs to lean to
  crimson on a chip, and identity hues must avoid both gold and blue-green.
- **Some principles are weakened:** a glowing halo is the outline principle 6
  warns against (light spilling onto the table may replace it); gold on
  everything stops meaning "hologram"; a constantly animated edge never hides;
  and the ground is defined as a CSS gradient before it is defined in 3D.
- **Timecode is defined twice** above (Figtree tabular, and the title face's
  italic); round 2 settles it.
- **The edge, sparks and ground belong to the view layer** and must never be
  baked into exported GLB. AR Quick Look can carry only a static edge.

## Round 2 agenda

In order, each compared in the studio:

1. **Ground in 3D first:** a sky dome with the horizon below eye level; the
   gradient with a darker horizon (`#7a5940` or `#6e5039`); the gradient
   pinned to the stage rather than the screen.
2. **Edge legibility:** a char band, a darker horizon, or both, judged on the
   amber, a white wall and a beige wall.
3. **Chip:** `#081a1e` at 85%, `#0c2228` at 82%, or walnut-tinted glass, with
   at least 4.5:1 over white.
4. **Angular clamps for the edge:** three clamp sets, at an 80 px thumbnail,
   a phone card, a tabletop slab and a doorway.
5. **Edge loudness:** sparks on focus only, a global particle budget, or a
   breathing glow with no particles; measure frame time on a mid-range phone
   and on Quest.
6. **Glyphs:** 1.5 or 2 px stroke, with or without glow, with or without a
   chip; hit-target overlays per input on the capture VR panel and phone
   portal.
7. **Semantic colours:** record red `#ff3b5c` or `#e5484d` on a chip;
   unresolved as a hollow shape, an unlit gap in the edge, or a cool signal
   hue; an identity set of 5 to 6 hues or 8.
8. **Type scale:** Figtree or Fraunces italic for timecode; tracked uppercase
   or sentence-case labels; headset legibility scale 2× or 2.5×.
9. **Motion:** flicker amplitude and rate, the reduced-motion version, and
   whether the edge dims while recording.

Sections 2 and 3 of the [design-language concept](../concepts/design-language.md)
still describe neutral chrome and open amber; the styleguide (round 4)
replaces them.

## Round 2 decisions

Each item was compared in the studio's Round 2 tab. A design review
checked each batch before the user decided. Decisions are also stored in the
studio's `decisions` collection (`r2-1` to `r2-9`). Contrast is WCAG 2.x,
recomputed by the studio. The studio's char `#1f140c` gives 11.8:1 gold on char
and 5.5:1 char on amber, slightly above the review's 11.3 and 5.3.

### Batch 1 (2026-10-22): ground, edge, chip

| # | Item | Decision | Also compared |
| --- | --- | --- | --- |
| 1 | Ground | **Screen gradient, amber horizon** on flat screens, as in round 1. **In VR and AR the ground is not painted:** the hologram is pinned to its stage and lit by its own gold light on the surface. | A sky dome with the horizon 6° below eye level; a horizon pinned to each card's stage; umber `#7a5940` and deep umber `#6e5039` horizons |
| 2 | Edge legibility | **Gold only.** No char band: "a char looks horrible". Other ways to keep the edge visible low on the screen are still open. | Thin char (0.6% of the short side) and wide char (1.2%), `#1f140c` |
| 3 | Chip | **Deep sea by room, flat:** `#081a1e` at 72% in VR and 88% in AR, with no blur or rim | Round 1 chip; deep sea 85%; ground `#0c2228` 82%; walnut `#2b1d14` 84%; a glass material (blur and warm rim) |

**Exact values**

| Token | Value |
| --- | --- |
| Flat ground (phone and desktop) | `linear-gradient(180deg, #0c2228 0%, #17424a 48%, #575f5a 80%, #b8835e 100%)`, pinned to the screen |
| XR ground | None painted. VR keeps the blue-hour room; AR is the camera image. Warmth comes from the hologram's gold light falling on its stage. |
| Edge | Round 1 burnt edge unchanged: halo 6% of the short side in `#ffb066` at 50%, blurred; gold core `#ffc872` 1.4%, softly blurred; highlight `#fff3cf` 0.4% |
| Chip, VR | `rgba(8, 26, 30, 0.72)` |
| Chip, AR | `rgba(8, 26, 30, 0.88)` |
| Chip material | Flat: no backdrop blur, no rim |

**What these decisions leave open.** Keeping the round 1 ground and edge
keeps the problems the review found. Later items and round 3 have to solve
them without a darker horizon or a char band.

- **The bottom of a flat screen is not safe for chrome.** On the gradient,
  muted text drops below 4.5:1 from 75% down the screen, gold labels from
  77%, body text from 89%, and gold shapes below 3:1 from 90%. At the bottom
  edge, text is 3.0:1, muted 2.0:1 and gold 2.1:1. Fixed chrome in the
  bottom quarter needs the chip, which is item 6's question (glyphs with or
  without a chip). Scrolling text crosses that band too, so feed captions and
  timecode need the chip or must stay out of it.
- **The edge fades into the horizon.** Gold on amber is 2.1:1, and 1.8:1
  next to the edge where the glow halo lightens the amber. A hologram low on
  the screen loses its edge. Alternatives to char are still to be found:
  for example, a darker halo instead of a warm one at the horizon, keeping
  holograms out of the bottom band, or a horizon that recedes when a
  hologram nears it. Round 3 tests this on the hardest screens.
- **The chip holds in sRGB but not fully in linear light.** Over white, as a
  browser blends, the AR chip gives text 11.9:1, muted 7.9:1, gold labels
  8.3:1 and record red `#ff3b5c` 3.7:1. If a target blends in linear light
  (some XR compositors, possibly AR Quick Look), the same chip gives text
  5.5:1, muted 3.7:1, gold labels 3.9:1 and red 1.7:1. Round 3 has to check
  which way each target blends; item 7 picks the red with this in mind.
- **Pinned to the stage in XR** turns item 1's 2D question into a 3D one:
  the warm light a hologram casts on its surface must stay within item 5's
  limits (never flicker on real surfaces in AR).
