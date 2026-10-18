# Design Language and Interaction Model

**Status:** Exploration (IDEA-031). Nothing here is decided. Open decisions are
listed at the end.
**Applies to:** `apps/capture`, `apps/viewer-web`, and the shared UI packages,
in 2D (desktop, phone) and 3D (VR, AR), with mouse, touch, controllers, hands,
and gaze-pinch.

## Why the current design fails

- **Panels ported into XR.** Capture shows desktop status cards with paragraphs
  of instructions and a head-locked "Start Recording" pill. The viewer uses a
  different glass style and a circular bubble. Nothing in either app lets you
  author anything.
- **The UI talks about the system, not the message.** "Capture Runtime",
  "READY", "DESKTOP" and keyboard help text compete with the hologram.
- **Three copies of the look.** `ui-dom` has CSS-string tokens; `xr-ui-three`
  and `xr-ui-r3f` hard-code their own hex values and pixel sizes. No value has
  a meaning that survives the move from screen to headset.
- **Recording is a binary modal.** You are either recording or not. There is no
  way to point at something, mark a moment, or draw while you talk.

## Design tests

A proposal passes only if it meets all of these.

1. **Second nature while talking.** An expert can make any authoring action
   during a take in about a second, with one hand, without looking at a menu,
   and without pausing their speech.
2. **Parity.** Every capability is reachable on desktop, phone, VR, and AR, with
   every supported input. No feature is headset-only or desktop-only.
3. **Native idiom per device.** Parity of capability, not of layout. Each device
   gets the arrangement that is natural for it.
4. **Message first.** People and their marks are always the most prominent
   thing in view. App chrome recedes.
5. **Ready for the roadmap.** Notes, symbols, gesture-to-shape, retakes, layers,
   replies, and live multi-person sessions fit the model without new concepts.

## 1. One model for both apps

Four nouns cover capture, editing, and viewing:

| Noun | Meaning |
| --- | --- |
| **Stage** | Where a hologram plays: a volume with a floor disc. Full scale in VR or AR, tabletop scale in AR, a card in the feed. |
| **Take** | A recorded performance over time: body, hands, face, voice. |
| **Mark** | Anything authored onto the stage: pin, note, ink stroke, symbol; later replies, decisions, checkpoints. |
| **Time cursor** | Where you are in time. At "now" while live; at a past moment while editing or watching. |

Every mark has the same shape: `{ author, anchor, span, kind, content, state }`.
The anchor is a place in the world, a bone on a person (it follows them), or a
prop. Content is never anchored to the screen. This record is the carrier for
HoloGrammar (IDEA-001): intent and confidence become fields of a mark, not a
new object.

**Recording and editing are the same place.** With the cursor at "now" you are
live; drag it back and you are editing. Watching someone else's hologram is the
same stage with the cursor in their time, and replying (IDEA-018) is recording
at a moment of it. There is no separate editor app or mode to learn.

## 2. Visual language: three materials

| Material | What it is | Look |
| --- | --- | --- |
| **Presence** | People: avatars, voices, cursors, attention | Each participant has an identity hue, shown as a rim on their avatar and on everything they author |
| **Ink** | Marks: the authored message | Solid, opaque, in the author's hue, recorded, lasting. Strokes have weight; symbols have volume |
| **Light** | Chrome: tools, menus, status | Neutral, thin, never recorded. Appears from your hand or cursor and leaves when done |

Rules:

- Chrome never uses an identity hue, and marks never look like chrome. A viewer
  can always tell what a person said from what the app shows.
- Prominence order is ink, then people, then chrome. Chrome dims while a take is
  recording.
- Two reserved semantic colors only: **record red** (recording state) and
  **open amber** (unresolved: question beacons, open threads). Resolved marks
  use the author's hue, filled. Identity hues avoid red and amber.
- Text never floats bare in 3D. It always sits on a **chip**: an ink chip for
  content, a light chip for chrome. The chip is the one text container in both
  2D and 3D.

### Units that work on every display

CSS pixels are already an angle: the CSS reference pixel is about 0.0213° of
visual angle. Tokens are defined in these angular px, so one value means the
same apparent size everywhere. In XR:

```txt
size_m = px × 0.000372 × distance_m × legibility_scale
```

Two corrections apply on top:

- **Legibility scale per display.** Headsets resolve far fewer pixels per degree
  than monitors, so text and icons scale up (start at 2× on Quest 3; calibrate
  on device).
- **Target size per input, not per display.** Precision decides minimum hit
  size. Starting values to calibrate on device: mouse 24, touch 44, controller
  ray 56, hand ray and gaze-pinch 72 (angular px). Direct poke targets are
  physical, about 2 cm, whatever the distance.

### Type

One family built for legibility at low resolution: **Atkinson Hyperlegible
Next** for UI and notes, **Atkinson Hyperlegible Mono** for timecode and
numbers. Both are available as web fonts and can be baked to MSDF for
`@pmndrs/uikit`.

### Motion and feedback

- Everything emerges from its source and returns there: menus bloom from the
  summoning hand or cursor, marks grow from the fingertip, notes unfold from
  their pin.
- Chrome motion is short (120–180 ms, ease-out). The world never moves relative
  to the head without the user's action.
- A mark's reveal is part of the message: it is recorded and replays with its
  original timing.
- Hands have no haptics, so feedback has three channels: proximity glow before
  contact, a soft spatial tick on commit, controller pulses where available.
  System sounds are excluded from the capture mix.
- Reduced motion replaces movement with crossfades.

## 3. Where UI lives

No interactive UI is locked to the head. Each 3D location has a 2D
counterpart, which is how every 2D surface also exists in 3D.

| 3D location | 2D counterpart | What goes there |
| --- | --- | --- |
| Point of action (fingertip, ray hit, gaze) | Cursor or touch point | The Halo menu, ink |
| Referent (the mark or bone being edited) | Popover pinned to the object's screen position | Edit a mark: text, span, delete |
| Non-dominant hand (palm, wrist) | Bottom dock (thumb zone on phone) | Record, ink, undo, the few always-there tools |
| Stage base (ring around the floor disc) | Strip under the canvas | Time ribbon, layers, play/pause |
| Periphery (lazy-follow, upper edge of view) | Top status line | State only: recording, connection. Never controls |
| World (placed by the user) | Side sheet | Long-form: library, inbox, settings, symbol forge |

## 4. Interaction grammar

Seven verbs, plus speech. Components consume verbs, never raw devices.

| Verb | Mouse + keyboard | Touch | Controllers | Hands | Gaze-pinch (visionOS) |
| --- | --- | --- | --- | --- | --- |
| **Aim** | Hover | Finger down | Ray | Ray from pinch, or poke | Look |
| **Commit** | Click | Tap | Trigger | Pinch | Pinch |
| **Grab** | Drag | Drag | Grip | Pinch-hold and move | Look, pinch-hold, move |
| **Summon** (Halo) | Right-button hold | Long-press | Hold non-dominant menu button, flick stick | Turn non-dominant palm up, pinch-drag | Long pinch, drag |
| **Ink** | Hold Q, drag | Hold dock ink button, draw with other finger | Hold non-dominant trigger, draw with dominant | Hold non-dominant thumb–middle pinch, draw with dominant index | Halo → Ink, then pinch-drag |
| **Scrub** | Wheel over ribbon | Swipe on ribbon | Stick left/right on ribbon | Grab and slide the ribbon | Look at ribbon, pinch-drag |
| **Undo** | ⌘Z / Ctrl+Z | Dock button | B or Y | Halo west | Halo west |
| **Speak** | Hold E | Hold dock mic | Hold A or X | Speak while palm is up | Speak while pinch is held |

Principles behind the table:

- **Non-dominant hand frames, dominant hand acts.** This is the asymmetric
  pattern people already use when they hold paper and write. The non-dominant
  hand summons tools and holds modes; the dominant hand points, draws, and
  gestures. A handedness setting swaps them.
- **Modes are held, never toggled.** Ink, Halo, and speech commands last only
  while a button, key, or pinch is held. Letting go always returns you to
  performing, so you cannot get stuck in draw mode mid-sentence. One-handed
  devices get a one-stroke ink from the Halo that ends itself.
- **Speech is content unless you hold a command mode.** No wake words: they
  would end up in the recording.
- **Few bespoke gestures.** Hand gestures are limited to pinch, palm-up, and
  one alternate pinch, which current hand tracking recognizes most reliably.
  Everything else goes through the Halo.

### The Halo: one menu with fixed directions

A radial marking menu with eight sectors whose directions never change. A
novice holds and sees the ring after about 300 ms; an expert flicks in the
direction without waiting, and the menu never draws. Because the directions
are the same with a mouse, a thumb, a thumbstick, a hand, or gaze-pinch, the
muscle memory carries across every device.

Proposed top level (to validate):

| Direction | Action |
| --- | --- |
| N | Note: dictate a note pinned to what you point at |
| NE | Symbols: opens the eight primitives below |
| E | Redo |
| SE | Mark moment: bookmark "keep that" for later editing |
| S | Record / stop |
| SW | Retake from the last moment mark |
| W | Undo |
| NW | Ink: one stroke (for one-handed use) |

Symbols are the eight primitives from [spatial-language.md](spatial-language.md):
arrow (force), ring (constraint), cloud (risk), bridge (dependency), ribbon
(timeline), mirror (compare), beacon (question), seal (decision). Eight
primitives fit eight directions exactly; opposites sit opposite (beacon N,
seal S).

### Ink becomes shapes

While the ink mode is held, the dominant hand draws. On release the stroke is
recognized (arrow, ring, path, underline, cross-out), snapped to a clean
editable primitive, and bound to the nearest referent: the wrist it circled,
the prop it pointed at. The suggestion shows for about 1.5 s with a "keep as
drawn" option; doing nothing accepts it. This is the Gesture Compiler
(IDEA-004) in its smallest form.

### "This" and "here"

During a take the system keeps where you point alongside the transcript. Words
like "this", "here", and "that" are linked to what you pointed at when you said
them. Nothing appears live. In review those links show as faint suggested pins
you can accept with one commit, and they drive spatial subtitles (IDEA-014) and
clarity suggestions (IDEA-023).

## 5. Device idioms

| Device | Role | Arrangement |
| --- | --- | --- |
| Desktop | Director's chair: precise timing, typing, arranging | Third-person orbit; ribbon fully expanded with layer lanes; popovers for mark editing |
| Phone | Watch and reply | Portrait feed; tap to pause; ribbon appears on pause; long-press for the Halo; reply by voice |
| VR | Performer's stage | Full scale in the scene bubble; hands first; ribbon around the stage base; step into your ghost to retake |
| AR | The room is the stage | Hologram on your floor or table at a chosen scale; no environment by default; chips always backed for legibility against bright rooms |

Every device can do everything; each device is the best place for something.

## 6. The core loops

**Live: author while talking.** "Hold the bar here, then rotate like this."
You point at the bar; with your non-dominant hand you hold the ink pinch and
draw an arc with your dominant index; on release it becomes a rotation arrow
bound to your wrist. You flick the Halo north-east, then north, to drop a
question beacon on a risky spot. You never stop talking, and none of the tools
appear in the recording.

**Review: right after the take.** The take lands on the ribbon with your marks
as ticks and the "this/here" suggestions as faint pins. Commit the ones you
want. To fix a span, select it on the ribbon and choose Retake: you step into
your own ghost (IDEA-020), perform the span again, and the edges are blended
(IDEA-021).

**Viewer: watch, inspect, reply.** Pause at a mark tick; the stage holds the
moment and you look around the pinned point. Replying records at that moment
(IDEA-018, needs accounts).

**Live together (later).** Each person's identity hue marks their avatar,
cursor, and ink. A Halo action "look here" brings others' attention to a
referent without taking over their view (IDEA-008, IDEA-013).

## 7. Roadmap readiness

| Planned work | Provided by |
| --- | --- |
| Anchored notes (PRD-001) | Mark kind `note`, bone or world anchor, span, ribbon ticks, popover editing |
| Symbol Forge (IDEA-003) | Mark kind `symbol`; the Halo symbols ring; custom symbols added in the world-placed library |
| Gesture Compiler (IDEA-004) | Ink mode and stroke recognition |
| Claim capsules, decision stamps (IDEA-005, IDEA-027) | Mark `state` plus the seal and beacon primitives |
| Grounding signals (IDEA-007) | A second Halo ring in live sessions |
| Spatial subtitles, clarity co-director (IDEA-014, IDEA-023) | "This/here" links |
| Holo replies (IDEA-018) | Recording at a time cursor in someone else's take |
| Ghost overlay, segment retakes (IDEA-020, IDEA-021) | Ribbon span selection, Retake, Mark moment |
| Message-first editor layers (IDEA-022) | Ribbon lanes: performance, voice, environment, marks, presentation |
| Multi-person (IDEA-011, IDEA-013) | Presence material and identity hues |

## 8. Three looks for the same model

The model, grammar, and placement above are the same in all three. Only the
treatment of the materials changes.

| Look | Chrome | Ink | Strength | Risk |
| --- | --- | --- | --- | --- |
| **A. Light** (recommended) | Thin emissive lines; dark translucent backing only under text | Solid, glowing edge, author hue | Belongs to the medium; least occlusion in AR; cheap to render | Legibility on bright AR backgrounds, so backed chips are mandatory |
| **B. Studio** | Matte tactile tiles | Marker strokes, paper note cards | Warm, human, legible anywhere | Opaque tiles hide the room and the performer; reads as a whiteboard app |
| **C. Glass** | Frosted panels | Glass chips | Familiar, platform-like | Background blur is expensive in WebXR; generic; closest to what we have now |

## 9. What changes in code (later)

- **One token source** exporting plain numbers (colors, angular sizes, timings)
  from a shared package; `ui-dom` derives CSS variables from it and the 3D
  packages derive materials and meters.
- **Components specified once** in `xr-ui-core` (Chip, Halo, Ribbon, Dock,
  Popover, Status) and rendered by `ui-dom` (DOM), `xr-ui-r3f` (viewer), and
  `xr-ui-three` (capture).
- **An input layer** in `xr-runtime` that turns every device into the seven
  verbs, so components never read controllers, hands, or pointer events
  directly.
- **A Mark schema** in `@holoim/contracts` with a glTF extension; PRD-001 notes
  become the first mark kind.

## Open decisions

1. Which look: A, B, or C.
2. Whether the bimanual model (non-dominant hand holds modes) is acceptable,
   with one-stroke ink as the one-handed fallback on phones.
3. Whether voice commands are in the first version. Web Speech API support in
   Quest Browser is uncertain and needs a device check.
4. The first slice. Suggested: token source, Chip, Halo, and the verb input
   layer, shipped together with PRD-001 notes as the first mark kind.

## How to validate

- Prototype the Halo and ink on desktop and touch first, then in IWER for
  controller and hand logic. IWER proves logic, not feel: flick accuracy,
  comfort, and hand-tracking reliability need Quest 3 (hands and controllers)
  and, if available, Vision Pro.
- Measure the design tests directly: time from intent to mark, flick accuracy
  without looking, and whether speech pauses around authoring actions (gap
  length in the recorded audio before and after each mark).
