# PRD: "Stand here" viewpoint markers

**Status:** Draft  
**Source ideas:** IDEA-035  
**Layer:** Meaning (added)  
**Depends on:** IDEA-045 portal (approved), meaning-layer record (PRD-003)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: some explanations only make sense from one side ("you can see the gap
from here"), but a recipient watching from elsewhere misses it.
After: the author marks a spot by standing on it and saying "from here"; in
Follow the recipient's device goes to that viewpoint, and in Free they see a
marker they can walk or orbit to.

## Problem

The author knows the best viewpoint for a moment; the lens forbids them from
setting the camera. A viewpoint marker expresses the intent and leaves the
showing to each device.

## Primary User And Moment

An author showing something visible only from one angle; a phone recipient at that moment.

## Proposed Interaction

- The author stands where they want the viewer and triggers a marker (held
  gesture or a phrase); the marker stores position, look direction, and a time span.
- Follow: phone and desktop ease the camera there; headset plays a cue and shows
  footprints.
- Free: a small footprint marker shows in the scene.

## Why Holograms

Video has only one viewpoint, chosen at recording. Fair comparison: the author
saying "look from the left side" with no marker.

- **Anchored to the event:** a place and a moment.
- **Read from the body:** the author's own standing position defines it.
- **Intent, not a view:** "the best place to see this"; devices carry it out.
- **Works on a flat phone:** an eased camera move in Follow.
- **Lost as a video:** a viewpoint the viewer can choose to take.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Footprints and a gentle cue | Walk there |
| Phone portal | Follow eases there; Free shows footprints | Return to Follow |
| Desktop | Same as phone | Same |
| Still image or Quick Look | The still is rendered from the marked viewpoint | None |

## In Scope

- [ ] Placing a marker in capture; Follow and Free behavior on phone and desktop.

## Out Of Scope

- [ ] Camera paths, cuts, or shot lists.

## Success Signals

- [ ] **Technical:** markers round-trip and Follow eases without motion sickness complaints.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Do viewers follow suggested viewpoints in a headset, and is the 2D camera move welcome?
- [ ] How a suggested viewpoint looks: the [styleguide](../design/styleguide.md)
  draws another angle as a small golden portal in the scene, but at that size
  the burnt edge reads as a smooth line. Moved here from the UI redesign
  ([brief](../../features/ui-redesign.md), Q12) on 2026-10-24.

## Comparison And Learning

Task: an explanation with one detail visible from a single side. Compare marker
against spoken direction. Measures: whether recipients report the detail.
Continue if more do; park if spoken direction works as well.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md),
  [hologram authoring](../concepts/hologram-authoring.md)
- Research: [open questions](../research/open-questions.md) (question 9)
- Mockups: none
- Feature brief: none
- Implementation issue: none
