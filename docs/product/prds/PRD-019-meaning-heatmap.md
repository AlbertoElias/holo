# PRD: Where viewers looked and paused, for the author

**Status:** Draft  
**Source ideas:** IDEA-025  
**Layer:** View  
**Depends on:** IDEA-045 (portal view, approved), IDEA-058 (message URL)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author has no idea which parts of their hologram recipients
struggled with, only a view count at best.
After: the author sees, aggregated across recipients, where viewers paused,
replayed, and moved the portal camera to look, and uses it to spot the moment
that confused people.

## Problem

Authors improve messages when they know where understanding broke. Holograms
give viewers spatial freedom, so the signal of confusion is spatial too (people
orbiting to look behind something). The [viewer concept](../concepts/viewer-experience.md)
warns that these are inferences, not comprehension scores.

## Primary User And Moment

An author who sent a hologram to several colleagues and wants to improve it.

## Proposed Interaction

- The viewer records anonymous, aggregate-only events: pause time, replay
  spans, and coarse Free-camera focus points.
- The author sees a timeline heat strip and a coarse 3D heat cloud in the scene.
- No per-viewer trace is ever shown; small audiences are suppressed.

## Why Holograms

Video analytics can show pauses and drop-off, but not where in space people
looked. Fair comparison: video-style timeline analytics only.

- **Anchored to the event:** heat is placed on moments and places of the event.
- **Read from the body:** not applicable; this reads viewers, so privacy rules apply.
- **Intent, not a view:** shows attention, does not change viewing.
- **Works on a flat phone:** collected from portal use on phones.
- **Lost as a video:** spatial attention data.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Author can view the heat cloud in the scene | Toggle |
| Phone portal | Collection only; never shown to recipients | Opt-out |
| Desktop | Author's heat strip and cloud | Toggle |
| Still image or Quick Look | Not collected | None |

## In Scope

- [ ] Aggregate-only event collection with a minimum audience threshold.
- [ ] Author heat strip and heat cloud.

## Out Of Scope

- [ ] Per-viewer analytics, comprehension scores, engagement ranking.

## Success Signals

- [ ] **Technical:** no stored event can be linked to a viewer; suppression below threshold works.
- [ ] **Author value:** see the trial below.

## Risks And Open Questions

- [ ] What can be measured without compromising viewer privacy?
- [ ] Pauses may mean interest, not confusion.

## Comparison And Learning

Task: authors predict the confusing moment of their own hologram, then see the
heatmap and revise. Compare recipients' errors on the original and revised
versions. Continue if heatmaps lead to revisions that reduce errors; park if
authors find nothing actionable.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [async holograms](../concepts/async-holograms.md),
  [viewer experience](../concepts/viewer-experience.md)
- Research: [open questions](../research/open-questions.md) (question 10)
- Mockups: none
- Feature brief: none
- Implementation issue: none
