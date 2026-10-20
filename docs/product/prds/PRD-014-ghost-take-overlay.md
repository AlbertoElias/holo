# PRD: Ghost of the previous take while recording

**Status:** Draft  
**Source ideas:** IDEA-020  
**Layer:** Event  
**Depends on:** recording review (IDEA-069) so prior takes exist in capture  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author re-recording a demonstration cannot see where they stood or
how they moved last time, so takes drift and segments do not match.
After: while recording, the author sees a translucent ghost of their previous
take and can match position and timing, so the new take lines up with the old.

## Problem

Consistency matters for demonstrations, choreography, and for blending retakes
(IDEA-021). Video creators use onion-skinning for the same reason.

## Primary User And Moment

An author in VR on their second or third take of the same demonstration.

## Proposed Interaction

- After a take, "Record again with ghost" shows the last take as a faint avatar
  playing in sync from the start of recording.
- The ghost is never exported; it exists only in capture.

## Why Holograms

Onion-skinning in video is 2D; here the ghost is a full-body 3D performance at
true scale, so the author can match position in the room. Fair comparison:
re-recording without the ghost.

- **Anchored to the event:** the ghost is the prior event in the same place.
- **Read from the body:** entirely the prior performance.
- **Intent, not a view:** an authoring aid, not shown to recipients.
- **Works on a flat phone:** not applicable; capture-only.
- **Lost as a video:** matching a full-body path in 3D.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Translucent ghost avatar during recording | Toggle in the recording panel |
| Phone portal | Not shown | None |
| Desktop | Not shown | None |
| Still image or Quick Look | Not shown | None |

## In Scope

- [ ] Ghost playback of the last take during recording in capture.

## Out Of Scope

- [ ] Multiple ghosts, automatic alignment, blending.

## Success Signals

- [ ] **Technical:** the ghost plays in sync without dropping capture frame rate.
- [ ] **Authoring:** see the trial below.

## Risks And Open Questions

- [ ] Does it improve quality enough to justify complexity?
- [ ] Physical-headset validation needed for comfort and performance.

## Comparison And Learning

Task: an author records the same 20-second demonstration three times, with
and without the ghost. Measures: positional and timing drift between takes, and
the author's preference. Continue if drift drops noticeably; park if authors
ignore the ghost.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [hologram authoring](../concepts/hologram-authoring.md)
- Research: [open questions](../research/open-questions.md) (question 14)
- Mockups: none
- Feature brief: none
- Implementation issue: none
