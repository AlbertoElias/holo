# PRD: True-scale measurements from gestures

**Status:** Draft  
**Source ideas:** IDEA-034  
**Layer:** Meaning (read)  
**Depends on:** hand-tracking fidelity and avatar height adaptation (scale must be trustworthy)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: when the author holds their hands apart and says "about this big", a
phone viewer cannot judge the distance from one angle and has to guess.
After: the gap between the hands shows as a real distance ("about 40 cm"),
so the recipient can repeat the size accurately.

## Problem

Size and height are among the things video loses most; the lens treats true
scale as fact. A hologram knows the distance between the author's hands.

## Primary User And Moment

An author describing a size or height; a recipient who must act on it
(cut, buy, place).

## Proposed Interaction

- Detect a sizing gesture: two hands (or a hand and the floor) held still,
  facing each other or flat, during speech with size words.
- Show a measurement line between them with a rounded value in the viewer's units.
- Inferred style; the author can dismiss in review.

## Why Holograms

Video cannot measure the gap between hands without a reference object. Fair
comparison: the same hologram without measurements.

- **Anchored to the event:** between two body parts at a moment.
- **Read from the body:** entirely.
- **Intent, not a view:** the size; units adapt to the viewer.
- **Works on a flat phone:** a line and a number read at card size.
- **Lost as a video:** the real distance.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Measurement line at true scale with value | Toggle |
| Phone portal | Same line; value clamped for legibility | Toggle |
| Desktop | Same | Same |
| Still image or Quick Look | Line and value in a still; dropped in Quick Look | None |

## In Scope

- [ ] Detection of two-hand and hand-to-floor sizing gestures; measurement display; units.

## Out Of Scope

- [ ] Measuring scene objects; rulers or authoring tools.

## Success Signals

- [ ] **Technical:** values within a few centimeters of the true gap on a physical headset.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Which gestures signal a measurement rather than ordinary emphasis?
- [ ] Scale must be right end to end, including avatar fit.

## Comparison And Learning

Task: recipients mark a remembered size on paper or with their hands after
watching. Compare with and without measurements. Measures: error versus the
true gap. Continue if error drops; park if false measurements appear often.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md),
  [embodied communication](../concepts/embodied-communication.md)
- Research: [open questions](../research/open-questions.md) (question 4)
- Mockups: none
- Feature brief: none
- Implementation issue: none
