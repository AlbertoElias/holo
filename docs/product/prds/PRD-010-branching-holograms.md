# PRD: Two-path branching hologram

**Status:** Draft  
**Source ideas:** IDEA-016  
**Layer:** Meaning (added)  
**Depends on:** IDEA-058 (a message URL), recording review (IDEA-069)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author explaining something to mixed audiences either records one
long explanation that bores experts or several separate ones the recipient must
choose between up front.
After: the recipient reaches a fork in the same place, picks "show me the
detail" or "skip ahead", and continues in the same scene without losing their
place or viewpoint.

## Problem

Explanations are often over- or under-detailed for a given recipient. A
branching game editor is far too heavy for authors who are communicating, not
building games.

## Primary User And Moment

An author recording a procedure for both newcomers and experienced colleagues.
The recipient reaches the step where a newcomer needs more.

## Proposed Interaction

- The author records a main take and one or more short side takes from the same
  starting pose and place.
- In review, they mark a moment in the main take as a fork that links to a side
  take, with a two-word label.
- At the fork, the recipient sees two choices placed beside the author; the
  side take plays in the same scene and returns to the main take.

## Why Holograms

Branching video exists, but cuts change the camera and break spatial
continuity. Here both branches share the scene and the viewer keeps their own
viewpoint. Fair comparison: a chaptered video with an optional detail chapter.

- **Anchored to the event:** the fork is at a moment and place in the main take.
- **Read from the body:** not read; branch points are an authoring choice.
- **Intent, not a view:** branches carry content; the device keeps the view.
- **Works on a flat phone:** two choices in the portal at the fork.
- **Lost as a video:** continuity of space and viewpoint across branches.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Two labeled choices beside the author at the fork | Point and pinch |
| Phone portal | Same choices in the portal | Tap |
| Desktop | Same | Click |
| Still image or Quick Look | Main take only | None |

## In Scope

- [ ] One fork per hologram, up to two side takes, returning to the main take.
- [ ] Packaging takes so the export -> upload -> render path still works.

## Out Of Scope

- [ ] Nested branches, state, scoring, or a branching editor.

## Success Signals

- [ ] **Technical:** a branched hologram plays both paths without a camera jump.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Pose continuity between takes; may need IDEA-021 blending.
- [ ] Authoring effort may exceed recording two separate messages.

## Comparison And Learning

Task: a procedure with one optional detail step, for novices and experts.
Compare a branched hologram with a chaptered video. Measures: task completion
for novices, time for experts, author effort. Continue if both groups do as well
in less time; park if authors find it harder than two recordings.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [async holograms](../concepts/async-holograms.md)
- Research: [open questions](../research/open-questions.md) (question 1)
- Mockups: none
- Feature brief: none
- Implementation issue: none
