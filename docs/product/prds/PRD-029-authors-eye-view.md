# PRD: Author's-eye view

**Status:** Draft  
**Source ideas:** IDEA-039  
**Layer:** View  
**Depends on:** IDEA-045 portal (approved); head pose in the event (already recorded)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a recipient cannot tell what the author was looking at while
explaining, so "as you can see" means nothing from where they stand.
After: the recipient can briefly see through the author's eyes, or see a soft
cone showing where the author looked, and understands what the author saw.

## Problem

Gaze carries reference and attention. A hologram records head pose (and gaze
if available), so the author's view can be reconstructed.

## Primary User And Moment

A recipient confused by "as you can see", on a phone or in a headset.

## Proposed Interaction

- Variant A, cone: a soft cone from the author's head toward where they looked.
- Variant B, borrowed view: a short-hold action that puts the camera at the
  author's eyes, smoothed, on flat screens only.
- Headsets get the cone only (a borrowed first-person view in a headset is a
  comfort risk).

## Why Holograms

Video from a head camera exists but loses the outside view. Here the viewer
switches between both. Fair comparison: no cone, no borrowed view.

- **Anchored to the event:** the author's head and gaze over time.
- **Read from the body:** head pose and gaze.
- **Intent, not a view:** the cone shows attention; the borrowed view is the viewer's choice.
- **Works on a flat phone:** both variants work through the portal.
- **Lost as a video:** switching between the author's view and any other.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Gaze cone only | Toggle |
| Phone portal | Cone, or borrowed view while held | Hold to borrow |
| Desktop | Same as phone | Hold a key |
| Still image or Quick Look | A still from the author's eyes; dropped in Quick Look | None |

## In Scope

- [ ] Gaze cone; borrowed view on flat screens; comparison of both.

## Out Of Scope

- [ ] Live attention cones (IDEA-013, parked).

## Success Signals

- [ ] **Technical:** borrowed view is smoothed enough that nobody reports discomfort in the trial.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Does a borrowed first-person view orient or disorient on each device?
- [ ] Head pose alone may be a poor proxy for gaze.

## Comparison And Learning

Task: identify what the author was looking at during "as you can see" moments.
Compare cone, borrowed view, and neither. Measures: correct answers and comfort.
Continue with whichever variant helps without discomfort.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md)
- Research: [open questions](../research/open-questions.md) (questions 9, 17)
- Mockups: none
- Feature brief: none
- Implementation issue: none
