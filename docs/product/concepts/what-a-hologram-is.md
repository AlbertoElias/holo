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

## What follows for current work (2026-10-18)

Every idea now names its layer in the [idea registry](../IDEAS.md), and each
concept page opens with the layers it covers. What the lens changes in
priority:

1. **The event comes first.** Hand-tracking fidelity and avatar height
   adaptation are foundational: pointing rays, measurements, and ribbons are
   only as good as the body data and its scale. IK-solved locomotion is part
   of the recorded performance, not an inferred mark.
2. **The portal is how most people will meet holograms** (IDEA-045, with
   IDEA-042 and IDEA-043). It needs no new data, so it can start now.
3. **Meaning read from the body comes before meaning typed by the author.**
   Self-resolving pointing (IDEA-032) unlocks the Follow camera (IDEA-041),
   spatial subtitles (IDEA-014), the clarity co-director (IDEA-023), and the
   object-indexed timeline (IDEA-044). PRD-001 typed notes are parked.
4. **Provenance is a field from the first mark kind**, not a later feature
   (IDEA-024).
5. **Quick Look USDZ is a flattened preview.** It cannot carry the meaning
   layer or the portal, so it stays opt-in and is never the canonical hologram.

Parked for now: IDEA-005, 006, 007, 009, 011, 013, 015, 026, 027, 029, 030, 040.
