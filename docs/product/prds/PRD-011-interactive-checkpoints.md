# PRD: Interactive checkpoints

**Status:** Draft  
**Source ideas:** IDEA-017  
**Layer:** Meaning (added)  
**Depends on:** IDEA-045 (portal view, approved), IDEA-032 for referent answers  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author has no way to know whether a recipient followed a key point
until the recipient gets it wrong in the real task.
After: at a key moment the hologram pauses and asks the recipient to find
something in the scene ("tap the part I just tightened"); the recipient gets
immediate feedback and the author later sees how many found it.

## Problem

Passive watching hides misunderstanding. Quizzes after a video test recall of
words, not spatial understanding. A checkpoint that asks for a spatial answer
tests what holograms claim to carry.

## Primary User And Moment

An author teaching a procedure; the recipient on a phone at the moment just
after a critical step.

## Proposed Interaction

- In review, the author marks a moment as a checkpoint and picks a referent as
  the answer (often the one they pointed at, from IDEA-032).
- At playback the hologram pauses; the portal opens to Free so the recipient can
  look around; they tap what they think is right.
- Right: continue. Wrong: Follow eases to the referent and replays the step.

## Why Holograms

The answer is a referent in 3D space, which a video quiz cannot ask for. Fair
comparison: the same hologram with a multiple-choice text question at the same
moment.

- **Anchored to the event:** the answer is a referent at a moment.
- **Read from the body:** the answer defaults to what the author pointed at.
- **Intent, not a view:** "find this", each device decides how to show the scene.
- **Works on a flat phone:** tap in the portal while paused.
- **Lost as a video:** asking the viewer to locate something in space.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Playback pauses with a short spoken or written prompt | Point and pinch the answer |
| Phone portal | Paused portal in Free with the prompt | Tap the answer |
| Desktop | Same | Click |
| Still image or Quick Look | Dropped | None |

## In Scope

- [ ] One checkpoint type: locate a referent.
- [ ] Pause, Free exploration, answer, feedback, replay.
- [ ] An aggregate count of correct answers for the author, without per-viewer tracking.

## Out Of Scope

- [ ] Text questions, scoring, grading, accounts.

## Success Signals

- [ ] **Technical:** a checkpoint round-trips through the pipeline and pauses on time.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Friction: checkpoints may annoy recipients who already understood.
- [ ] Privacy of the aggregate (relates to IDEA-025).

## Comparison And Learning

Task: a four-step procedure followed by doing it on a supplied object. Compare
with checkpoints and without. Measures: task errors, completion time including
watching, and voluntary rewatching. Continue if errors drop; revise if recipients
skip or resent checkpoints; park if no difference.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [async holograms](../concepts/async-holograms.md)
- Research: [open questions](../research/open-questions.md) (question 1)
- Mockups: none
- Feature brief: none
- Implementation issue: none
