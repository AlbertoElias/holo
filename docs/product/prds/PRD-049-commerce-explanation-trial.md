# PRD: Commerce, one product explanation trial

**Status:** Draft  
**Source ideas:** IDEA-066  
**Layer:** All layers  
**Depends on:** IDEA-059 (recorded object motion), Quick Look path (exists)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a shopper sees a product's 3D model or video and still cannot tell
whether it fits their space or how it is used.
After: we know whether a person demonstrating the product at true scale, viewed
in AR in the shopper's room, changes their confidence or decision compared with
the bare 3D model.

## Problem

IDEA-066 asks what product decision benefits from holographic context rather
than a model alone. A bare 3D model already exists in many stores; the
hologram's addition is the person using it at true scale.

## Primary User And Moment

A shopper deciding on a product whose size or use is uncertain (a bag, a stool,
a tool), on an iPhone.

## Proposed Interaction

- A maker records themselves using the product model (PRD-043 capability).
- The shopper opens it in AR (Quick Look or WebXR) in their room at true scale.

## Why Holograms

Fair comparison: the same product as a bare 3D model in AR, and as a video.

- **Anchored to the event:** the product in a person's hands at true scale.
- **Read from the body:** use is demonstrated, not described.
- **Intent, not a view:** the shopper places it in their own space.
- **Works on a flat phone:** portal and AR on iPhone.
- **Lost as a video:** true scale in the shopper's room beside a person.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Not the target | None |
| Phone portal | Portal before AR | Portal |
| Desktop | Portal | Mouse |
| Still image or Quick Look | Primary AR path on iPhone | Place in room |

## In Scope

- [ ] Two products, one recorded demonstration each, a shopper study.

## Out Of Scope

- [ ] Merchant tools, checkout, catalog integration.

## Success Signals

- [ ] **Decision:** shoppers' size and fit judgments are more accurate, or
  confidence higher, than with the bare model.

## Risks And Open Questions

- [ ] Can merchants make useful content without a headset?
- [ ] Quick Look is a flattened preview; check whether demonstration motion survives.

## Comparison And Learning

Ten or more shoppers judge fit for their space; compare hologram, bare model,
and video. Continue if accuracy improves over the bare model; park if the model
alone does as well. Record against research question 16.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build or to choose a market.

## Links

- Concept: [product directions](../concepts/product-directions.md)
- Research: [open questions](../research/open-questions.md) (question 16)
- Mockups: none
- Feature brief: none
- Implementation issue: none
