# PRD: Ghost frames at key poses

**Status:** Draft  
**Source ideas:** IDEA-038  
**Layer:** Meaning (read)  
**Depends on:** IDEA-045 portal (approved)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: to understand a sequence of positions (the steps of a movement, the
stops of a walkthrough), a recipient must replay and pause repeatedly.
After: paused, the recipient sees translucent copies of the author at the key
poses along their path, like stop-motion they can walk around, and can see the
whole sequence at once.

## Problem

Sequences in space are hard to hold in memory from playback. Video can show
a strobe image from one angle only.

## Primary User And Moment

A recipient learning a sequence of positions; the moment they pause to review.

## Proposed Interaction

- Choose key poses automatically: pauses in motion, direction changes, and
  moments with resolved pointing.
- Paused: show up to eight ghosts along the path, the current one solid.
- Tapping a ghost jumps playback to that moment.

## Why Holograms

A strobe photo works from one angle; ghosts are full bodies in space. Fair
comparison: pausing and scrubbing without ghosts.

- **Anchored to the event:** poses at moments along the path.
- **Read from the body:** key poses chosen from motion, no authoring.
- **Intent, not a view:** shows the sequence; devices frame it.
- **Works on a flat phone:** ghosts read when the portal orbits out to third person.
- **Lost as a video:** full-body poses arranged in space.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Ghost avatars standing in the room when paused | Point at a ghost to jump |
| Phone portal | Same, best zoomed out | Tap a ghost |
| Desktop | Same | Click |
| Still image or Quick Look | One still with all ghosts; dropped in Quick Look | None |

## In Scope

- [ ] Automatic key-pose selection; ghost rendering when paused; jump-to-pose.

## Out Of Scope

- [ ] Authored key poses; ghosts during playback.

## Success Signals

- [ ] **Technical:** key poses match an author's own choice in most test recordings.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] How are key poses chosen without authoring effort?
- [ ] Rendering cost of several avatars on phones.

## Comparison And Learning

Task: reproduce a four-position sequence. Compare ghosts with scrubbing only.
Measures: order and position errors. Continue if errors drop.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md)
- Research: [open questions](../research/open-questions.md) (question 9)
- Mockups: none
- Feature brief: none
- Implementation issue: none
