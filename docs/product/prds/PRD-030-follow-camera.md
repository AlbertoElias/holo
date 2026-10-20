# PRD: Attention-following camera (Follow mode)

**Status:** Draft  
**Source ideas:** IDEA-041  
**Layer:** View  
**Depends on:** IDEA-045 portal (approved), IDEA-032 (resolved referents)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: the portal's Follow mode keeps one automatic framing of the author, so
when the author points at something off to the side, the phone viewer does not
see it unless they take over.
After: in Follow, the camera eases toward what the author points at, sizes, or
walks toward, and reframes for any screen shape, so a viewer who never touches
the screen still sees what matters.

## Problem

Most phone viewers will not explore; the portal must carry the author's intent
by default. The portal view PRD explicitly left intelligent Follow out until
pointing exists.

## Primary User And Moment

A passive phone viewer in the feed, watching in Follow.

## Proposed Interaction

- Inputs: resolved referents (IDEA-032), measurements (IDEA-034), viewpoint
  markers (IDEA-035), and the author's walking direction.
- The camera frames the author plus the current referent, easing with
  limits on speed and angle to avoid motion sickness.
- Any viewer gesture switches to Free; Return goes back to Follow.

## Why Holograms

A video's camera is fixed at recording; here framing is computed per screen
from the author's intent. Fair comparison: today's fixed Follow framing.

- **Anchored to the event:** frames referents and the author.
- **Read from the body:** driven by pointing and movement.
- **Intent, not a view:** the author never sets the camera; the device does.
- **Works on a flat phone:** this is the phone's version of Follow.
- **Lost as a video:** reframing for any aspect ratio and attention.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Not applicable (the viewer's head is the camera); IDEA-036 cues instead | None |
| Phone portal | Eased framing of author plus referent | Gesture to Free; Return |
| Desktop | Same, wider framing | Same |
| Still image or Quick Look | Stills framed by the same rule | None |

## In Scope

- [ ] Framing from referents and walking direction; easing limits; aspect-ratio reframing.

## Out Of Scope

- [ ] Cuts, shots, or authored camera paths.

## Success Signals

- [ ] **Technical:** every resolved referent is on screen in Follow on a phone viewport.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] How much automatic camera motion feels guided rather than seasick?

## Comparison And Learning

Task: passive viewing of a recording with off-center referents. Compare smart
Follow with today's fixed Follow. Measures: correct referents, comfort, and how
often viewers take over. Continue if correct answers rise without discomfort.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Recommended sequencing: after IDEA-032.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md),
  [what a hologram is](../concepts/what-a-hologram-is.md)
- Research: [open questions](../research/open-questions.md) (question 9)
- Related PRDs: [PRD-002 portal view](PRD-002-portal-view.md),
  [PRD-022 self-resolving pointing](PRD-022-self-resolving-pointing.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
