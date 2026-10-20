# PRD: Give an image or chart a place

**Status:** Draft  
**Source ideas:** IDEA-061  
**Layer:** Meaning (added)  
**Depends on:** meaning-layer record (PRD-003); IDEA-062 for adding during the take  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author who needs a photo, a chart, or a document to make their point
sends it separately, and the recipient has to match it to the moment in the
hologram where it was discussed.
After: the image is in the hologram, held in the author's hand or set on a
surface at the moment they talk about it, and the recipient sees it there from
any viewpoint.

## Problem

The lens says things without a place must be given one before they belong:
held, set on a surface, or pinned to a moment. This limits clutter and keeps
the image tied to the explanation.

## Primary User And Moment

An author explaining with a reference image or chart; the recipient on a phone.

## Proposed Interaction

- One media type first: a still image (photo, chart screenshot).
- The author brings it into capture before recording, then during the take
  holds it like a card or sets it on a surface.
- It is recorded as an object with a transform track (shared with IDEA-059)
  and a reveal time.

## Why Holograms

Video can cut to an image, but then the speaker and space vanish. Here the image
stays in the scene beside the speaker. Fair comparison: the image sent
separately alongside the hologram.

- **Anchored to the event:** held or placed, at a moment.
- **Read from the body:** placed by the author's hands, no separate authoring.
- **Intent, not a view:** "this image belongs here"; each device keeps it legible.
- **Works on a flat phone:** the portal can face the image toward the camera on request.
- **Lost as a video:** the image as an object in the shared space.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Card at true size in hand or on a surface | Walk close |
| Phone portal | Same; tap to face and enlarge | Tap |
| Desktop | Same | Click |
| Still image or Quick Look | Visible in stills; Quick Look if conversion keeps textures | None |

## In Scope

- [ ] One still image per recording, held or placed, exported in the GLB.

## Out Of Scope

- [ ] Video, charts as live data, sound, animation, simulations.

## Success Signals

- [ ] **Technical:** the image round-trips and stays legible on a phone when tapped.
- [ ] **Communication:** see below.

## Risks And Open Questions

- [ ] Which added layer clarifies a specific explanation instead of cluttering it?

## Comparison And Learning

Task: an explanation that depends on a reference photo. Compare in-scene image
with separately sent image. Measures: correct answers and matching the image
to the right moment. Continue if in-scene wins; park if separate sending is as good.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Shares the object-motion capability with PRD-043.

## Links

- Concept: [hologram authoring](../concepts/hologram-authoring.md)
- Research: [open questions](../research/open-questions.md) (question 13)
- Related PRDs: [PRD-043 explain with an object](PRD-043-explain-with-an-object.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
