# Design Direction

**Status:** Round 1 decided, 2026-10-22. Step 3 of the design-language work:
[inventory](inventory/README.md), [principles](principles.md), visual
foundations, styleguide, then redesigned screens.
**Tool:** [HoloIM Direction Studio](https://claude.ai/artifact/F8R4gG6Csp3j9EXY9UsP5h),
where each choice below can be seen in a 3D room, on a desktop and on a phone.

Step 3 runs in rounds:

1. **Character** (decided): the mood and the edge's personality.
2. **Foundations**: exact colours and contrast, type scale, sizes across
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
