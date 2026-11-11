# PRD: Co-presence portal

**Status:** Parked  
**Source ideas:** IDEA-011  
**Layer:** Event  
**Depends on:** live sessions (none); presence evidence from PRD-046  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md).
Rationale: a remote participant shown live at human scale needs realtime
streaming of body and voice, which is not a current commitment, and we do not
yet know which cues make someone feel present. PRD-046 asks that question
with recorded holograms first. Revisit when PRD-046 identifies the cues that
matter and a live session is approved.

## User Outcome

Before: a remote colleague joining a discussion in a real room is a face on a
laptop screen, outside the space where the work is happening.
After: they appear at human scale in the room, at a sensible place, with a
shared eye line, and the people in the room talk to them as if they were there.

## Problem

Remote participation in physical work loses scale, gaze, and shared reference.

## Primary User And Moment

Two people in a workshop with AR headsets and one remote expert in VR.

## Proposed Interaction

- The remote participant's body and voice stream live into the room.
- Placement respects real furniture and eye level (depth-aware).
- Everything is recorded, so the session is a hologram afterwards.

## Why Holograms

Fair comparison: the same discussion with the expert on a video call.

- **Anchored to the event:** the remote person is placed in the real room.
- **Read from the body:** their live body is the event.
- **Intent, not a view:** each local device renders them for its viewer.
- **Works on a flat phone:** a phone participant sees the room through a portal.
- **Lost as a video:** scale, placement, and shared eye line.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Remote person at human scale in the room | Walk around |
| Phone portal | Portal into the shared room | Portal gestures |
| Desktop | Same | Mouse |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Live body and voice streaming for one remote participant; placement.

## Out Of Scope

- [ ] Volumetric video, more than one remote participant.

## Success Signals

- [ ] **Presence and task:** local participants coordinate with the remote
  expert as well as with a local one on a physical task.

## Risks And Open Questions

- [ ] What fidelity is needed before it feels meaningfully present?
- [ ] Network latency and comfort.

## Comparison And Learning

If reopened: a physical task guided by a remote expert. Compare co-presence
with a video call. Measures: errors, time, felt presence.

## Links

- Concept: [embodied communication](../concepts/embodied-communication.md),
  [live VR and AR dialogue](../concepts/live-vr-ar-dialogue.md)
- Research: [open questions](../research/open-questions.md) (question 11)
- Related PRDs: [PRD-046 lifelike presence](PRD-046-lifelike-presence.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
