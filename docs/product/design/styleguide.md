# HoloIM Styleguide

**Status:** Decided, 2026-10-24. Round 4 of the design-language work:
[inventory](inventory/README.md), [principles](principles.md),
[direction](direction.md) (rounds 1 to 3), this styleguide, then the
redesigned screens.
**Applies to:** `apps/capture` and `apps/viewer-web`, in 3D (VR and AR, with
hands and controllers) and on flat screens (phone and desktop, with touch and
mouse).
**Tokens:** [tokens.json](tokens.json) holds the values below in W3C Design
Tokens format for later builds. This page wins where the two differ.
**Visual page:** [HoloIM Styleguide](https://claude.ai/artifact/HKRiYc7vVwX1C1QWXf1hhC)
draws these values live, and holds the round 4 answers.
**Replaces:** sections 2, 3 and 8 of the
[design-language concept](../concepts/design-language.md) (the neutral Light
look, Atkinson, open amber, the three looks) and the visual-direction parts
of [PRD-021](../prds/PRD-021-design-language.md). What still holds from the
concept is carried into this page and marked.
**Tool:** the [HoloIM Direction Studio](https://claude.ai/artifact/F8R4gG6Csp3j9EXY9UsP5h)
shows each value in a 3D room, on a desktop and on a phone.

A hologram is a recorded event, seen through a golden-edged portal. Everything
here serves that one object: a slice of another place, wrapped in a torn gold
edge, on a blue-hour ground, with a few gold glyphs at its foot.

## How to read this

- **3D first.** Each part is defined as an object in space, then compressed
  to flat screens (principle 3). Where a value differs per target, VR and AR
  come before phone and desktop.
- **Later rounds win.** Values come from [direction.md](direction.md), and a
  later round overrides an earlier one. For example, round 3 item 8 reverses
  round 2 item 9 in headsets, and round 3 item 9 replaces round 2's sparks
  everywhere. Sources are cited as `r<round>-<item>`; "r3 close" is the
  decisions taken from round 3's device results. "r4" marks a choice the
  user made on the visual page on 2026-10-24, from options it previewed.
- **Markers.** Every value without a marker was decided in rounds 1 to 3.
  - **Unverified:** decided, but a device check is missing. Build to the
    value and keep the check open. Most come from round 3's known gaps; those
    added by this styleguide say so.
  - **As drawn:** the studio drew it this way in the screens the user judged,
    but it was never compared against alternatives. Build to it; it may be
    revisited.
  - **Carried:** kept from the design-language concept, which the principles
    say still holds for it, but never compared in the studio.
  - **Open:** the rounds left it undecided. Do not pick a value in a build.
    [Section 11](#11-unverified-and-open-in-one-place) lists them all.
- **Units.** Sizes are in angular px (apx): one CSS reference pixel, about
  0.0213° of view, so a number means the same apparent size on every display.
  On a flat screen 1 apx is 1 CSS px. A Quest 3 shows about 0.53 headset
  pixels per apx. "The short side" is the hologram's shorter visible side.

```txt
size_m = apx × 0.000372 × distance_m × scale
```

`scale` is 2.5 for type and icons in a headset and 1 everywhere else
(r2-8, r3-10). Hit targets are never scaled; they are set per input
([section 6.1](#61-hit-sizes-per-input)).

## 1. The hologram as an object

In a room, a hologram is a slab of another place standing on a real or
virtual surface. It is wrapped in one golden edge, lit from within, and casts
warm gold light onto the surface at its foot (r2-1). Its few controls sit at
that foot. Nothing about it is locked to the head.

On a flat screen the same object is compressed. The slab becomes a portal
card, a 3D world seen through the screen with its own stage light. The room
becomes the blue-hour gradient. A soft dark shade at the card's foot holds
its controls, so they read against the gradient (r3-1).

| Part | In a room (VR, AR) | On a flat screen (phone, desktop) |
| --- | --- | --- |
| The picture | A 3D slab, tabletop to doorway size | A portal card |
| The edge | The burnt gold edge around the slab | The same edge, same outline, around the card |
| Around it | The VR room, or the camera image in AR | The blue-hour gradient, pinned to the screen |
| At its foot | Warm gold light on the surface | A soft dark shade under the card |
| Its controls | Glyphs at the stage base, on the chip where needed | Glyphs in the shade |
| Sparks | Only on the hologram in focus | Only on the card nearest the middle |

The edge, sparks, shade, light and ground belong to the view layer. They are
never baked into an exported GLB (round 1 review).

### 1.1 Three materials

**Carried** from the design-language concept, which the principles keep:
each layer of a hologram has its own material.

| Material | Layer | Look in this styleguide |
| --- | --- | --- |
| **Presence** | The event: people, voices, attention | The recording itself; each person's identity hue as a rim on their avatar |
| **Ink** | The meaning: marks, notes, symbols | In the author's identity hue, with their initial; never gold |
| **Light** | The view's chrome: controls, status | Gold glyphs, Fraunces and Figtree, on the shade or the chip |

- Prominence: ink first, then people, then chrome.
- Chrome never uses an identity hue, and marks never look like chrome
  (principle 7).
- A mark's reveal is part of the message: it replays with its original
  timing (principle 7).
- A mark that holds text (a note) sits on a **tinted slip** (r4): a dark
  slip tinted toward the author's hue, with the author's mark and name in
  their hue. As drawn, the tint is `color-mix(in srgb, <hue> 22%, #081a1e)`
  with cream text. It never looks like the chrome's chip.

### 1.2 Where things live

No interactive UI is locked to the head, and everything comes out of its
source and goes back there. This is the concept's placement model
(**carried**) with the round 3 rules applied; only the look changes.

| In 3D | On a flat screen | What goes there |
| --- | --- | --- |
| Stage base (at the hologram's foot) | The shade under the card | Play, Free, Return, timecode, caption; later the time ribbon and layers |
| Non-dominant hand (palm, wrist) | Bottom dock (thumb zone on a phone) | Record, ink, undo. Glyphs only in a headset: it is within reach |
| Point of action (fingertip, ray hit, gaze) | Cursor or touch point | Menus that bloom from the hand, ink |
| Referent (the mark or bone being edited) | Popover pinned to the object's screen position | Editing a mark |
| Periphery (lazy-follow, upper edge of view) | Top status line | State only, such as "Recording 0:12"; never controls |
| World (placed by the user, 1 m away or more) | Side sheet | Labels for near panels, long text, library, inbox, settings |

The periphery status line is the one thing that follows the head, lazily,
and it never holds a control.

**Always there, and hidden until reached for.** Play, Free and Return stay
visible, small and close to the edge (principle 5). Every other control
appears from the hand or cursor and leaves afterwards. When nobody has used
the always-there set for 4 s, it dims to 40%; it comes back to full strength
when a hand, cursor or gaze comes near (r4).

## 2. Tokens

### 2.1 Core colours

| Token | Value | Use |
| --- | --- | --- |
| `ground.top` | `#0c2228` | Deep blue-green, top of the flat ground |
| `ground.mid` | `#17424a` | Mid gradient stop; the reference for identity contrast |
| `ground.grey` | `#575f5a` | Gradient stop at 80% |
| `ground.horizon` | `#b8835e` | Amber horizon at the bottom edge |
| `deepSea` | `#081a1e` | Chip, shade, soot, author initials |
| `text` | `#fff6ea` | Body text, cream |
| `textMuted` | `#bfd0cc` | Timecode, bylines, secondary text |
| `gold` | `#ffc872` | The edge's core, glyphs, control labels, sparks |
| `glow` | `#ffb066` | The edge's warm halo, stage light |
| `highlight` | `#fff3cf` | The edge's thin cream highlight |
| `record` | `#ff3b5c` | Record red (rose): the recording state only, and (as drawn) the idle record control |

Gold is the hologram's colour. Use it for the edge and the glyphs that take
their light from it, and nowhere else (principle 2): never a surface fill, a
banner or a selection colour.

There is no error colour. Errors are cream text with a gold action ("Try
again") on the shade or the chip: 12.75:1 and 8.62:1 (r3-1).

Round 1's "ground, surface" `#1f4d55` was a starting value that no later
round confirmed, and the chip is the only container, so it has no role here.

### 2.2 Ground per target

| Target | Ground | Source |
| --- | --- | --- |
| VR | Not painted. The blue-hour room; each hologram is pinned to its stage and lit by its own gold light on the surface | r2-1 |
| AR (WebXR, Quick Look) | Not painted. The camera image; warmth comes only from the hologram's light on the real surface | r2-1 |
| Phone and desktop | `linear-gradient(180deg, #0c2228 0%, #17424a 48%, #575f5a 80%, #b8835e 100%)`, pinned to the screen, not the page | r1, r2-1 |

**The bottom band.** On the bare gradient, muted text drops below 4.5:1 from
75% down the screen, gold labels from 77%, body text from 89%, and gold
shapes below 3:1 from 90%. At the very bottom, text is 3.0:1, muted 2.0:1 and
gold 2.1:1 (r2 batch 1). Nothing sits bare from 75% down (r3-1): it goes in
a hologram's shade or on the chip ([section 5](#5-shade-and-chip)).

### 2.3 The chip per target and blend mode

The chip is the one text container: flat `#081a1e`, with no backdrop blur
and no rim (r2-3). Its opacity depends on how the target composites
translucency.

| Target | Blends in | Chip | Status |
| --- | --- | --- | --- |
| VR, Quest Browser | sRGB (documented) | 72% (r2-3) | **Unverified**, added by this styleguide: documented, not measured on the Quest |
| AR, Quest passthrough | Not measured | 97% (r3 close) | Set by eye: the lowest that read cleanly, in two sessions. **Unverified:** blending was inconclusive; the one clean pair leaned sRGB |
| AR, Android Chrome (ARCore) | sRGB (assumed) | 88% (r3-7) | **Unverified:** no Android device; 88% rests on the documented sRGB assumption |
| AR, a target that blends in linear light | Linear | 92% (r3-7) | |
| AR Quick Look (iOS) | Linear (documented in part) | None possible | Quick Look shows only the USDZ. **Unverified:** its blending; the iPhone screenshot showed nothing to measure |
| Phone and desktop (DOM, WebGL) | sRGB (measured on Mac Chromium) | 72% | **As drawn:** the studio's flat notices use the VR value |

The chip is never opaque in AR (r3-7). **Open:** a target not listed here.
r3-7 has a value only for known blending; until one is measured, 92% (the
linear value) is the cautious reading.

**Over a hologram's own picture** on a flat screen, the chip stays 72% (r4).
Text there always takes the chip (r3-5). Over a pure white picture this gives
muted text 4.46:1, just under 4.5:1, gold 4.68:1 and record red 2.05:1; the
user accepted that. Red over a picture therefore never goes without its
shape and word.

**Shape (as drawn):** corner radius 18 apx, padding 5 × 14 apx. A chip that
holds a control row is padded 3 apx at the top, bottom and start and 14 apx
at the end, so the Play ring sits flush at its start. Headset values are
2.5× these.

### 2.4 Identity hues

Each person has one identity hue for their avatar rim and everything they
author. Eight hues, chroma 0.12, kept clear of record red, the golds, the
horizon and the ground hue; each is at least 3:1 on `#17424a` (r2-7).

| # | Name | Hex | OKLCH |
| --- | --- | --- | --- |
| 1 | Deep lime | `#a9b355` | `oklch(0.74 0.12 114.5)` |
| 2 | Deep lime 2 | `#8c8b26` | `oklch(0.62 0.12 109.0)` |
| 3 | Deep mint | `#58c295` | `oklch(0.74 0.12 163.0)` |
| 4 | Pale sky | `#96d3ff` | `oklch(0.84 0.12 240.5)` |
| 5 | Deep blue | `#7496e3` | `oklch(0.68 0.12 265.0)` |
| 6 | Pale sky 2 | `#7fbcfd` | `oklch(0.78 0.12 250.5)` |
| 7 | Deep pink | `#b670ad` | `oklch(0.64 0.12 331.5)` |
| 8 | Deep pink 2 | `#cc81bc` | `oklch(0.70 0.12 335.0)` |

The closest pair is ΔE 6.0 (OKLab × 100) for normal vision, 5.7 red-blind,
6.0 green-blind and 4.6 blue-blind. Because hue alone can be lost, **every
author mark carries the author's initial** (r3-3): Figtree 600, 10 px,
`#081a1e` on a filled mark, the author's hue on a hollow one. Marks sit bare,
with no ring, even at the horizon (r3-3).

### 2.5 Record red

Rose `#ff3b5c`, with no keyline or ring of its own (r2-7, r3-6). Red never
carries the state alone:

- Where controls sit on the bare ground it is 1.2:1 (desktop control row)
  and 1.1:1 (lowest phone controls).
- On the 88% AR chip it is 3.7:1 over white in sRGB, and 1.7 to 1.8:1 if the
  target blends in linear light (r2 batch 3). The 92% linear chip was not
  measured for red.
- It is ΔE 2.2 from the bottom edge for green-blind viewers, and ΔE 0.3 at
  89% down for red-blind viewers (r3 corrections).

The shape and the word carry recording ([section 8.5](#85-recording)).

### 2.6 The unresolved mark

Hollow (r2-7): an unresolved mark, such as an open question or an open
thread, is an outline in the author's identity hue, with the initial in the
same hue. It fills in, with a `#081a1e` initial, once resolved. As drawn, the
outline is 2.5 apx at an 18 apx mark. Amber is no longer a signal: it is the
interior light of everything (principles, "What changes").

## 3. The golden edge

One edge, at every size, on every target (principle 2). It is the same
outline in SVG, on canvas and in the 3D scene (r1).

### 3.1 Burnt geometry

An irregular outline around a rounded rectangle (r1, r2-4).

| Token | Value (share of the short side) |
| --- | --- |
| Corner radius | 7% |
| Waves | 3 to 9 per loop, amplitude about 2% |
| Tears | 16 to 38 per loop, amplitude about 0.9% |
| Jitter | 0.7% per point |
| Inset | The larger of 6% and the halo width, so the glow is never clipped square |

As drawn: the outline is sampled at 280 points per loop and seeded per
hologram, so one hologram keeps the same tears wherever it appears.

### 3.2 Strokes and soot

| Stroke | Width (short side) | Colour | Notes |
| --- | --- | --- | --- |
| Halo | 6% | `#ffb066`, level 0.50 | Blurred, standard deviation half the halo width; flickers ([section 8](#8-motion)) |
| Gold core | 1.4% | `#ffc872` | Softly blurred |
| Highlight | 0.4% | `#fff3cf` | |
| Soot halo | 6% | `#081a1e` | Same width and blur as the halo; replaces it where the ground is light; never flickers |

**Halo level.** Halo opacity is given as a level, where 0.50 is its resting
value on a flat screen. As drawn, the 3D halo material's opacity is
`min(1, 0.9 × level / 0.5)`, so it rests at 0.9. This is why round 2 gives
the room halo as 0.15 while recording "(0.9 normally)".

**Soot (r3-2).** Gold on amber is 2.1:1, and 1.8:1 beside the edge where the
warm halo lightens the amber. Where the ground behind the edge is light, the
warm halo crossfades into a dark soot halo of the same shape:

```txt
t = clamp((L − 0.095) / (0.16 − 0.095), 0, 1)   L: relative luminance of the ground behind the edge
glow halo opacity = level × (1 − t)              only this part flickers
soot halo opacity = soot × t                     soot: 0.6 on flat screens, 1 in AR
```

`t` is 0 (all glow) at about 75% down the gradient and 1 (all soot) at about
88% down. AR has no ground luminance behind the edge, so there `t` is 1 when
the lighting estimate says the room is bright and 0 otherwise: the soot
replaces the glow outright.

| Where | Gold only | With soot | With soot, linear blending |
| --- | --- | --- | --- |
| Phone feed, a hologram ending at the bottom | 1.9:1 | 4.2:1 | same (browser) |
| Desktop, a hologram ending at 90% | 2.2:1 | 5.0:1 | same (browser) |
| Phone, a hologram ending at 80% | 2.8:1 | 3.4:1 | same (browser) |
| AR, white wall `#f2f0eb` | 1.2:1 | 3.3:1 | 1.7:1 |
| AR, beige wall `#d8c6a8` | 1.1:1 | 4.3:1 | 2.4:1 |

Per target:

- **Flat screens:** soot 0.6, by the luminance rule above.
- **AR:** soot 1, and only when the WebXR lighting estimate says the room is
  bright. Only Android Chrome gives an estimate, so on Quest the edge stays
  gold only. **Unverified:** soot in a bright room was never seen on a device
  (no Android device). **Open:** the brightness threshold, to be set on an
  Android device.
- **VR:** **Open.** r3-2 gave flat and AR values only; the VR room was not
  compared.
- **AR Quick Look:** none ([section 9.5](#95-ar-quick-look-ios)).

### 3.3 Sizes

Every part of the edge is a share of the short side at every size, with no
angular floor or cap (r2-4, r3-4). At the four studio sizes (apx):

| Size | Gold core | Halo | Highlight | Tear depth (deepest) |
| --- | --- | --- | --- | --- |
| 80 px thumbnail (80 × 64) | 0.9 | 3.8 | 0.3 | 0.6 (0.8) |
| Phone card (300 × 240) | 3.4 | 14.4 | 1.0 | 2.2 (3.1) |
| Tabletop slab, 0.62 × 0.74 m at 1.5 m | 15.4 (8.2 Quest px) | 65.8 | 4.4 | 9.9 (14.2) |
| Doorway, 0.9 × 2 m at 1.5 m | 22.0 (11.7 Quest px) | 94.1 | 6.3 | 14.1 (20.3) |

What this accepts, as decided: on a thumbnail the tears are below one device
pixel, so the edge reads as a smooth gold line. On a doorway the halo is
about 94 apx wide, so glyphs at its foot sit inside the glow.

## 4. Viewpoints, scale and provenance

The edge's language extends to other viewpoints (principle 4) and the
hologram's facts (what a hologram is, principles 6 and 7). The rounds did
not compare any of these looks:

- **Open:** viewpoint portals. Another angle is a small golden portal in the
  scene (principle 4), but at that size the edge reads as a smooth line
  (section 3.3).
- **Open:** the rescale indicator. Rescaling must be visible, labelled and
  reversible.
- **Open:** how recorded, inferred (read from the body) and added marks look
  apart. It must not collide with hollow, which means unresolved.

## 5. Shade and chip

### 5.1 The shade at a hologram's foot

On flat screens every hologram casts a soft dark shade at its foot, and its
controls and caption sit in it (r3-1). The shade moves with its card.

```css
background: radial-gradient(closest-side,
  rgba(8,26,30,.7), rgba(8,26,30,.5) 60%, rgba(8,26,30,0));
```

r3-1 gives its width as 120% of the hologram's. As drawn, it starts just
above the card's foot (90 to 95% of the way down the card) and is about
120 px tall on a desktop and 24% of the screen's height on a phone.

Measured at the shade's rim behind the outermost label (about 45% of its
radius): phone labels and glyphs 6.17 to 8.63:1; phone timecode (muted)
5.88 to 8.23:1; desktop labels 5.43 to 8.03:1; feed timecode crossing the
band 4.75 to 7.37:1; caption 10.08 to 12.99:1. Keep every label inside that
rim: further out is outside the measured range.

### 5.2 Where the chip is mandatory

Only where the ground fails (r3-5):

| Target | Rule |
| --- | --- |
| VR | Rows stay bare against the room's walls. They take the chip in front of the sky, a hologram or a lit surface (bare gold in front of the VR sky is 4.1:1, muted 3.9:1). Hysteresis: the chip fades in over 0.3 s and holds at least 2 s |
| AR (WebXR) | Every row and every label sits on the chip |
| AR Quick Look | No chip is possible, so no text or controls inside Quick Look |
| Phone and desktop | Controls and captions sit in their hologram's shade. Feed-wide notices, which have no hologram (empty feed, offline, upload status), use the chip. The bottom dock sits on a shade along the bottom of the screen, the same soft shade a hologram casts (r4) |
| Everywhere | Text over a hologram's own picture always sits on the chip |

The round 1 review asked that text never float bare in 3D. r3-5 overrides
it in VR: rows may stay bare against a dark wall, and take the chip, with the
fade and hold above, when the background behind them fails.

## 6. Glyph controls

Thin gold line glyphs that take their light from the edge; no buttons or
pills (r1). Three are always there (principle 5): **Play**, **Free** and
**Return**. The drawings, the ring sizes and the record shapes below are as
drawn in the studio.

| Glyph | Meaning | Label | Drawing (16 × 16 viewBox) |
| --- | --- | --- | --- |
| Play / Pause | Play or pause the event | "Paused · 0:08" beside it | Filled triangle `M4 2.5v11l9-5.5z`, drawn at 14 apx inside the 36 apx gold ring |
| Free | Leave Follow; move through time and space yourself | "Free" | Four-way arrow cross `M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2` |
| Return | Back to the author's view (Follow) | "Return" | Open arc with an arrowhead `M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5` |
| Record | Start or stop a take (capture) | "Recording 0:12" while recording | Inside the 36 apx gold ring: a 14 apx filled rose circle when idle; a 13 apx rose rounded square (radius 3 apx) while recording |

r3-6's "no ring" means no keyline around the rose dot itself (it rejected a
cream ring); the gold control ring around it is the same as Play's. The Play
triangle and the record shapes are filled; every other glyph is a line.

| Token | Flat | Headset (2.5×) | Source |
| --- | --- | --- | --- |
| Stroke | 1.5 apx (round caps, as drawn) | 3.75 apx (about 2.0 Quest px) | r2-6, r2-8 |
| Icon | 16 apx | 40 apx | r2-6 |
| Play and record ring | 36 apx, 1.5 apx gold stroke | 90 apx | r2-6 |
| Gap between glyphs | 12 apx (as drawn) | 30 apx | |
| Glow | None | None | r2-6 |
| Backing | Bare, except where section 5 puts them in the shade or on the chip | Same | r2-6, r3-1, r3-5 |
| Label | Figtree 500, 14 px, sentence case, no tracking, `gold` | 35 apx | r2-8 |

**Unverified**, added by this styleguide: that a 3.75 apx stroke no longer
shimmers. Round 3's Quest check rated type size only, not glyph strokes.

**States: cream lift** (r4). On hover the glyph, ring included, brightens
from gold to the edge's cream highlight `#fff3cf`. Keyboard focus adds a
1.5 apx gold ring 3 apx outside the glyph. Pressing dims it to 55%. There is
still no glow (r2-6).

**View in AR** (r4): the feed's entry for AR Quick Look and WebXR AR is a
cube in viewfinder brackets with the label "View in AR", on the card, in its
shade. Drawing (16 × 16):
`M1.5 4.5v-3h3M11.5 1.5h3v3M14.5 11.5v3h-3M4.5 14.5h-3v-3M8 4.8l3 1.7v3.3L8 11.5 5 9.8V6.5zM5 6.5l3 1.7 3-1.7M8 8.2v3.3`
(round joins and caps).

### 6.1 Hit sizes per input

Hit areas are set per input, not per display, and are never scaled by the
headset factor (r2-6, r3-10). A glyph's hit area is the larger of its drawn
size and the input's minimum, centred on the glyph.

| Input | Minimum hit area | Notes |
| --- | --- | --- |
| Mouse | 24 apx | r2-6 |
| Touch | 44 apx | r2-6 |
| Controller ray or hand ray | 56 apx | r2-6 ("ray or controller"). About 37 mm at 1.75 m |
| Hand poke | 72 apx, never under 20 mm; 30 apx gap (5.0 mm at 45 cm) | r3-10. At 45 cm the 20 mm floor rules: 120 apx |
| Gaze and pinch | **Open** | The concept proposed 72 apx for hand ray and gaze-pinch; r2-6 gave rays 56 |

The Quest 3 poke check at 45 cm hit 80% at 72 apx (12.0 mm), 90% at 96 apx
(16.1 mm) and 90% at 120 apx (20.1 mm). No poke hit the wrong square, and
every miss landed in a gap or off the grid. The 20 mm floor rests on it.

**Hand feedback (carried):** hands have no haptics, so a poke shows a
proximity cue before contact and a soft spatial tick on commit; controllers
pulse; system sounds stay out of the capture mix. The proximity cue is a
**fingertip shade** (r4): the fingertip casts a soft deep-sea shade on the
panel, blurred while it is far and sharpening as it nears, until it meets
the glyph at contact. No glow.

**Phone edges.** Keep every target out of the system's gesture zones and
the safe-area insets. As drawn, the zones are the back-swipe edges (about
20 apx each side) and the home bar (about 34 apx at the bottom). Round 2
found a phone control row reaching into them.

## 7. Type

Two voices, never handwriting (r1, principle 7):

| Face | Use | Weights |
| --- | --- | --- |
| **Fraunces** | Titles and the wordmark | 600 (as drawn: optical sizing auto) |
| **Figtree** | Interface, labels, captions, bylines, notes, timecode, initials | 400 to 600 |

Handwriting belongs to people's own marks only. Fraunces italic stays a
display face; its figures are not tabular (0:08 is 34.0 px wide, 1:11 is
25.1 px), so it never sets changing numbers (r2-8).

### 7.1 Scale

The flat sizes were read from the studio (r2-8); the desktop title and the
caption on a hologram scale with the window. The "Studio CSS" column is as
drawn. Headset sizes are apx at 2.5×. The last column is the x-height in
Quest 3 pixels, against a rule of thumb of at least 8 (not a standard).

| Role | Face | Flat | Studio CSS | Headset | x-height, Quest px |
| --- | --- | --- | --- | --- | --- |
| Title, desktop | Fraunces 600 | 41.6 px | `clamp(1.6rem, 3.2vw, 2.6rem)` | 104.0 | 20.5 (at 32.8 px flat) |
| Title, phone card | Fraunces 600 | 21.6 px | `1.35rem` | 54.0 | 13.6 |
| Wordmark, phone (as drawn) | Fraunces 600 | 24 px | `1.5rem` | 60.0 | not checked |
| Caption on a hologram | Figtree 400 | 16.0 px | `clamp(.8rem, 1.3vw, 1rem)` | 40.0 | 8.9 (at 13.3 px flat) |
| Caption under a card | Figtree 400 | 14.1 px | `.88rem` | 35.2 | 9.4 |
| Byline | Figtree 400 (as drawn), muted | 12.5 px | `.78rem` | 31.2 | 8.3 |
| Control label | Figtree 500, gold | 14.0 px | `.875rem` | 35.0 | 9.3 |
| Timecode | Figtree 400, tabular, muted | 14.4 px | `.9rem` | 36.0 | 9.6 |
| Note | Figtree 400 | 14.4 px | `.9rem` | 36.0 | 9.6 |
| Author initial | Figtree 600 | 10 px | | 25.0 | not checked |

As drawn: line height 1.05 for titles and 1.35 for interface text. Labels
are sentence case with no tracking (r2-8).

### 7.2 Timecode

Figtree 400, 0.9rem (14.4 px), tabular figures, in muted text, so the digits
never shift as time runs (r2-8). It reads "Paused · 0:08" beside Play, and
"Recording 0:12", counting up, in its place while recording (r3-6).

### 7.3 Headsets

- **2.5× every flat size**, for type and icons (r2-8, r3-10). On a Quest 3 at
  1.75 m, 2.5× rated easy and 2× took effort.
- **No text within arm's reach** (r3 close). At 45 cm, 2.5× could not be
  read on a Quest 3 and 3× took effort; the Quest 3 focuses at about 1.3 m.
  Panels you touch carry glyphs only, and their labels sit 1 m away or more.
- **Within 1 m of a hologram** (r4), its labels, timecode and caption fade
  out and its glyphs stay; people's notes fold to their mark. The text comes
  back as you step back past 1 m.
- **Unverified**, added by this styleguide: legibility between 1 m and
  1.75 m (the check ran at 45 cm and 1.75 m only), and the author initial at
  25 apx (not in the check).
- As drawn in 3D: both faces are baked to MSDF at the weights above.

## 8. Motion

The edge is alive, and quieter where it would distract. Halo values are
levels ([section 3.2](#32-strokes-and-soot)); stage light is an intensity,
where 0.9 is its resting value.

### 8.1 Flicker per target

| Target | Halo | Stage light | Source |
| --- | --- | --- | --- |
| Phone and desktop | Round 1: levels 0.50, 0.32, 0.58, 0.40 over 2.6 s | `0.9 + 0.12 · sin 9t · sin 3.7t` (t in seconds), the portal's own stage | r1, r3-8 |
| VR | Round 1's rhythm at a gentle swing: `0.45 + (round 1 − 0.32) × 0.05 / 0.26`, so 0.45 to 0.50 | Steady at 0.9 | r3-8 |
| AR (WebXR) | As VR | Steady at 0.9: never flickers on real surfaces | r3-8 |
| AR Quick Look | None: a static file | None | |

As drawn, round 1's levels sit at 0%, 40%, 55% and 70% of the 2.6 s loop
(0.50, 0.32, 0.58, 0.40, back to 0.50), eased in and out between them
(`cubic-bezier(0.42, 0, 0.58, 1)`).

On flat screens this swings the halo's brightness by 59% on the darkest
ground, 48% mid and 16% at the horizon. It stays under three flashes a
second (WCAG 2.3.1).

**Unverified:** no AR table check was run, and the Quest VR ratings came
from 4 to 8 s looks, not the minute asked for. In those looks the chosen
headset variant rated "noticeable" and a still edge "fine".

### 8.2 Sparks on focus only

Only the hologram in focus sheds sparks; the others hold a steady glow at
level 0.50 and, on a phone, do not redraw (r3-9).

| Target | In focus | Sparks |
| --- | --- | --- |
| VR and AR | The hologram you are looking at: the one nearest the head's forward ray, since Quest 3 has no eye tracking | Up to 70 (r2-5); none in peripheral vision |
| Phone | The card nearest the middle of the screen | 26 (r2-5) |
| Desktop (as drawn) | The card nearest the middle of the window, as on a phone | 26 |

A spark is an ember 0.4% to 0.8% of the short side, rising off a random
point of the edge and fading over 2 to 4 s (r2-5); as drawn, it is gold.

The Quest 3 measured sparks everywhere at 4.44% long frames on a 2D feed and
3.75% in the VR room; focus only measured 0.04% and 2.44%. **Unverified on
Android phones:** the Quest 3's 2D page (Quest Browser is Chromium on
Android) stands in for them.

### 8.3 Reduced motion

When the viewer asks for reduced motion (r2-9): no sparks, and the halo
fades from level 0.50 to 0.489 and back over 8 s (0.125 Hz), ease-in-out.
That is a 4.7% brightness swing on the darkest ground, 4.1% mid and 1.6% at
the horizon. As drawn, the stage light holds steady at 0.9, and headsets get
the same 8 s fade; round 3 did not compare reduced motion in a headset.

### 8.4 Chrome

- Controls appear from where the hand or cursor is and leave afterwards
  (principle 5); everything returns to its source (carried).
- The world never moves relative to the head without the user's action
  (carried).
- The VR chip fades in over 0.3 s and holds at least 2 s (r3-5).
- Under reduced motion, chrome crossfades in place instead of moving
  (carried).
- Chrome **unfolds** (r4): 240 ms in, 400 ms out, ease-out. This replaces
  the concept's 120 to 180 ms.

### 8.5 Recording

On a flat screen, recording quiets the edge, so the person being recorded
is what you watch (r2-9, r3-6). In a headset there is no edge at all while
recording: you are in the world, recording, doing your own thing, not
looking into a hologram (r4). This replaces round 2's room values (halo at
0.15, steady stage light).

| | Flat screens | Headset (VR, AR) |
| --- | --- | --- |
| Sparks | Stop | No edge |
| Halo | Holds at level 0.08 | No edge |
| Gold core and highlight | Drop to 0.55 opacity | No edge |

**Chrome while recording** (r4): everything but the stop control and
"Recording 0:12" hides until the take ends.

The state is carried by shape and word, not colour: the record control turns
from a filled rose circle into a rose rounded square (stop), and
"Recording 0:12" counts up in place of the timecode. The rose shapes are
plain: no keyline, no pulse. In a headset, "Recording 0:12" shows on the
periphery status line instead, and the record control on the wrist carries
the stop shape alone, since no text sits within arm's reach.

## 9. Per-device rules

### 9.1 VR (Quest Browser, WebXR)

- **Ground:** the blue-hour room, not painted. Each hologram lights its stage.
- **Edge:** three strokes at the slab's size; none while you record. Soot in
  VR is **open**.
- **Chip:** 72%, only in front of the sky, a hologram or a lit surface, with
  a 0.3 s fade in and a 2 s hold. **Unverified:** sRGB blending on Quest VR.
- **Motion:** gentle flicker and steady stage light; sparks on the hologram
  nearest the head's forward ray, none in peripheral vision. **Unverified:**
  the flicker ratings came from 4 to 8 s looks.
- **Type and glyphs:** 2.5×. No text within arm's reach: near panels and the
  wrist carry glyphs only, with their labels 1 m away or more.
- **Input:** rays 56 apx; poke 72 apx and at least 20 mm, with 30 apx gaps.
- **Capture:** the record control lives on the non-dominant hand as a glyph
  only, with "Recording 0:12" on the periphery status line. No head-locked panel or
  pill.

### 9.2 AR, WebXR (Quest passthrough and Android Chrome)

- **Ground:** the camera image. Warmth comes only from the hologram's light
  on the real surface, which never flickers.
- **Chip:** every row and label. 97% on Quest passthrough (set by eye), 88%
  on Android Chrome (assumed sRGB), 92% on a target that blends in linear
  light; never opaque. **Unverified:** blending on both devices.
- **Edge:** gold only on Quest. On Android, soot at full opacity when the
  lighting estimate says the room is bright. **Unverified:** no Android
  device. **Open:** the brightness threshold.
- **Motion:** as VR. **Unverified:** no AR table check.
- **Type, glyphs and input:** as VR on a Quest. On an Android phone, flat
  sizes and 44 apx touch targets.
- **Placement:** controls at the hologram's foot, on the chip. Nothing fills
  the view or follows the head except the periphery status line (inventory
  `ar-placed-look-down.jpg`, `ar-phone-*.jpg`).

### 9.3 Phone (portal)

- **Ground:** the gradient, pinned to the screen; nothing bare from 75% down.
- **Hologram:** a portal card with the full edge. Moving the phone moves the
  camera in the hologram's world; pinching zooms between inside the world
  and seeing it as an object. On iPhone web the portal turns but does not
  travel without touch.
- **Focus:** the card nearest the middle sparks and redraws; the others
  hold. **Unverified on Android phones** (section 8.2).
- **Controls:** Play, Free and Return in the card's shade, clear of the
  gesture zones and safe-area insets; touch 44 apx.
- **Notices:** feed-wide notices (empty, offline, server error, uploading)
  on the chip.
- **Type:** the flat scale; the phone card title is 21.6 px.
- **Glyphs:** drawn as SVG, never emoji or font symbols (inventory: ⬆ renders
  as a colour emoji on iOS).
- **Copy:** touch words on a touch device, never desktop keyboard help
  (inventory `phone-idle.jpg`).

### 9.4 Desktop

- **Ground:** the gradient, pinned to the window.
- **Hologram:** a portal card; the mouse rotates it, and the wheel or
  trackpad zooms. As drawn, the card nearest the middle sparks.
- **Controls:** in the shade; mouse 24 apx; a visible keyboard focus (look
  open, section 6).
- **Notices:** on the chip, never under another panel (inventory: the feed
  error hid under the upload panel).
- **Type:** the desktop title is `clamp(1.6rem, 3.2vw, 2.6rem)`.

### 9.5 AR Quick Look (iOS)

Quick Look shows only the USDZ, rendered by RealityKit. Its blending is
documented as linear in part and **unverified** (the iPhone screenshot showed
nothing to measure). No chip, controls, sparks, flicker or meaning layer can
be added. It is a flattened, opt-in preview, never the canonical hologram
([what a hologram is](../concepts/what-a-hologram-is.md)).

- The feed's "View in AR" entry is the cube glyph on the card, in its shade,
  and follows the flat rules.
- **The USDZ carries the edge with a baked halo** (r4): the gold core, the
  cream highlight and a soft halo, static. It is added when the server
  builds the USDZ (`apps/viewer-api/src/worker.ts`,
  `apps/viewer-api/tools/preview_usdz.swift`), never in the exported GLB, so
  the edge stays in the view layer and the export → upload → render pipeline
  is unchanged.
- **Unverified:** how the baked halo looks. Quick Look blends translucency
  in linear light (documented in part), so the halo may look washed out;
  check it on an iPhone.

## 10. Do and don't

Tied to the [principles](principles.md); check each against the test at the
end of that page.

| # | Principle | Do | Don't |
| --- | --- | --- | --- |
| 1 | An event you look into | Show a hologram as a place with someone in it, waiting to be looked into | Autoplay a vertical feed; lay a play bar or scrubber over a flat frame |
| 2 | One golden edge | Use the one burnt edge, as a share of the short side, at every size; keep gold for the edge, its glyphs and its sparks | Add a second frame, a plain rectangle, a cyan scanline look, gold fills or gold banners |
| 3 | 3D first | Place controls at the hologram's foot or on the hand in space, then compress them to the shade or the dock | Design a phone screen of cards, tabs and pills and extrude it; head-lock a panel |
| 4 | Viewpoints | Offer another angle as a small golden portal; Free and Return switch who drives the camera | Use a rectangular inset with a scrubber |
| 5 | Hidden until reached for | Keep Play, Free and Return small, near the edge; bring every other control from the hand or cursor; sparks on focus only | Talk about the system ("READY", "DESKTOP"); show keyboard help; use generic blue play buttons or pills |
| 6 | Warm inside, blue hour outside | Light the hologram from within and let it fall on the surface; judge each colour against what is behind it, with the shade or the chip where the ground fails | Use cool, neutral, thin emissive lines, frosted glass, bright white screens, or bare text from 75% down a flat screen |
| 7 | People's marks are theirs | Draw marks in the author's hue with their initial, hollow until resolved; set app text in Fraunces and Figtree only | Set app text in handwriting; give a mark gold or a screen-locked box; use an identity hue in chrome; let colour alone carry a state |

## 11. Unverified and open, in one place

Each item is also marked where it applies above.

**Unverified (decided; device check missing).** From round 3's known gaps:

1. Blending on Quest AR passthrough (inconclusive), Android Chrome AR (88% on
   the sRGB assumption) and AR Quick Look (no readable screenshot) (r3-7).
2. Soot in bright AR rooms (r3-2): no Android device.
3. Headset flicker: no AR table check; VR looks of 4 to 8 s, not a minute
   (r3-8).
4. Sparks on Android phones: the Quest 3's 2D page stands in (r3-9).

Added by this styleguide:

5. sRGB blending on Quest VR (documented, not measured).
6. The 3.75 apx glyph stroke in a headset: type was rated, strokes were not.
7. Headset legibility between 1 m and 1.75 m, and the author initial at
   25 apx.
8. The baked halo in the Quick Look USDZ (r4), which blends in linear light.

**Decided in round 4** (the user, on the visual page, 2026-10-24):

1. Glyph states: cream lift (section 6).
2. The always-there set dims to 40% after 4 s idle (section 1.2).
3. The chip over a hologram's picture stays 72% (section 2.3).
4. The Quick Look USDZ carries the edge with a baked halo (section 9.5).
5. Chrome unfolds, 240 ms in and 400 ms out; while recording, all chrome
   but stop and the running time hides (sections 8.4, 8.5).
6. No edge in a headset while recording (section 8.5).
7. Within 1 m, labels fade and glyphs stay; notes fold to their mark
   (section 7.3).
8. Notes sit on a tinted slip; the phone dock sits on a bottom shade
   (sections 1.1, 5.2).
9. The poke proximity cue is a fingertip shade (section 6.1).
10. "View in AR" is a cube in brackets (section 6).

**Open: for the screen redesign.**

- Viewpoint portals, the rescale indicator and provenance looks
  (section 4).

**Open: to set or measure.**

- Soot in VR (section 3.2).
- The AR brightness threshold for soot, on an Android device (section 3.2).
- Gaze-and-pinch hit size (section 6.1).
- The chip on a target not listed (section 2.3).

**As drawn** values are marked inline. Most are small (radii, gaps, line
heights, the glyph drawings); the largest are the flat chip at 72%, the
desktop spark rule and reduced motion in headsets.

The probe can run the device checks: `node scripts/design-probe/server.mjs`
(see [direction.md](direction.md), "Device results").
