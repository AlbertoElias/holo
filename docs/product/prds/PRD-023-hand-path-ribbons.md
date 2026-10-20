# PRD: Hand-path ribbons

**Status:** Draft  
**Source ideas:** IDEA-033  
**Layer:** Meaning (read)  
**Depends on:** hand-tracking fidelity (in verification), IDEA-045 portal (approved)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: when the author demonstrates a motion (a twist, a sweep, an arc), a
recipient sees it once, from one angle, and cannot reproduce its shape or size.
After: the motion leaves a ribbon in the air at true size and speed; the
recipient can pause and orbit the ribbon, then reproduce the motion correctly.

## Problem

Movement demonstrations are a core promise ("how to swing", "turn it like
this"). Motion blurs in video and depth is ambiguous.

## Primary User And Moment

An author demonstrating a movement in VR; a recipient who will repeat it.

## Proposed Interaction

- Detect demonstration spans: a hand moving deliberately while speech refers to
  motion, or a sustained trajectory above a speed threshold.
- Leave a ribbon from the moving hand (wrist or fingertip), fading after a few
  seconds unless the viewer pauses.
- Paused, the ribbon stays fully visible and the portal can orbit it.

## Why Holograms

A video shows the path from one angle; a 3D ribbon can be seen from the side.
Fair comparison: the same hologram without ribbons, and a video.

- **Anchored to the event:** the path of a body part over a time span.
- **Read from the body:** the path is the motion itself.
- **Intent, not a view:** shows the motion; each device frames it.
- **Works on a flat phone:** the ribbon gives depth cues when orbited.
- **Lost as a video:** the 3D path at true scale.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Ribbon at true scale | Toggle ribbons |
| Phone portal | Same ribbon; persists while paused | Toggle; orbit while paused |
| Desktop | Same | Same |
| Still image or Quick Look | Ribbon baked into a still; dropped in Quick Look | None |

## In Scope

- [ ] Demonstration-span detection; ribbon rendering with fade; inferred provenance.

## Out Of Scope

- [ ] Cleaned shapes (IDEA-004); comparison with the viewer's motion (IDEA-040, parked).

## Success Signals

- [ ] **Technical:** ribbons match recorded hand positions within tracking accuracy.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] When does a trace clarify a motion rather than clutter the scene?
- [ ] Detection of demonstration spans versus ordinary gesturing.

## Comparison And Learning

Task: reproduce a demonstrated motion (shape, size, direction) after watching.
Compare ribbons, no ribbons, and video. Measures: reproduction accuracy judged
from a recording of the recipient. Continue if ribbons improve accuracy; park
if clutter outweighs it.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md),
  [design language](../concepts/design-language.md)
- Research: [open questions](../research/open-questions.md) (question 4)
- Mockups: none
- Feature brief: none
- Implementation issue: none
