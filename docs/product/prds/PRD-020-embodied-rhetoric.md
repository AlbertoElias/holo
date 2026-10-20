# PRD: Emphasis read from delivery

**Status:** Draft  
**Source ideas:** IDEA-028  
**Layer:** Meaning (read)  
**Depends on:** voice and body data in the event; IDEA-024 (provenance) for inferred marks  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a recipient scanning a long hologram cannot tell which moments the
author stressed as most important.
After: moments the author delivered with emphasis (louder, slower, a strong
gesture, a held pause) are marked on the timeline and gently highlighted, and
the author can confirm or remove each before sending.

## Problem

Emphasis is carried by delivery, and authors rarely add it by hand. A video
viewer can hear emphasis only by watching in full.

## Primary User And Moment

A recipient short on time, on a phone, who wants the key moments of a
four-minute explanation. The author confirms marks at review.

## Proposed Interaction

- Detect emphasis from voice energy and pace and from gesture amplitude.
- Show detected moments as timeline marks (inferred style) and a subtle glow on
  the author during them.
- Author review lists detected moments to keep or dismiss; kept ones stay inferred.

## Why Holograms

Prosody exists in video audio too, but gesture amplitude in 3D does not.
Fair comparison: the same hologram with author-made chapter marks.

- **Anchored to the event:** marks are moments, glow on the author's body.
- **Read from the body:** entirely read from delivery.
- **Intent, not a view:** says "this matters"; Follow may dwell there.
- **Works on a flat phone:** timeline marks and glow in the portal.
- **Lost as a video:** gesture amplitude measured in 3D.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Subtle glow on the author during emphasis | Jump to next emphasis |
| Phone portal | Timeline marks and glow | Tap a mark |
| Desktop | Same | Click a mark |
| Still image or Quick Look | Dropped | None |

## In Scope

- [ ] Emphasis detection; timeline marks; author confirm or dismiss.

## Out Of Scope

- [ ] Inferring emotion, urgency, or uncertainty (the registry warns against
  substituting inferred emotion for intent).

## Success Signals

- [ ] **Technical:** authors agree with at least 70 percent of detected moments.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Which expressive signals can be read reliably, and which must be explicit?
- [ ] Cultural and personal variation in delivery.

## Comparison And Learning

Task: recipients list the three key points after a capped viewing time.
Compare emphasis marks with author chapter marks and no marks. Measures: recall
of the author's own key points. Continue if read emphasis matches author chapters
at lower author effort; park if detection disagrees with authors.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [embodied communication](../concepts/embodied-communication.md)
- Research: [open questions](../research/open-questions.md) (question 6)
- Mockups: none
- Feature brief: none
- Implementation issue: none
