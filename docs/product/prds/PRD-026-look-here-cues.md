# PRD: Look-here cues for missed moments

**Status:** Draft  
**Source ideas:** IDEA-036  
**Layer:** View  
**Depends on:** IDEA-045 portal (approved); referents from IDEA-032 or authored markers  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a viewer in Free mode, or in a headset, is looking elsewhere when the
key moment happens, and misses it entirely.
After: when something important happens outside their view, they hear it from
that direction (headset) or see a soft edge cue (phone); if they still miss it,
playback waits briefly until they look.

## Problem

Spatial freedom creates a new failure: missing what matters. Video never has
this problem because the camera forces attention.

## Primary User And Moment

A viewer exploring in Free at the moment the author points at something behind them.

## Proposed Interaction

- Key moments come from resolved pointing (IDEA-032) or emphasis (IDEA-028).
- Headset: spatial audio from the referent's direction.
- Phone and desktop in Free: a soft cue at the screen edge toward the referent.
- Optional wait: playback holds up to a few seconds until the referent is in view.

## Why Holograms

Only a medium with free viewing needs attention cues. Fair comparison: Free
viewing without cues.

- **Anchored to the event:** the cue points at a referent at a moment.
- **Read from the body:** key moments come from pointing.
- **Intent, not a view:** never moves the camera in Free.
- **Works on a flat phone:** an edge cue.
- **Lost as a video:** a video has no "outside the view" to cue.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Directional sound | Cues on or off |
| Phone portal | Edge glow in Free; in Follow the camera already goes there | Same |
| Desktop | Same as phone | Same |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Edge cues on phone and desktop; spatial audio in the headset viewer; optional wait.

## Out Of Scope

- [ ] Live sessions (IDEA-008 is the live twin).

## Success Signals

- [ ] **Technical:** cues fire only for referents outside the view.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Which cue redirects attention without feeling like a nag?

## Comparison And Learning

Task: viewers explore in Free while a key moment happens. Compare cues on and
off. Measures: whether they saw the moment, and annoyance ratings. Continue if
more see it without annoyance; revise intensity otherwise.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md)
- Research: [open questions](../research/open-questions.md) (questions 9, 17)
- Related PRDs: [PRD-006 Reference Lock](PRD-006-reference-lock.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
