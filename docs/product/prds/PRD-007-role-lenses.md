# PRD: Role lenses over one meaning layer

**Status:** Draft  
**Source ideas:** IDEA-010  
**Layer:** View  
**Depends on:** a meaning layer with several mark kinds (IDEA-001, IDEA-032 onward)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a hologram that holds many marks (references, measurements, risks,
viewpoints) shows all of them to everyone, so a reviewer looking for risks has
to wade through assembly hints meant for an operator.
After: a recipient picks a lens for their role and sees only the marks relevant
to it, while the event itself and the marks everyone shares stay identical, so
two people with different lenses can still talk about the same moment.

## Problem

This problem only appears once a hologram carries many marks. Today it carries
none. The lens idea also risks the opposite failure: two roles seeing different
things and losing common ground.

## Primary User And Moment

A design review where an operator and a reviewer watch the same recorded
walkthrough on their own phones and then meet to decide on a change.

## Proposed Interaction

- Marks carry a short audience tag set by the author (or inferred from kind).
- The viewer picks a lens from a small list; marks outside it fade, never vanish
  entirely, so their existence stays visible.
- The event layer, pointing links, and decisions are never filtered.

## Why Holograms

A video has one edit for everyone; role-specific versions mean separate videos
that drift apart. One event with filtered meaning keeps one source. The fair
comparison is two separate videos (or one video with chapters per role).

- **Anchored to the event:** filters marks that are themselves anchored.
- **Read from the body:** lenses never filter what the body said.
- **Intent, not a view:** a lens chooses meaning, not a camera.
- **Works on a flat phone:** a lens picker in the viewer's Light chrome.
- **Lost as a video:** one source with per-viewer meaning cannot be a single video.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Out-of-lens marks faded to outlines | Lens picker in the Halo menu |
| Phone portal | Same fading | Lens picker in the card's controls |
| Desktop | Same | Same |
| Still image or Quick Look | A still rendered per lens; dropped in Quick Look | None |

## In Scope

- [ ] An audience tag on marks and a viewer-side lens picker.
- [ ] Faded, never hidden, out-of-lens marks.

## Out Of Scope

- [ ] Access control or private marks (that is identity, IDEA-052).
- [ ] Live role-based sessions.

## Success Signals

- [ ] **Technical:** switching lens changes only mark visibility and never the event.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Premature: no hologram has enough marks yet to need filtering.
- [ ] Common ground may suffer if roles cannot see what others see.

## Comparison And Learning

Task: two roles must agree on one change after watching the same walkthrough.
Compare lenses against all marks visible. Measures: time to find role-relevant
marks, and whether pairs agree on the referent in their discussion. Continue if
lenses speed finding without causing disagreement about what was shown; park
if clutter is not a real problem in recordings with many marks.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Readiness: low; revisit when a real hologram carries at least three
mark kinds.

## Links

- Concept: [live VR and AR dialogue](../concepts/live-vr-ar-dialogue.md)
- Research: [open questions](../research/open-questions.md) (question 17)
- Mockups: none
- Feature brief: none
- Implementation issue: none
