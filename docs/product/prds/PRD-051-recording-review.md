# PRD: Review a take before sending

**Status:** Draft  
**Source ideas:** IDEA-069  
**Layer:** Event  
**Depends on:** none in capture; pairs with IDEA-046 publish  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author finishes a take and has to export it without watching it, so
mistakes (a false start, a long silence at the end) only show up after upload.
After: the author watches the take in the headset, discards and re-records if
it is wrong, or trims the start and end, then exports or publishes only what
they are happy with.

## Problem

A 2026-10-20 source check found no preview or discard control in the VR
recording panel. The authoring concept calls preview and discard the baseline,
trimming the next step, and segment retakes (IDEA-021) only if evidence shows
small mistakes ruin otherwise useful messages. This PRD also produces that evidence.

## Primary User And Moment

An author in a Quest, right after stopping a recording.

## Proposed Interaction

- After stopping, the take plays back in place (the author can step aside and
  watch themselves at true scale).
- Three choices: Keep, Discard, Trim. Trim sets start and end points.
- Each review logs what was wrong in discarded takes (author picks a reason) as
  evidence for PRD-015.

## Why Holograms

Event repair, not meaning. Fair comparison: today's export-without-review.

- **Anchored to the event:** edits the event's own time span.
- **Read from the body:** the take is unchanged except trimmed ends.
- **Intent, not a view:** no camera choice.
- **Works on a flat phone:** recipients get a cleaner message.
- **Lost as a video:** watching yourself at true scale from outside.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Playback of the take in place, review panel | Keep, Discard, Trim |
| Phone portal | Receives the trimmed hologram | None |
| Desktop | Not applicable | None |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] In-headset playback after a take; keep, discard, trim; discard-reason log.
- [ ] Trimmed takes export correctly through the real pipeline.

## Out Of Scope

- [ ] Segment retakes, editing lanes, marks review.

## Success Signals

- [ ] **Technical:** a trimmed export plays in the viewer with no leftover frames.
- [ ] **Authoring:** see below.

## Risks And Open Questions

- [ ] Which smallest repair saves an otherwise useful message?
- [ ] Memory limits holding a take for playback on the headset.

## Comparison And Learning

Over two weeks of real recording, count kept, trimmed, and discarded takes and
why. If most discards are mid-take mistakes in long takes, that supports
PRD-015; if trimming fixes most, park retakes.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Cheap, needs no new data, and produces evidence for authoring PRDs.

## Links

- Concept: [hologram authoring](../concepts/hologram-authoring.md)
- Research: [open questions](../research/open-questions.md) (question 14)
- Related PRDs: [PRD-015 segment retakes](PRD-015-segment-retakes.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
