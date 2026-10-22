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

## Open for round 2

- **Contrast and caption chips.** The caption chip is still a blue-tinted
  dark glass from the earlier blue; retune it for blue-green, and check text
  contrast against the bottom of the gradient, where it turns amber.
- **How loud the edge is.** Burnt is the loudest edge. Tune spark density and
  flicker so the hologram stays calm when many are on screen, such as in a
  feed.
- **Gold versus the amber horizon.** Both are warm; the edge must still read
  where a hologram sits low on the screen, over the amber.
- **Type scale and sizes** across phone, desktop and headset, using the
  angular sizing in the [design-language concept](../concepts/design-language.md).
- **Glyph legibility.** Thin gold glyphs need checking for size, contrast and
  hit targets on touch, controller and hands.
- **Colours not chosen yet:** record red, the unresolved state, errors, and
  each person's identity hue, which must stay clear of the gold.
