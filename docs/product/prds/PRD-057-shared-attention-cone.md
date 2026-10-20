# PRD: Shared attention cone in live sessions

**Status:** Parked  
**Source ideas:** IDEA-013  
**Layer:** Meaning (read)  
**Depends on:** live sessions (none); evidence from the async twin (PRD-029)  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md).
Rationale: it is the live twin of the author's-eye view (IDEA-039, PRD-029),
which can be tested on recorded holograms now, and showing where live people
look raises a surveillance concern that needs evidence of benefit first.
Revisit when PRD-029 shows a gaze cone helps and a live session is approved.

## User Outcome

Before: in a live session, nobody can tell what a remote participant is looking
at, so "this one?" needs a back-and-forth.
After: each participant can see a soft cone of where others are looking, and
confirms shared reference at a glance.

## Problem

Gaze is a key reference cue, weak through headsets and portals.

## Primary User And Moment

Participants in a live VR or AR session discussing parts.

## Proposed Interaction

- Each participant's head (and gaze if available) shows as a faint cone, only
  while they speak or when someone asks.
- Each participant can turn off their own cone.

## Why Holograms

Fair comparison: no cones.

- **Anchored to the event:** participants' heads and gaze.
- **Read from the body:** entirely.
- **Intent, not a view:** shows attention, moves no one's view.
- **Works on a flat phone:** cones through the portal.
- **Lost as a video:** a visible line of attention in shared space.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Faint cones from others' heads | Own cone on or off |
| Phone portal | Same | Same |
| Desktop | Same | Same |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Live cones with speaking-only default and personal opt-out.

## Out Of Scope

- [ ] Recording others' gaze without consent; analytics.

## Success Signals

- [ ] **Communication:** faster confirmed shared reference with no comfort cost.

## Risks And Open Questions

- [ ] How can it help without becoming surveillance?

## Comparison And Learning

If reopened: live session task of identifying parts, cones on and off.
Measures: time to shared reference and comfort ratings.

## Links

- Concept: [live VR and AR dialogue](../concepts/live-vr-ar-dialogue.md)
- Research: [open questions](../research/open-questions.md) (questions 11, 17)
- Related PRDs: [PRD-029 author's-eye view](PRD-029-authors-eye-view.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
