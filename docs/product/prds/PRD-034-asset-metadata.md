# PRD: Useful processing metadata

**Status:** Draft  
**Source ideas:** IDEA-048  
**Layer:** All layers  
**Depends on:** none  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a recipient choosing which hologram to open, or whether to open it on
mobile data, has no idea how long it is or whether it has sound.
After: each hologram shows its length and whether it has audio, so the
recipient can choose to watch now or later, with sound on or off.

## Problem

The schema has a nullable `durationSec` column, but nothing in the API
populates it today. Audio presence and polygon count are not extracted.

## Primary User And Moment

A recipient on a phone deciding whether to open a message right now.

## Proposed Interaction

- On upload, read duration from the animation clip and audio presence from the
  GLB; store them.
- Show duration and a sound icon on feed cards and the detail page.
- Polygon count stays internal (useful for performance decisions, not people).

## Why Holograms

Pipeline work. How it serves the test: duration and audio describe the event;
nothing here changes the hologram. Fair comparison: no metadata shown.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Duration and sound icon in lists | None |
| Phone portal | Same on cards | None |
| Desktop | Same | None |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Extract duration and audio presence on upload; show both; internal polygon count.

## Out Of Scope

- [ ] File size warnings, quality scores.

## Success Signals

- [ ] **Technical:** extracted duration matches the clip within 0.1 s on real exports.
- [ ] **Recipient:** see below.

## Risks And Open Questions

- [ ] Which metadata helps creators or recipients make a decision?

## Comparison And Learning

Small and cheap; ask five recipients whether duration and sound changed when
they opened messages. Keep if any did; it costs little either way.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Research: [open questions](../research/open-questions.md) (question 15)
- Mockups: none
- Feature brief: none
- Implementation issue: none
