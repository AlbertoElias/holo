# PRD: Retake one segment

**Status:** Draft  
**Source ideas:** IDEA-021  
**Layer:** Event  
**Depends on:** evidence from recording review (IDEA-069) that small mistakes ruin useful takes  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a two-minute explanation with one fumbled sentence must be recorded
again from the start, so authors give up or send the flawed take.
After: the author selects the fumbled segment, re-performs just that part, and
the hologram plays through with no visible jump in the body.

## Problem

Embodied recordings are long and hard to repeat exactly. Full re-recording is
the main reason authors might not fix mistakes. Whether this is the real
blocker is unknown until IDEA-069 shows how often it happens.

## Primary User And Moment

An author in VR reviewing a take they mostly like, with one bad segment.

## Proposed Interaction

- In the review step, the author marks a start and end on the take.
- Capture plays the take up to the start (with a ghost, IDEA-020), then records.
- The new segment replaces the old; body, voice, and scene blend over a short
  window at each edge. The joins are marked as edited in provenance.

## Why Holograms

Video editing cuts frames; a cut in a hologram must also join the body in
space. Fair comparison: re-recording the full take.

- **Anchored to the event:** replaces a time span of the event.
- **Read from the body:** the new segment is a new performance.
- **Intent, not a view:** repair of the event; no camera choice.
- **Works on a flat phone:** recipients see a seamless hologram; edits visible on inspection.
- **Lost as a video:** a jump-free join in 3D, from any viewpoint.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Review timeline with in/out marks; ghost lead-in | Mark segment, record |
| Phone portal | Seamless playback; edited spans visible in provenance inspection | None new |
| Desktop | Same as phone | Same |
| Still image or Quick Look | Unaffected | None |

## In Scope

- [ ] One segment retake per take, with blended joins and provenance marks.

## Out Of Scope

- [ ] Multi-segment editing, overdubs, the full editor (IDEA-022).

## Success Signals

- [ ] **Technical:** a join shows no pose jump greater than a few centimeters at hands and feet.
- [ ] **Authoring:** see the trial below.

## Risks And Open Questions

- [ ] How much automatic blending is necessary?
- [ ] Root position drift between the take and the retake.

## Comparison And Learning

Task: an author fixes one wrong sentence in a 90-second take. Compare segment
retake with full re-recording. Measures: time to a satisfactory message, author
preference, and recipients' ability to spot the join. Continue if faster and
joins go unnoticed; park if IDEA-069 shows trimming is enough.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Recommended sequencing: only after PRD-051 produces evidence.

## Links

- Concept: [hologram authoring](../concepts/hologram-authoring.md)
- Research: [open questions](../research/open-questions.md) (questions 5, 14)
- Related PRDs: [PRD-051 recording review](PRD-051-recording-review.md),
  [PRD-014 ghost overlay](PRD-014-ghost-take-overlay.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
