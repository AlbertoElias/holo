# PRD: Understanding Mirror

**Status:** Parked  
**Source ideas:** IDEA-006  
**Layer:** Conversation  
**Depends on:** Holo Replies (PRD-012), recorded object motion (PRD-043)  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md).
Rationale: the mirror needs a recipient to record their own reconstruction
in the same space, which needs replies and manipulable objects that do not
exist yet, and its open question (showing mismatch without shaming) is a
social-design problem that should not lead. Revisit when PRD-012 and PRD-043
have shipped and a recipient trial shows misunderstandings the author never
learns about.

## User Outcome

Before: an author only learns a recipient misunderstood when the recipient does
the task wrong.
After: the recipient rebuilds what they understood (arranges the parts, repeats
the motion) in the same scene; the author sees their version beside the
original and can correct the specific difference.

## Problem

Saying "got it" does not show understanding. Reconstruction does, and in a
hologram it can happen in the same space as the original explanation.

## Primary User And Moment

A recipient who has watched an assembly explanation; the author checking before
the recipient does the real task.

## Proposed Interaction

- After watching, the recipient opens a mirror: the original scene with the
  objects reset, where they arrange or move them as they understood.
- The result is a reply (PRD-012). The author sees both side by side, with
  differences in position or order highlighted.
- The comparison is shown privately to the author and the recipient only.

## Why Holograms

Reconstruction in the same scene and scale makes the difference measurable.
Fair comparison: the recipient explaining back over a call.

- **Anchored to the event:** the same scene, objects, and scale.
- **Read from the body:** the recipient's reconstruction is their own performance.
- **Intent, not a view:** shows a difference; devices decide framing.
- **Works on a flat phone:** arranging objects by drag in the portal.
- **Lost as a video:** a side-by-side comparison in shared space.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Original and reconstruction side by side | Grab and place |
| Phone portal | Same scene; drag objects | Drag |
| Desktop | Same | Mouse |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Mirror scene, reconstruction as a reply, private difference view.

## Out Of Scope

- [ ] Automatic grading or AI judgement of understanding.

## Success Signals

- [ ] **Communication:** authors catch misunderstandings before the real task.

## Risks And Open Questions

- [ ] How should mismatch be shown without shaming users?
- [ ] Reconstruction effort may be too high for recipients.

## Comparison And Learning

If reopened: compare mirror with explaining back over a call before an assembly
task. Measures: errors in the real task and the recipient's comfort. Park again
if recipients find it like a test.

## Links

- Concept: [communication protocols](../concepts/communication-protocols.md)
- Research: [open questions](../research/open-questions.md) (question 6)
- Related PRDs: [PRD-012 Holo Replies](PRD-012-holo-replies.md),
  [PRD-043 explain with an object](PRD-043-explain-with-an-object.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
