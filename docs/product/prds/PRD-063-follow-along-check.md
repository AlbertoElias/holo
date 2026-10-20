# PRD: Follow-along check

**Status:** Parked  
**Source ideas:** IDEA-040  
**Layer:** Conversation  
**Depends on:** hand-path ribbons (PRD-023); capturing the viewer's own motion  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md).
Rationale: comparison feedback needs the viewer's motion to be captured (a
headset) and is mainly useful in training contexts, which is a narrower
audience than the portal-first priorities. Hand-path ribbons (PRD-023) test
whether showing the demonstrated path helps at all. Revisit when PRD-023 helps
and a training trial (PRD-048) needs movement practice.

## User Outcome

Before: a learner copying a demonstrated movement cannot tell where they drift
from it.
After: the learner repeats the movement beside the author in a headset, and the
places where their hands drift from the author's are highlighted.

## Problem

Learning movements needs feedback; a video gives none.

## Primary User And Moment

A learner in a headset practising a demonstrated motion.

## Proposed Interaction

- The learner performs alongside a playback of the author.
- Drift beyond a threshold highlights on the learner's hands and the author's ribbon.
- The learner's attempt can be sent back as a reply (PRD-012).

## Why Holograms

Fair comparison: copying from a video.

- **Anchored to the event:** both performances in one space.
- **Read from the body:** both motions are captured.
- **Intent, not a view:** shows difference.
- **Works on a flat phone:** phone viewers see a sent attempt beside the original, not live practice.
- **Lost as a video:** measured drift in 3D.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Learner beside the author with drift highlights | Perform |
| Phone portal | Sent attempt beside the original | Portal |
| Desktop | Same | Mouse |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Side-by-side practice and drift highlighting in a headset.

## Out Of Scope

- [ ] Scoring, grading, camera-based tracking on phones.

## Success Signals

- [ ] **Learning:** learners reproduce the motion more accurately than from video.

## Risks And Open Questions

- [ ] Is comparison feedback useful outside training contexts?

## Comparison And Learning

If reopened: a short movement; compare follow-along with video practice.
Measures: accuracy after practice.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md)
- Research: [open questions](../research/open-questions.md) (question 4)
- Related PRDs: [PRD-023 hand-path ribbons](PRD-023-hand-path-ribbons.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
