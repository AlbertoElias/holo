# PRD: Object-indexed timeline

**Status:** Draft  
**Source ideas:** IDEA-044  
**Layer:** View  
**Depends on:** IDEA-032 (pointing links), IDEA-045 portal (approved)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: to find what the author said about one part, a recipient scrubs
through the whole recording.
After: the recipient taps the part in the scene and sees every moment the
author pointed at it, and jumps straight to each.

## Problem

Long explanations are revisited by topic, and in spatial explanations the topic
is often a thing. A hologram knows which things were pointed at, when.

## Primary User And Moment

A recipient returning to a recording to check what was said about one part.

## Proposed Interaction

- Paused in Free, tapping a referent lists the moments it was pointed at,
  shown as marks on the timeline.
- Selecting a mark jumps there in Follow.
- Things never pointed at show nothing.

## Why Holograms

A video can be indexed by time or transcript, not by the things in the scene.
Fair comparison: transcript search.

- **Anchored to the event:** referents and moments.
- **Read from the body:** the index comes from pointing.
- **Intent, not a view:** an index; devices choose presentation.
- **Works on a flat phone:** tap in the portal.
- **Lost as a video:** indexing by thing.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Marks list near the selected thing | Point and pinch |
| Phone portal | Timeline marks for the tapped thing | Tap |
| Desktop | Same | Click |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Referent-to-moments index; tap to list; jump.

## Out Of Scope

- [ ] Index by transcript topic.

## Success Signals

- [ ] **Technical:** every pointing link appears in its referent's index.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] What happens when pointing data is sparse or ambiguous?

## Comparison And Learning

Task: find everything said about one part in a three-minute recording. Compare
object index with transcript search. Measures: time and completeness. Continue
if faster and more complete.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Recommended sequencing: after IDEA-032.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md)
- Research: [open questions](../research/open-questions.md) (question 7)
- Related PRDs: [PRD-022 self-resolving pointing](PRD-022-self-resolving-pointing.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
