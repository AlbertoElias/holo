# HoloIM Styleguide

**Status:** Current, 2026-10-25.
**Applies to:** `apps/capture` and `apps/viewer-web`, in 3D (VR and AR, with
hands and controllers) and on flat screens (phone and desktop, with touch and
mouse).
**Tokens:** [tokens.json](tokens.json) holds the values below in W3C Design
Tokens format. This page wins where the two differ.
**Visual page:** [HoloIM Styleguide](https://claude.ai/artifact/HKRiYc7vVwX1C1QWXf1hhC)
draws these values live.
**Replaces:** sections 2, 3 and 8 of the
[design-language concept](../concepts/design-language.md) (the neutral Light
look, Atkinson, open amber, the three looks) and the visual-direction parts
of [PRD-021](../prds/PRD-021-design-language.md).

A hologram is a recorded event, seen through a golden-edged portal. Everything
here serves that one object: a slice of another place, wrapped in a torn gold
edge, on a blue-hour ground, with a few gold glyphs at its foot.

## How to read this

- **3D first.** Each part is defined as an object in space, then compressed
  to flat screens ([principle 3](principles.md)). Where a value differs per
  target, VR and AR come before phone and desktop.
- **Every value here is a rule.** Build to it. How each was chosen is in the
  design rounds ([direction.md](direction.md)) and the
  [principles](principles.md).
- **What is not here is not decided.** The questions still open and the
  device checks still to run belong to the UI redesign feature brief, listed
  in [docs/features](../../features/README.md). When an answer or a device
  result changes a value, it is written here and in `tokens.json` together,
  as a plain rule.
- **Units.** Sizes are in angular px (apx): one CSS reference pixel, about
  0.0213° of view, so a number means the same apparent size on every display.
  On a flat screen 1 apx is 1 CSS px. A Quest 3 shows about 0.53 headset
  pixels per apx. "The short side" is the hologram's shorter visible side.

```txt
size_m = apx × 0.000372 × distance_m × scale
```

`scale` is 2.5 for type and icons in a headset and 1 everywhere else. Hit
targets are never scaled; they are set per input
([section 6.1](#61-hit-sizes-per-input)).

## 1. The hologram as an object

In a room, a hologram is a slab of another place standing on a real or
virtual surface. It is wrapped in one golden edge, lit from within, and casts
warm gold light onto the surface at its foot. Its few controls sit at that
foot. Nothing about it is locked to the head.

On a flat screen the same object is compressed. The slab becomes a portal
card, a 3D world seen through the screen with its own stage light. The room
becomes the blue-hour gradient. A soft dark shade at the card's foot holds
its controls, so they read against the gradient.

| Part | In a room (VR, AR) | On a flat screen (phone, desktop) |
| --- | --- | --- |
| The picture | A 3D slab, tabletop to doorway size | A portal card |
| The edge | The burnt gold edge around the slab | The same edge, same outline, around the card |
| Around it | The VR room, or the camera image in AR | The blue-hour gradient, pinned to the screen |
| At its foot | Warm gold light on the surface | A soft dark shade under the card |
| Its controls | Glyphs at the stage base, on the chip where needed | Glyphs in the shade |
| Sparks | Only on the hologram in focus | Only on the card nearest the middle |

The edge, sparks, shade, light and ground belong to the view layer. They are
never baked into an exported GLB.

### 1.1 Three materials

Each layer of a hologram has its own material.

| Material | Layer | Look |
| --- | --- | --- |
| **Presence** | The event: people, voices, attention | The recording itself; each person's identity hue as a rim on their avatar |
| **Ink** | The meaning: marks, notes, symbols | In the author's identity hue, with their initial; never gold |
| **Light** | The view's chrome: controls, status | Gold glyphs, Fraunces and Figtree, on the shade or the chip |

- Prominence: ink first, then people, then chrome.
- Chrome never uses an identity hue, and marks never look like chrome.
- A mark's reveal is part of the message: it replays with its original
  timing.
- A mark that holds text (a note) sits on a **tinted slip**: a dark slip,
  `color-mix(in srgb, <hue> 22%, #081a1e)`, with cream text and the author's
  mark and name in their hue. It never looks like the chrome's chip.

### 1.2 Where things live

No interactive UI is locked to the head, and everything comes out of its
source and goes back there.

| In 3D | On a flat screen | What goes there |
| --- | --- | --- |
| Stage base (at the hologram's foot) | The shade under the card | Play, Free, Return, timecode, caption; later the time ribbon and layers |
| Non-dominant hand (palm, wrist) | Bottom dock (thumb zone on a phone) | Record, ink, undo. Glyphs only in a headset: it is within reach |
| Point of action (fingertip, ray hit, gaze) | Cursor or touch point | Menus that bloom from the hand, ink |
| Referent (the mark or bone being edited) | Popover pinned to the object's screen position | Editing a mark |
| Periphery (lazy-follow, upper edge of view) | Top status line | State only, such as "Recording 0:12"; never controls |
| World (placed by the user, 1 m away or more) | Side sheet | Labels for near panels, long text, library, inbox, settings |

The periphery status line is the one thing that follows the head, lazily,
and it never holds a control. It sits 1.5 m away, 20° above the line of
sight, and stays put until the head turns more than 20° from it; then it
eases back (time constant 240 ms) until it is within 1°.

In a headset a world panel opens 1.5 m straight ahead and is never nearer
than 1 m; after that it stays where it is. Wrist glyphs sit 4 cm above the
back of the non-dominant wrist and are sized for 45 cm, arm's reach.

**Always there, and hidden until reached for.** Play, Free and Return stay
visible, small and close to the edge. Every other control appears from the
hand or cursor and leaves afterwards. When nobody has used the always-there
set for 4 s, it dims to 40%; it comes back to full strength when a hand,
cursor or gaze comes near.

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
| `highlight` | `#fff3cf` | The edge's thin cream highlight; glyphs on hover |
| `record` | `#ff3b5c` | Record red (rose): the record control and the recording state only |

Gold is the hologram's colour. Use it for the edge and the glyphs that take
their light from it, and nowhere else: never a surface fill, a banner or a
selection colour.

There is no error colour. Errors are cream text with a gold action ("Try
again") on the shade or the chip: 12.75:1 and 8.62:1.

There is no surface colour: the chip is the only container.

### 2.2 Ground per target

| Target | Ground |
| --- | --- |
| VR | Not painted. The blue-hour room; each hologram is pinned to its stage and lit by its own gold light on the surface |
| AR (WebXR, Quick Look) | Not painted. The camera image; warmth comes only from the hologram's light on the real surface |
| Phone and desktop | `linear-gradient(180deg, #0c2228 0%, #17424a 48%, #575f5a 80%, #b8835e 100%)`, pinned to the screen, not the page |

**The bottom band.** Nothing sits bare from 75% down a flat screen: it goes
in a hologram's shade or on the chip ([section 5](#5-shade-and-chip)). On
the bare gradient, muted text drops below 4.5:1 from 75% down, gold labels
from 77%, body text from 89%, and gold shapes below 3:1 from 90%.

### 2.3 The chip per target

The chip is the one text container: flat `#081a1e`, with no backdrop blur
and no rim. Its opacity depends on how the target composites translucency.

| Target | Chip |
| --- | --- |
| VR, Quest Browser | 72% |
| AR, Quest passthrough | 97% |
| AR, Android Chrome (ARCore) | 88% |
| AR, a target that blends in linear light | 92% |
| AR Quick Look (iOS) | None: Quick Look shows only the USDZ |
| Phone and desktop | 72% |

The chip is never opaque in AR.

**Over a hologram's own picture** on a flat screen, text always takes the
chip, at 72%. Over a pure white picture this gives muted text 4.46:1, gold
4.68:1 and record red 2.05:1, so red over a picture never goes without its
shape and word.

**Shape:** corner radius 18 apx, padding 5 × 14 apx. A chip that holds a
control row is padded 3 apx at the top, bottom and start and 14 apx at the
end, so the Play ring sits flush at its start. Headset values are 2.5× these.

### 2.4 Identity hues

Each person has one identity hue for their avatar rim and everything they
author. Eight hues, chroma 0.12, kept clear of record red, the golds, the
horizon and the ground hue; each is at least 3:1 on `#17424a`.

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

The closest pair is ΔE 4.6 (OKLab × 100) for blue-blind viewers, so hue
alone can be lost: **every author mark carries the author's initial**,
Figtree 600, 10 px, `#081a1e` on a filled mark, the author's hue on a hollow
one. Marks sit bare, with no ring, even at the horizon.

### 2.5 Record red

Rose `#ff3b5c`, with no keyline or ring of its own. Red never carries the
state alone: against the ground it is as low as 1.1:1, and for colour-blind
viewers it can match the horizon. The shape and the word carry recording
([section 8.5](#85-recording)).

### 2.6 The unresolved mark

An unresolved mark, such as an open question or an open thread, is hollow:
an outline in the author's identity hue, 2.5 apx at an 18 apx mark, with the
initial in the same hue. It fills in, with a `#081a1e` initial, once
resolved. Amber is not a signal: it is the interior light of everything.

## 3. The golden edge

One edge, on every target. Around a hologram it is a 3D object, the cloche
([section 3.4](#34-the-cloche-the-3d-halo)): a dome over the event, burnt
through, so only torn gold fronts, embers and sparks are left of it. The flat outline in sections 3.1 to 3.3 remains
for 2D surfaces that frame no hologram (a thumbnail, a slab in a headset
menu); it is no longer drawn round a feed card.

### 3.1 Burnt geometry

An irregular outline around a rounded rectangle.

| Token | Value (share of the short side) |
| --- | --- |
| Corner radius | 7% |
| Waves | 3 to 9 per loop, amplitude about 2% |
| Tears | 16 to 38 per loop, amplitude about 0.9% |
| Jitter | 0.7% per point |
| Inset | The larger of 6% and the halo width, so the glow is never clipped square |

The outline is sampled at 280 points per loop and seeded per hologram, so
one hologram keeps the same tears wherever it appears.

### 3.2 Strokes and soot

| Stroke | Width (short side) | Colour | Notes |
| --- | --- | --- | --- |
| Halo | 6% | `#ffb066`, level 0.50 | Blurred, standard deviation half the halo width; flickers ([section 8](#8-motion)) |
| Gold core | 1.4% | `#ffc872` | Softly blurred |
| Highlight | 0.4% | `#fff3cf` | |
| Soot halo | 6% | `#081a1e` | Same width and blur as the halo; replaces it where the ground is light; never flickers |

**Halo level.** Halo opacity is given as a level, where 0.50 is its resting
value on a flat screen. The 3D halo material's opacity is
`min(1, 0.9 × level / 0.5)`, so it rests at 0.9.

**Soot.** Gold on amber is 2.1:1. Where the ground behind the edge is light,
the warm halo crossfades into a dark soot halo of the same shape:

```txt
t = clamp((L − 0.095) / (0.16 − 0.095), 0, 1)   L: relative luminance of the ground behind the edge
glow halo opacity = level × (1 − t)              only this part flickers
soot halo opacity = soot × t                     soot: 0.6 on flat screens and in VR, 1 in AR
```

`t` is 0 (all glow) at about 75% down the gradient and 1 (all soot) at about
88% down. That lifts a phone card ending at the bottom from 1.9:1 to 4.2:1.

Per target:

- **Flat screens:** soot 0.6, by the luminance rule above.
- **VR:** the flat-screen rule. `L` is the luminance of the VR room behind
  the edge, and soot is 0.6.
- **AR with a lighting estimate (Android Chrome):** AR has no ground
  luminance behind the edge, so `t` is 1 while the room is bright and 0
  otherwise: soot at full opacity replaces the glow outright. Bright is read
  from the estimate's ambient (first) spherical-harmonic coefficient, in
  linear light: `Y = 0.2126 R + 0.7152 G + 0.0722 B`. Soot switches on at
  `Y ≥ 0.16` and off when `Y < 0.095`; between the two it keeps its state, so
  it does not flicker at the boundary.
- **AR with no lighting estimate (Quest passthrough):** soot at full opacity,
  always (`t` = 1). Legibility against a bright wall comes before warmth in a
  dim room.
- **AR Quick Look:** none ([section 9.5](#95-ar-quick-look-ios)).

**The cloche draws no soot.** A dark halo round a 3D dome reads as a drop
shadow, and only a hologram casts a shade. The cloche keeps the soot rule's
input and turns it into **char**: a narrow dark line (`#6b3514`) beside the
gold, at 0.35 on dark ground and rising to full strength where `t` reaches 1
(light ground, a bright AR room, a Quest with no lighting estimate).

### 3.3 Sizes

Every part of the edge is a share of the short side at every size, with no
angular floor or cap. At four reference sizes (apx):

| Size | Gold core | Halo | Highlight | Tear depth (deepest) |
| --- | --- | --- | --- | --- |
| 80 px thumbnail (80 × 64) | 0.9 | 3.8 | 0.3 | 0.6 (0.8) |
| Phone card (300 × 240) | 3.4 | 14.4 | 1.0 | 2.2 (3.1) |
| Tabletop slab, 0.62 × 0.74 m at 1.5 m | 15.4 (8.2 Quest px) | 65.8 | 4.4 | 9.9 (14.2) |
| Doorway, 0.9 × 2 m at 1.5 m | 22.0 (11.7 Quest px) | 94.1 | 6.3 | 14.1 (20.3) |

On a thumbnail the tears fall below one device pixel and the edge reads as a
smooth gold line. On a doorway the halo is about 94 apx wide, so glyphs at
its foot sit inside the glow. Both are intended.

### 3.4 The cloche (the 3D halo)

Decided 2026-10-25 with Codex, from three candidates rendered in the real
viewer (a case, three rings, a floating bubble, and the cloche). The case read
as an editor's bounding box, the rings as an atom, and the bubble floated,
weightless. The cloche keeps the grounded warmth: a little place you could
enter.

- **Shape.** A superellipsoid dome (exponent 2.6) whose foot rests on the
  hologram's floor. It is fitted once to what the hologram draws (the bubble's
  content, never the bubble's mesh; the author's bones through the take when
  there is no bubble), plus a 4% margin, and never refitted as the take plays,
  so it never breathes. Its height is at least 40% of its wider radius, so
  every dome has the same shoulders. A bubble that follows its author carries
  its dome along.
- **Anchored in the hologram's world.** It orbits, zooms and walks with the
  hologram on every target. It is never on the camera or the screen.
- **Burnt through.** Revised the same day, after the user found the
  rim-lit glass "very much 2d": a line at the silhouette is an outline, not
  a volume. Seeded 3D noise burns the shell away; only the burning fronts
  remain, torn into dashes, on the near side and the far side alike, so the
  lines in front and behind move against each other as the view turns. A
  front is a cream core (`#ffe59f`, 1.5 px), gold (`#ff932b`) to 3.2 px, a
  pixel of char (`#250902`, [section 3.2](#32-strokes-and-soot)) and a faint
  warm glow (`#ff6f22`) to 9 px, in screen pixels at every zoom. The holes are large (2.8 noise
  cycles across the dome) and seeded per hologram, the same in every
  renderer (`clocheBurnAt`, `@holoim/xr-ui-core`).
- **Quiet over the event.** Where the dome faces the viewer straight on, in
  front of the event, the fronts fade to nothing; they are whole at the
  silhouette and on the far side (75%), behind the event. In focus they
  reach further in (strength `(1 − N·V)^1.1`); out of focus only the
  silhouette band burns (`^2.6`). Zoomed in (the dome's on-screen radius
  from 300 to 700 device pixels) the near side steps back to 75%, and fronts
  close to the eye fade out. The far edge of the dome is 60% dimmer than the
  near edge.
- **Embers.** 2,500 embers sit in and just off the shell, a little denser
  toward the foot, flickering from ember (`#8a0d01`) through gold, cream only
  at their peaks, drifting slowly. They follow the same quiet rule, are never
  larger than 3.5 px (none becomes a bokeh disc) and vanish close to the eye.
  Out of focus 45% of them drift.
- **Sparks.** The hologram in focus sheds sparks from its burning fronts
  into the space around it, outward and upward, cream to gold to ember, over
  1.1 to 2.6 s ([section 8.2](#82-sparks-on-focus-only)).
- **Deeper than the chrome.** The globe burns deeper than the chrome's core:
  its colours are its own (`edge.cloche.colors`), each the chrome colour it
  comes from with its linear values shown as sRGB, which is how the approved
  globe was drawn (gold `#ffc872` becomes `#ff932b`). The DOM chrome keeps
  `edge.core`, `edge.highlight` and the rest. The Quick Look globe takes the
  chrome colours converted to linear, so it shows them as the chrome does.
- **Rest and focus** ease into each other in about 400 ms.
- **Glow** flickers by target as the halo does ([section 8](#8-motion)). The
  stage light inside the portal is the only light the globe sheds onto the
  event; the globe adds none of its own.
- **Inside.** As the viewer goes in, the dome fades out completely before
  they reach the shell, so nothing of it stands between them and the event:
  no back wall, no fog.
- **Framing.** Follow frames the whole dome in the card's viewing box (the
  space between the title and the controls) at 78% of its size, from 18°
  right of front and 16° above. Return frames it again.
- **Never exported.** The GLB never holds the cloche; every renderer fits it
  from the same rules (`fitCloche`, `@holoim/xr-ui-core`).

## 4. Viewpoints, scale and provenance

- Another viewpoint is a small golden portal in the scene, never a
  rectangular inset with a scrubber. Free and Return switch who drives the
  camera.
- Rescaling is always visible, labelled and reversible.
- Recorded, inferred (read from the body) and added marks look different
  from each other, and none of them looks hollow, which means unresolved.

## 5. Shade and chip

### 5.1 The shade at a hologram's foot

Every hologram casts a soft dark shade on its own floor, in its world: an
ellipse 115% of the drawn content's footprint, with the stops below, moving
with the hologram. It is the only shade anywhere. The cloche casts none, and
no control, edge or dock casts one on the screen.

```css
/* the stops, as drawn on the floor */
rgba(8,26,30,.7), rgba(8,26,30,.5) 60%, rgba(8,26,30,0)
```

The controls no longer sit in a shade: they stand in a row at the card's
foot, below the viewing box, where the ground is still dark (above 75% down),
and take the chip when they are over the hologram's own picture.

### 5.2 Where the chip is mandatory

Only where the ground fails:

| Target | Rule |
| --- | --- |
| VR | Rows stay bare against the room's walls. They take the chip in front of the sky, a hologram or a lit surface. The chip fades in over 0.3 s, holds at least 2 s after the background last asks for it, and leaves over 0.4 s, as chrome does |
| AR (WebXR) | Every row and every label sits on the chip |
| AR Quick Look | No chip is possible, so no text or controls inside Quick Look |
| Phone and desktop | The card's controls stand bare in their row at its foot, and take the chip when the viewer is inside the hologram and its picture is behind them. Feed-wide notices, which have no hologram (empty feed, offline, upload status), use the chip. The feed's bottom dock stands on the amber horizon, where gold fails (2.1:1), with no chip, band or shadow across it: each control there is a **lantern**, its glyph in the gold ring (as Play's) round a deep-sea lens, and keyboard focus rings it in deep-sea ink (`glyph.lantern`). Its word does not show: ink text falls below 4.5:1 on most screens there, while the lens holds a control's 3:1. A control with no drawing yet holds its gold word in a lantern capsule, the same ring and lens, where gold on the lens holds 4.5:1. A dock over a picture (AR, capture) keeps its row on the chip, sized to its contents. The side sheet is on the chip |
| Everywhere | Text over a hologram's own picture always sits on the chip |

## 6. Glyph controls

Thin gold line glyphs that take their light from the edge; no buttons or
pills. Icons only on a card: the word is the accessible name, and shows on a
sheet action, or a dock over a picture, where there is room. On the feed's
amber dock the control is a lantern with no word ([section 5.2](#52-where-the-chip-is-mandatory)).

**Few at rest, the rest on reach.** At rest a card shows **Play** (or
**Pause**) alone in the middle of its foot, plus **Return** beside it while
the viewer drives (Free). Reaching for the card (a cursor over it, a touch)
unfolds the rest either side of Play, two glyph gaps (24 apx) apart: the
timecode to the left; Free, highlights, tilt, View in AR and sound to the
right. Play never moves as they come and go. The row stands below the
viewing box, off the cloche's foot line, and ends above 75% down the screen,
where the ground is still dark enough for bare gold ([section 9.3](#93-phone-portal)),
well clear of the dock. Over the hologram's own picture it takes the chip,
sized to the controls showing, padded alike at both ends so Play stays in
the middle.

**Too many for one row.** When the reach controls do not fit beside Play at
the input's hit size (a touch phone with a take that has sound), Free,
highlights, tilt, View in AR and sound unfold in a line of their own above
Play, centred, a glyph gap (12 apx) over the row, on the same chip when the
row has one. The timecode stays left of Play and Return right of it. Play
still never moves, and no glyph shrinks below its input's minimum or enters
a gesture zone.

| Glyph | Meaning | Label | Drawing (16 × 16 viewBox) |
| --- | --- | --- | --- |
| Play / Pause | Play or pause the event | "Paused · 0:08" beside it | Filled triangle `M4 2.5v11l9-5.5z`, drawn at 14 apx inside the 36 apx gold ring |
| Free | Leave Follow; move through time and space yourself | "Free" | Four-way arrow cross `M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2` |
| Return | Back to the author's view (Follow) | "Return" | Open arc with an arrowhead `M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5` |
| Record | Start or stop a take (capture) | "Recording 0:12" while recording | Inside the 36 apx gold ring: a 14 apx filled rose circle when idle; a 13 apx rose rounded square (radius 3 apx) while recording |
| View in AR | Open the hologram in AR Quick Look or WebXR AR | "View in AR" | A cube in viewfinder brackets `M1.5 4.5v-3h3M11.5 1.5h3v3M14.5 11.5v3h-3M4.5 14.5h-3v-3M8 4.8l3 1.7v3.3L8 11.5 5 9.8V6.5zM5 6.5l3 1.7 3-1.7M8 8.2v3.3`, round joins and caps; a reach control on the card |
| Pause | Pause the playing event | "Pause" (name) | Two bars `M5.5 3v10M10.5 3v10`, inside the 36 apx gold ring as Play |
| Sound on / off | Mute or unmute the event | "Mute" / "Unmute" (name) | A speaker with waves, or with a cross (`tokens.json`, `glyph.path.soundOn` / `soundOff`) |
| Upload | Open the upload sheet; send the upload | "Upload" | An arrow up out of a tray (`glyph.path.upload`) |
| Close | Close a sheet | "Close" (name) | A cross (`glyph.path.close`) |
| Halo | Summon the Halo (press and hold) | "Halo" (name) | Four arcs around a point, open at the diagonals (`glyph.path.halo`) |
| Undo / Redo | The Halo's W and E: undo or redo the last held mark | "Undo mark" / "Redo mark" (name) | An arrow back over a turn, and its mirror (`glyph.path.undo` / `redo`) |

The rose record dot has no keyline of its own; the gold ring around it is
the same as Play's. The Play triangle and the record shapes are filled;
every other glyph is a line.

| Token | Flat | Headset (2.5×) |
| --- | --- | --- |
| Stroke | 1.5 apx, round caps | 3.75 apx (about 2.0 Quest px) |
| Icon | 16 apx | 40 apx |
| Play and record ring | 36 apx, 1.5 apx gold stroke | 90 apx |
| Gap between glyphs | 12 apx | 30 apx |
| Glow | None | None |
| Backing | Bare, except where section 5 puts them in the shade or on the chip | Same |
| Label | Figtree 500, 14 px, sentence case, no tracking, `gold` | 35 apx |

**States.** On hover the glyph, ring included, brightens from gold to the
edge's cream highlight `#fff3cf`. Keyboard focus adds a 1.5 apx gold ring
3 apx outside the glyph. Pressing dims it to 55%. There is never a glow.

### 6.1 Hit sizes per input

Hit areas are set per input, not per display, and are never scaled by the
headset factor. A glyph's hit area is the larger of its drawn size and the
input's minimum, centred on the glyph.

| Input | Minimum hit area | Notes |
| --- | --- | --- |
| Mouse | 24 apx | |
| Touch | 44 apx | |
| Controller ray or hand ray | 56 apx | About 37 mm at 1.75 m |
| Gaze and pinch | 72 apx | About 1.5° of view, above eye-tracking accuracy; visionOS sends it as `transient-pointer` input |
| Hand poke | 72 apx, never under 20 mm; 30 apx gap (5.0 mm at 45 cm) | At 45 cm the 20 mm floor rules: 120 apx |

**Hand feedback.** Hands have no haptics, so a poke shows a proximity cue
before contact and a soft spatial tick on commit; controllers pulse; system
sounds stay out of the capture mix. The proximity cue is a **fingertip
shade**: the fingertip casts a soft deep-sea shade on the panel, blurred
while it is far and sharpening as it nears, until it meets the glyph at
contact. No glow.

**Phone edges.** Keep every target out of the system's gesture zones and
the safe-area insets: the back-swipe edges (about 20 apx each side) and the
home bar (about 34 apx at the bottom).

**Holds.** A button, key, trigger or pinch holds a mode the moment it is
pressed. A touch on a surface becomes a hold after 300 ms, if it has moved
less than half a touch target (22 apx); otherwise it is a scroll or a drag.
A held mode ends on release, on tracking loss and on blur, and its release
never also selects what is under it.

### 6.2 The Halo

One radial menu with eight directions that never change, on every device:

| N | NE | E | SE | S | SW | W | NW |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Note | Symbols | Redo | Mark moment | Record / stop | Retake | Undo | Ink |

- A press held 300 ms draws the ring. Moving out of the centre (half a glyph
  ring, 18 apx) points at the nearest direction; releasing there commits it.
  Released before the ring draws, it is a flick: it commits and nothing is
  drawn. Released in the centre, or cancelled, it commits nothing.
- Each direction is a glyph ring (36 apx). Neighbours sit one glyph gap
  (12 apx) apart, so the ring's radius is about 63 apx. Headset values are
  2.5× these.
- A direction with no action draws nothing, and its place stays reserved.
  Capture's Halo carries S, W (undo the last held mark) and E (redo it).
- Summoned, per input: on desktop hold **B** and move the mouse, or press
  and hold the dock's Halo glyph; on a phone press and hold the dock's Halo
  glyph and drag; with Quest hands the dominant thumb–middle pinch and a
  drag of that hand; with Quest controllers press and hold the
  non-dominant thumbstick and tilt it. In a headset the ring opens where
  the summoning hand is, facing the head.
- The dock's Halo glyph is four arcs around a point, open at the
  diagonals (`glyph.path.halo`). W and E draw the undo and redo arrows
  (`glyph.path.undo`, `glyph.path.redo`); S draws Record.

## 7. Type

Two voices, never handwriting:

| Face | Use | Weights |
| --- | --- | --- |
| **Fraunces** | Titles and the wordmark | 600, optical sizing auto |
| **Figtree** | Interface, labels, captions, bylines, notes, timecode, initials | 400 to 600 |

Handwriting belongs to people's own marks only. Fraunces italic stays a
display face; its figures are not tabular, so it never sets changing
numbers.

### 7.1 Scale

The desktop title and the caption on a hologram scale with the window.
Headset sizes are apx at 2.5×.

| Role | Face | Flat | CSS | Headset |
| --- | --- | --- | --- | --- |
| Title, desktop | Fraunces 600 | 41.6 px | `clamp(1.6rem, 3.2vw, 2.6rem)` | 104.0 |
| Title, phone card | Fraunces 600 | 21.6 px | `1.35rem` | 54.0 |
| Wordmark, phone | Fraunces 600 | 24 px | `1.5rem` | 60.0 |
| Caption on a hologram | Figtree 400 | 16.0 px | `clamp(.8rem, 1.3vw, 1rem)` | 40.0 |
| Caption under a card | Figtree 400 | 14.1 px | `.88rem` | 35.2 |
| Byline | Figtree 400, muted | 12.5 px | `.78rem` | 31.2 |
| Control label | Figtree 500, gold | 14.0 px | `.875rem` | 35.0 |
| Timecode | Figtree 400, tabular, muted | 14.4 px | `.9rem` | 36.0 |
| Note | Figtree 400 | 14.4 px | `.9rem` | 36.0 |
| Author initial | Figtree 600 | 10 px | | 25.0 |

Line height is 1.05 for titles and 1.35 for interface text. Labels are
sentence case with no tracking.

### 7.2 Timecode

Figtree 400, 0.9rem (14.4 px), tabular figures, in muted text, so the digits
never shift as time runs. It reads "Paused · 0:08" beside Play, and
"Recording 0:12", counting up, in its place while recording.

### 7.3 Headsets

- **2.5× every flat size** of type, icons, glyph strokes, rings, glyph gaps
  and the chip's shape, as the tables above give. Never hit areas
  ([section 6.1](#61-hit-sizes-per-input)).
- **No text within arm's reach.** The Quest 3 focuses at about 1.3 m, and
  at 45 cm 2.5× text cannot be read and 3× takes effort. Panels you touch carry glyphs
  only, and their labels sit 1 m away or more.
- **Within 1 m of a hologram**, its labels, timecode and caption fade out
  and its glyphs stay; people's notes fold to their mark. The text comes back
  as you step back past 1 m.
- Both faces are baked to MSDF at the weights above.

## 8. Motion

The edge is alive, and quieter where it would distract. Halo values are
levels ([section 3.2](#32-strokes-and-soot)); stage light is an intensity,
where 0.9 is its resting value.

### 8.1 Flicker per target

| Target | Halo | Stage light |
| --- | --- | --- |
| Phone and desktop | Levels 0.50, 0.32, 0.58, 0.40 at 0%, 40%, 55% and 70% of a 2.6 s loop, back to 0.50, eased `cubic-bezier(0.42, 0, 0.58, 1)` | `0.9 + 0.12 · sin 9t · sin 3.7t` (t in seconds), the portal's own stage |
| VR | The same rhythm at a gentle swing: `0.45 + (flat level − 0.32) × 0.05 / 0.26`, so 0.45 to 0.50 | Steady at 0.9 |
| AR (WebXR) | As VR | Steady at 0.9: never flickers on real surfaces |
| AR Quick Look | None: a static file | None |

The flat flicker stays under three flashes a second (WCAG 2.3.1).

### 8.2 Sparks on focus only

Only the hologram in focus sheds sparks; the others hold a steady glow at
level 0.50 and, on a phone, do not redraw.

| Target | In focus | Sparks |
| --- | --- | --- |
| VR and AR | The hologram nearest the head's forward ray | Up to 160; none in peripheral vision, further than 30° from that ray |
| Phone | The card nearest the middle of the screen | 120 |
| Desktop | The card nearest the middle of the window | 120 |

A spark leaves a burning front of the globe ([section 3.4](#34-the-cloche-the-3d-halo))
outward and upward, buoyant, curling a little, cream to gold to ember, at
most 4 px, and fades over 1.1 to 2.6 s. (Raised from 26 and 70 with the
burnt globe on 2026-10-25: a few sparks on a 2D outline read as sparks; on a
volume they read as dust.)

### 8.3 Reduced motion

When the viewer asks for reduced motion, on every target: no sparks, and the
halo fades from level 0.50 to 0.489 and back over 8 s (0.125 Hz),
ease-in-out. The stage light holds steady at 0.9.

### 8.4 Chrome

- Controls appear from where the hand or cursor is and leave afterwards;
  everything returns to its source.
- Chrome **unfolds**: 240 ms in, 400 ms out, ease-out.
- The VR chip fades in over 0.3 s, holds at least 2 s and leaves over 0.4 s.
- The world never moves relative to the head without the user's action.
- Under reduced motion, chrome crossfades in place instead of moving.

### 8.5 Recording

On a flat screen, recording quiets the edge, so the person being recorded
is what you watch. In a headset there is no edge at all while recording:
you are in the world, recording, doing your own thing, not looking into a
hologram.

| | Flat screens | Headset (VR, AR) |
| --- | --- | --- |
| Sparks | Stop | No edge |
| Halo | Holds at level 0.08 | No edge |
| Gold core and highlight | Drop to 0.55 opacity | No edge |

**Chrome while recording:** everything but the stop control,
"Recording 0:12" and the Halo glyph hides until the take ends. The Halo
stays because it carries the take's own actions: stop, and undo or redo the
held mark.

The state is carried by shape and word, not colour: the record control turns
from a filled rose circle into a rose rounded square (stop), and
"Recording 0:12" counts up in place of the timecode. The rose shapes are
plain: no keyline, no pulse. In a headset, "Recording 0:12" shows on the
periphery status line instead, and the record control on the wrist carries
the stop shape alone, since no text sits within arm's reach.

## 9. Per-device rules

### 9.1 VR (Quest Browser, WebXR)

- **Ground:** the blue-hour room, not painted. Each hologram lights its stage.
- **Edge:** around a hologram, the cloche (section 3.4), the char by the
  flat-screen rule from the luminance of the room behind it; around a slab,
  the three strokes at the slab's size. None while you record: capture draws
  no halo during a take, and its playback review, when it has one, takes the
  same cloche.
- **Chip:** 72%, only in front of the sky, a hologram or a lit surface, with
  a 0.3 s fade in and a 2 s hold.
- **Motion:** gentle flicker and steady stage light; sparks on the hologram
  nearest the head's forward ray, none in peripheral vision.
- **Type and glyphs:** 2.5×. No text within arm's reach: near panels and the
  wrist carry glyphs only, with their labels 1 m away or more.
- **Input:** rays 56 apx; poke 72 apx and at least 20 mm, with 30 apx gaps.
- **Capture:** the record control lives on the non-dominant hand as a glyph
  only, with "Recording 0:12" on the periphery status line. No head-locked
  panel or pill.

### 9.2 AR, WebXR (Quest passthrough and Android Chrome)

- **Ground:** the camera image. Warmth comes only from the hologram's light
  on the real surface, which never flickers.
- **Chip:** every row and label. 97% on Quest passthrough, 88% on Android
  Chrome, 92% on a target that blends in linear light; never opaque.
- **Edge:** the cloche ([section 3.4](#34-the-cloche-the-3d-halo)), the
  same object as on a flat screen, fitted in the placed hologram's own space,
  so placing, moving and rescaling it carry the dome along. It replaces the
  bubble's old glass sphere and the flat ring that faced the viewer. Its char
  is at full strength always on Quest passthrough, which has no lighting
  estimate; on Android, while the lighting estimate says the room is bright
  (on at 0.16, off below 0.095; section 3.2). Clear inside, restrained glow.
- **Motion:** as VR.
- **Type, glyphs and input:** as VR on a Quest. On an Android phone, flat
  sizes and 44 apx touch targets.
- **Placement:** controls at the hologram's foot, on the chip. Nothing fills
  the view or follows the head except the periphery status line.

### 9.3 Phone (portal)

- **Ground:** the gradient, pinned to the screen; nothing bare from 75% down.
- **Hologram:** a portal card: the scene fills the card, never cut square,
  and the cloche is framed in the viewing box between the title and the
  controls. Moving the phone moves the
  camera in the hologram's world; pinching zooms between inside the world
  and seeing it as an object. On iPhone web the portal turns but does not
  travel without touch.
- **Focus:** the card nearest the middle sparks and redraws; the others
  hold.
- **Controls:** Play alone at rest (Return beside it while driving), the
  rest on touch, in the row at the card's foot (in a line above Play when
  they do not fit beside it), clear of the gesture zones, the safe-area
  insets and the dock; touch 44 apx, on any device with a touch screen.
- **Notices:** feed-wide notices (empty, offline, server error, uploading)
  on the chip.
- **Type:** the flat scale; the phone card title is 21.6 px.
- **Glyphs:** drawn as SVG, never emoji or font symbols.
- **Copy:** touch words on a touch device, never desktop keyboard help.

### 9.4 Desktop

- **Ground:** the gradient, pinned to the window.
- **Hologram:** a portal card; the mouse rotates it, and the wheel or
  trackpad zooms. The card nearest the middle sparks.
- **Controls:** in the row at the card's foot, the rest when the cursor is
  over the card; mouse 24 apx; keyboard focus as in section 6.
- **Notices:** on the chip, never under another panel.
- **Type:** the desktop title is `clamp(1.6rem, 3.2vw, 2.6rem)`.

### 9.5 AR Quick Look (iOS)

Quick Look shows only the USDZ, rendered by RealityKit. No chip, controls,
sparks, flicker or meaning layer can be added. It is a flattened, opt-in
preview, never the canonical hologram
([what a hologram is](../concepts/what-a-hologram-is.md)).

- The feed's "View in AR" entry is the cube glyph on the card, in its shade,
  and follows the flat rules.
- **The USDZ carries the burnt globe, baked** (slice 6, decided with
  Codex on 2026-10-25). RealityKit has no shader, no screen-space line and
  no quiet front, so the globe is geometry in diffuse and emissive
  materials only, fitted by `fitCloche` and burnt by the same seed (the
  hologram's id) as the web:

  | Part | What it is | Value (`edge.cloche.quickLook`) |
  | --- | --- | --- |
  | Fronts | Gold tubes along the zero level of `clocheBurnAt` on the dome, torn into dashes where `clocheTearAt` is low, swelling with it | Radius 0.0021 of the dome's wider radius; emissive 0.9; dropped below tear 0.08 |
  | Cream core | A thinner cream tube showing just past the gold's outer face | 0.25 of the gold; emissive 0.6 |
  | Char shoulder | An opaque, unlit char tube attached to the gold on the side where the shell remains, torn with it: the front reads as a burning edge and keeps a dark side on light ground | 0.65 of the gold; `edge.char.color`, no emission |
  | Embers | The web's resting embers for the seed (`clocheEmbers`, seed x within `emberRestShare`), the first 800, as small octahedra in three heats: ember `#c2410c`, gold, cream | Size 0.7 of `emberSize`; emissive 1.0 |

  No sparks, no glass, and the bubble's old shell is hidden. Keep the
  fronts thin: with no quiet rule, the near side's fronts cross the people
  inside. Quick Look draws its own grounding shadow under the whole model;
  no USD attribute opts one mesh out, so the globe's thin parts add little
  to it. The bake is added only when the server builds the USDZ
  (`apps/viewer-api/tools/glb_to_usdz.py` with `tools/cloche.py`, run by
  the USDZ worker), never in the exported GLB, so the edge stays in the view
  layer and the export → upload → render pipeline is unchanged.

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
