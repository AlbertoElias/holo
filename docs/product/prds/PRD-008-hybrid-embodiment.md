# PRD: Real face on an expressive avatar body

**Status:** Draft  
**Source ideas:** IDEA-012  
**Layer:** Event  
**Depends on:** face and eye data from the headset (not yet verified in capture)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a recipient sees an avatar body that moves like the author but cannot
read the author's expression, so warmth, doubt, or emphasis in the face is lost.
After: the recipient sees the author's real facial expression on an avatar body,
and judges the message as more clearly "from them" without finding it uncanny.

## Problem

Personal and persuasive messages depend on the face. Full volumetric capture is
expensive and raises privacy and authenticity questions; a stylized avatar
loses expression entirely. The hybrid is a middle path whose acceptability is
unknown.

## Primary User And Moment

A person recording a personal message or a delicate explanation in a headset
for someone who knows them, watched on a phone.

## Proposed Interaction

- Capture records face expression from headset face and eye tracking where
  available, as part of the event (the exporter already writes morph-target
  tracks; whether these carry real face tracking needs inspection).
- Two candidate renderings are compared: expression driving the avatar's own
  face, and a captured face texture on the avatar head.
- Provenance marks whether the face is recorded or synthesized.

## Why Holograms

A video carries the face but fixes the camera and loses scale and space; an
avatar carries space but loses the face. The fair comparison is a video of the
same person giving the same message.

- **Anchored to the event:** the face is part of the recorded body.
- **Read from the body:** expression comes from the performance, not authoring.
- **Intent, not a view:** fidelity is chosen for meaning, not spectacle.
- **Works on a flat phone:** the portal must render the face legibly at card size.
- **Lost as a video:** body in space plus expression, viewable from any side.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Life-size avatar with expressive face | None new |
| Phone portal | Face legible when zoomed in; Follow frames the face during speech | Pinch to approach |
| Desktop | Same as phone | Wheel to approach |
| Still image or Quick Look | Still frame with expression; Quick Look may lose morphs | None |

## In Scope

- [ ] Inspect what face data the Quest delivers to WebXR today.
- [ ] Record and export face expression with the body.
- [ ] Two rendering variants for comparison.

## Out Of Scope

- [ ] Volumetric capture of real people (IDEA-063).
- [ ] Inferred emotion or expression enhancement.

## Success Signals

- [ ] **Technical:** face tracks survive export -> upload -> render at the
  recorded frame rate.
- [ ] **Presence:** see the trial below; uncanny ratings must not rise.

## Risks And Open Questions

- [ ] Face tracking may be unavailable in browser WebXR on current devices.
- [ ] Uncanny valley, privacy, and consent for face data.

## Comparison And Learning

Task: a short personal message from a person the recipient knows. At least five
recipients view avatar without face, hybrid, and video (counterbalanced).
Measures: felt connection, perceived authenticity, uncanny rating, and which
they would choose to receive again. Felt presence answers do not replace
comprehension measures. Continue if hybrid raises connection without raising
uncanny; park if face data is unavailable or uncanny rises.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [embodied communication](../concepts/embodied-communication.md)
- Research: [open questions](../research/open-questions.md) (questions 3, 18)
- Related PRDs: [PRD-046 lifelike presence](PRD-046-lifelike-presence.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
