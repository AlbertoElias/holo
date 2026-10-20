# PRD: API platform, one integrator trial

**Status:** Draft  
**Source ideas:** IDEA-067  
**Layer:** All layers  
**Depends on:** a named external integrator; stable contracts in `packages/`  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an external app that wants spatial messages would have to build its
own capture, storage, and viewing.
After: we know whether one real external app can create and embed holographic
messages through our existing API and an embeddable viewer, and keeps doing so.

## Problem

IDEA-067 is a platform direction. The registry asks which external application
needs a reusable capability. Without a named integrator, an SDK is speculative.

## Primary User And Moment

A developer of one specific app (to be named) that would embed spatial messages.

## Proposed Interaction

- Use the existing upload API and contracts as-is.
- Offer an embeddable portal viewer (iframe) for one hologram.
- Observe what the integrator needs that the API lacks.

## Why Holograms

The integrator's users get the same medium; the embed must stay a portal, not a
video export. Fair comparison: the integrator embedding a video.

- **Anchored to the event / read from the body:** inherited.
- **Intent, not a view:** the embed keeps Follow and Free.
- **Works on a flat phone:** embed works on mobile web.
- **Lost as a video:** the integrator's users can move through the hologram.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Not in the first trial | None |
| Phone portal | Embedded portal | Portal |
| Desktop | Embedded portal | Mouse |
| Still image or Quick Look | Preview image in the host app | None |

## In Scope

- [ ] Iframe embed for one hologram; API documentation; one integrator.

## Out Of Scope

- [ ] SDKs, API keys, billing, a capture SDK.

## Success Signals

- [ ] **Adoption:** the integrator ships the embed to their users and keeps it.

## Risks And Open Questions

- [ ] Which external application needs a reusable communication capability?
- [ ] Backward compatibility of current endpoints becomes a commitment.

## Comparison And Learning

Park until an integrator is named. Then continue if they ship and keep it;
record what they had to work around. Record against research question 16.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build or to choose a market.

## Links

- Concept: [product directions](../concepts/product-directions.md)
- Research: [open questions](../research/open-questions.md) (question 16)
- Mockups: none
- Feature brief: none
- Implementation issue: none
