# PRD: Proximity notes

**Status:** Draft  
**Source ideas:** IDEA-037  
**Layer:** Meaning (added)  
**Depends on:** IDEA-045 portal (approved), meaning-layer record (PRD-003)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: detail that only matters to a viewer who goes to look at one part has to
be spoken in the main timeline, slowing everyone else down.
After: the author leaves a short voice note at a place; it plays only when a
viewer moves close to it, in a headset or through the phone portal.

## Problem

Explanations mix the main story with optional depth. Space is a natural index
for optional depth: you get the detail where you look for it.

## Primary User And Moment

An author recording a walkthrough of a space; a curious recipient exploring in Free.

## Proposed Interaction

- In capture, the author stands at a place and records a short voice note
  with a held gesture; the note is pinned there.
- Viewers see a small marker; approaching it (walking, or zooming the portal
  close) plays the note with the main playback paused.

## Why Holograms

A video cannot be explored, so it cannot reveal by proximity. Fair comparison:
the same detail spoken in the main timeline.

- **Anchored to the event:** a place.
- **Read from the body:** the author's position places it.
- **Intent, not a view:** "detail lives here"; each device decides what "close" is.
- **Works on a flat phone:** zooming close in the portal counts as approaching.
- **Lost as a video:** content revealed by where you go.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Small marker; note plays on approach | Walk close |
| Phone portal | Marker; plays when zoomed close | Pinch in |
| Desktop | Same as phone | Wheel in |
| Still image or Quick Look | Dropped | None |

## In Scope

- [ ] Recording a place note in capture; proximity playback on phone and desktop.

## Out Of Scope

- [ ] Text notes (PRD-001 territory); notes in the viewer's real space (IDEA-015, parked).

## Success Signals

- [ ] **Technical:** notes trigger reliably at a defined distance.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] How do proximity notes coexist with the author's timeline?

## Comparison And Learning

Task: a walkthrough with two optional details. Compare proximity notes with
details in the main timeline. Measures: total viewing time, recall of main
points, and recall of details for viewers who wanted them. Continue if main
recall holds and curious viewers find details.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md),
  [async holograms](../concepts/async-holograms.md)
- Research: [open questions](../research/open-questions.md) (question 9)
- Mockups: none
- Feature brief: none
- Implementation issue: none
