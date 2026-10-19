# What a Hologram Is

**Status:** Working philosophy, agreed 2026-10-18. It is the lens for every
idea, PRD, and design proposal; each one should say how it passes the test at
the end of this page.

## Definition

**A hologram is a recording of an event, not of a view.**

A video stores what one camera saw: the view is fixed when it is recorded. A
hologram stores what happened: a person's body, voice, and attention, in a
place, over time, at true scale. Every view of it is made later, when someone
watches.

A video can be moved through in time. A hologram can be moved through in time
**and in space**.

## Three layers

| Layer | What it holds | Who shapes it |
| --- | --- | --- |
| **Event** | Body, hands, face, voice, scene, objects, and time, at true scale | The author by performing; editing tools repair it (trim, retake) |
| **Meaning** | What matters: references ("this" is the rock), emphasis, suggested viewpoints, notes, symbols | Read from the body first; the author confirms or adds |
| **View** | Camera, scale, placement, playback, controls | The viewer and their device, at playback |

Everything we build belongs to exactly one layer. The design-language
concept's three materials line up with them: Presence shows the event, Ink
shows meaning, and Light is the view's chrome.

## Principles

1. **Anchor to the event, never to the screen.** Anything added is tied to a
   body part, an object, a place, or a moment. Only the viewer's own controls
   live on the screen.
2. **Reveal before adding.** The body is the native language: pointing,
   looking, reaching, sizing, walking. First make explicit what the body
   already said; ask the author to write only what the body could not say.
3. **The author directs attention, never the camera.** The author says what
   matters and where it is. The viewer's device decides how to show it: a
   sound from that direction in a headset, an eased camera move on a phone, a
   highlight in a still image.
4. **The intent stays the same; the presentation adapts to the device.** Every
   meaning-layer element says how it appears at each step: headset, phone AR,
   phone portal, flat screen, still image. If it only works at the top, it is
   a niche feature, not part of the medium.
5. **Time and space are both ways to move through it.** Pausing does not stop
   the experience; it opens up the space.
6. **True scale is fact.** Sizes and positions are real. Rescaling is the
   viewer's choice: visible, labeled, and reversible.
7. **Recorded, inferred, and added stay distinguishable.** The viewer can
   always tell what the author did, what the system read from their body, and
   what was added afterwards.

## Viewing: the screen is a portal

On a flat screen a hologram is a portal into a 3D world, not a video player.

- **Phone.** Moving the phone in real space moves the camera in the
  hologram's world. Zooming is a continuum: zoomed in, you are inside the world
  looking through the portal; zoomed out, the hologram becomes an object you
  see in third person.
- **Computer.** The mouse rotates the hologram; the wheel or trackpad zooms
  between the same two ends.
- **Headset.** The portal disappears: you stand in the world, or the world
  stands in your room.

Device limits: full position tracking on a phone needs a WebXR AR session
(Android Chrome) or a native ARKit app; iPhone web can only read orientation,
so its portal turns but does not travel without touch input.

**One viewer control: Follow or Free.** In Follow, the device carries out the
author's intent: a guided camera, attention cues, suggested viewpoints. In
Free, the viewer moves through time and space on their own. Each device idiom
is a different way of doing Follow and Free.

## What a hologram can hold

Anything that has a place and a moment in the event: people, voices,
objects, places, paths, marks. Things without a place (a chart, a document, a
link) must be given one before they belong: held in a hand, set on a surface,
pinned to a moment. This also limits clutter.

## The test

1. Is it tied to the event (body, object, place, moment), not the screen?
2. Could it be read from the performance before asking the author?
3. Does it express what matters, rather than dictate a view?
4. Does it still work on a flat phone?
5. Would it lose its meaning if the hologram were a video? If not, it is not
   native to holograms.

## Existing work through this lens (2026-10-18)

### Event: everything else is derived from it

| Item | Reading |
| --- | --- |
| Hand-tracking fidelity, headset input recording (TODOS) | Foundational. Pointing, sizing, and ribbons are only as good as the hands. |
| Avatar height adaptation (TODOS) | Raised. If the avatar's size is wrong, true scale is wrong, so pointing rays and measurements are wrong. |
| Locomotion animations (TODOS) | Keep, but synthesized motion is inferred, not recorded: mark it so in the data (principle 7). |
| IDEA-012 hybrid face | Event fidelity for expression. Later. |
| Quick Look USDZ (shipped, opt-in) | A flattened copy that cannot hold the meaning layer. A preview, never the hologram. |

### View: how most people will meet holograms

| Item | Reading |
| --- | --- |
| **IDEA-045 portal view** | Foundation of viewing on 2D devices. Includes IDEA-042 (tilt) and IDEA-043 (freeze to orbit). |
| IDEA-041 attention-following camera | The Follow mode of the portal. Needs IDEA-032 data. |
| IDEA-039 author's-eye view | A viewpoint choice inside the portal. Async twin of IDEA-013. |
| IDEA-036 look-here cues | View behavior driven by meaning, not something the author writes. Async twin of IDEA-008. |
| IDEA-010 role lenses | A view filter over the meaning layer. |

### Meaning read from the body (build these before authored marks)

IDEA-032 self-resolving pointing comes first: IDEA-014 spatial subtitles,
IDEA-023 clarity co-director, IDEA-041, and IDEA-044 object-indexed timeline
all depend on it. IDEA-033 hand-path ribbons, IDEA-034 gesture measurements,
and IDEA-038 ghost frames are also derived.

### Meaning added by the author (the fallback)

| Item | Reading |
| --- | --- |
| IDEA-002 / PRD-001 anchored notes | Reframed. Typed notes are the fallback for what the body could not say, shown per device, not a timeline caption. PRD-001 is parked. |
| IDEA-004 gesture compiler, IDEA-003 symbols | Authored during the performance, so they stay close to the body. Keep. |
| IDEA-035 "stand here" markers | Authored attention intent; Follow mode carries it out. |
| IDEA-037 proximity notes | Works on phones through the portal, not only in headsets. |
| IDEA-028 rhetoric controls, IDEA-016 branching, IDEA-017 checkpoints | Meaning-layer marks; each needs a per-device rendering. |
| IDEA-001 HoloGrammar | The meaning layer's schema: the design-language Mark record. |
| IDEA-024 provenance | Becomes a required field (recorded, inferred, added) on every mark from the first version, not a later feature. |

### Editing the event

IDEA-020 ghost overlay, IDEA-021 segment retakes, IDEA-022 layered editor, and
IDEA-019 semantic diff stay as creation tools; IDEA-019 now compares both the
event and the meaning layers.

### Conversation and later

IDEA-018 Holo Replies becomes natural: a reply is a new event placed at a
moment and place inside another one. It still needs accounts. IDEA-025 meaning
heatmap becomes hologram-specific (where viewers stood and looked), with the
privacy question unchanged. Parked for now: IDEA-005, 006, 007, 009, 011, 013,
015, 026, 027, 029, 030, 040.

### Open alignment with the design-language concept

That concept is consistent with these principles (marks are never anchored to
the screen; "this/here" links come from pointing). Two gaps for its owner:
its viewer loop moves only through time, with no portal and no Follow/Free;
and its suggested first slice ships PRD-001 typed notes as the first mark
kind, where this lens would start with derived "this/here" links.
