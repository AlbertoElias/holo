# PRD: Visible processing lifecycle

**Status:** Draft  
**Source ideas:** IDEA-047  
**Layer:** All layers  
**Depends on:** async USDZ job (delivered in live deployment)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author who uploads a hologram cannot tell whether it is ready to
send, still converting, or broken; a recipient may open a link that fails.
After: the author sees one clear status (uploaded, processing, ready, failed)
with a plain reason and a next step on failure, and only sends when it is ready.

## Problem

The API already tracks `usdzStatus` (none, pending, processing, ready, failed)
with persisted errors for the Quick Look artifact. There is no status for the
hologram as a whole, and the author does not see any of it. "Ready" is not yet
defined across GLB, preview image, and Quick Look.

## Primary User And Moment

An author right after upload, deciding whether to send the link.

## Proposed Interaction

- Define "ready" as: the GLB plays in the portal. Quick Look and previews are
  optional extras with their own status, never blocking ready.
- The upload panel and the author's view show the status; failures show a plain
  reason and a retry where retrying could help.

## Why Holograms

Pipeline work. How it serves the test: ready must mean the hologram (event plus
meaning) is playable in the portal; the flattened Quick Look preview is never
the measure of ready, per the lens. Fair comparison: today's silent states.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Status after Publish (with IDEA-046) | Retry |
| Phone portal | Recipients never see a not-ready hologram in the feed | None |
| Desktop | Status in the upload panel | Retry |
| Still image or Quick Look | Quick Look button only when its artifact is ready | None |

## In Scope

- [ ] A definition of ready; author-visible states and failure reasons; retry.

## Out Of Scope

- [ ] New job types (thumbnails are IDEA-049); dashboards (IDEA-056).

## Success Signals

- [ ] **Technical:** every failure path in the existing USDZ job surfaces a reason to the author.
- [ ] **Author:** no author sends a link that fails to play in the trial.

## Risks And Open Questions

- [ ] What does ready promise across GLB, preview, and AR artifacts?

## Comparison And Learning

This is a reliability outcome; evidence is a fault matrix (each failure injected,
the status and reason observed) plus a handful of real uploads. Park if real
uploads almost never fail.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Research: [open questions](../research/open-questions.md) (question 15)
- Feature brief (related): [live deployment](../../features/live-deployment.md)
- Mockups: none
- Implementation issue: none
