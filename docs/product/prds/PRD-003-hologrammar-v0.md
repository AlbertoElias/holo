# PRD: HoloGrammar v0, the smallest meaning-layer record

**Status:** Draft  
**Source ideas:** IDEA-001  
**Layer:** Meaning (added)  
**Depends on:** IDEA-032 (first producer of marks), IDEA-024 (provenance field)  
**Owner:** Unassigned  
**Last updated:** 2026-10-22

## User Outcome

Before: anything that says what matters in a hologram (a pointing link, a
note, a viewpoint) would be invented separately by each feature, so a mark made
in capture might not survive upload, or might show in the feed but vanish in AR.
After: a viewer on any device sees the same mark tied to the same referent and
moment, and can tell whether it was recorded, inferred, or added, because every
mark travels in one small shared record inside the hologram.

## Problem

The meaning layer does not exist yet. The first marks (self-resolving pointing,
ribbons, measurements) are about to be designed one by one. Without a shared
minimum, each will choose its own anchor, timing, and storage, and the
export -> upload -> render path will need a new contract for every mark kind.
The full HoloGrammar (intent, referent, action, time scope, confidence,
response contract, provenance) is too large to adopt before any mark exists.

## Primary User And Moment

The first user is indirect: a recipient on a phone watching a hologram whose
author pointed at something. The direct consumers are the capture exporter,
the viewer, and the agents building the next mark kinds. The moment is the
first time a second mark kind is added and must coexist with the first.

## Proposed Interaction

No new screen. Define the fields only as each is needed by a real mark:

- **Referent:** a bone, an object node, a world point, or a region, always in
  the event; never a screen position.
- **Time scope:** start and end in recording time.
- **Kind:** the mark type (pointing link first).
- **Provenance:** recorded, inferred, or added, plus confidence for inferred.

Intent, response contract, and confidence beyond inference stay out until a
PRD needs them. The record rides in the GLB as an optional extension, so other
glTF viewers still render the event.

## Why Holograms

A video caption has no referent; it is pixels at a screen position. A mark that
names a bone and a time range can be shown at every viewpoint and on every
device because the device renders it at playback. The fair comparison is not
with video but with the cost of per-feature formats: does one record let a
second mark kind ship without changing the export contract?

- **Anchored to the event:** every field points at a bone, node, place, or time.
- **Read from the body:** the first producer is IDEA-032; added marks come later.
- **Intent, not a view:** the record holds no camera or screen data.
- **Works on a flat phone:** the portal renders the referent highlight.
- **Lost as a video:** a fixed frame cannot hold a referent a viewer can query.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Each mark kind defines its own look; the record only locates it | Follow shows marks; Free can hide them |
| Phone portal | Same marks through the portal camera | Same toggle |
| Desktop | Same | Same |
| Still image or Quick Look | Dropped; Quick Look stays a flattened preview | None |

## In Scope

- [ ] A versioned glTF extension holding referent, time scope, kind, and provenance.
- [ ] Round trip through the real export -> upload -> render pipeline with one mark kind.
- [ ] A GLB without the extension renders unchanged; a third-party viewer ignores it.

## Out Of Scope

- [ ] Intent, response contracts, threading, and claim structures (IDEA-005, parked).
- [ ] A universal grammar or ontology of meaning.
- [ ] Authoring UI.

## Success Signals

- [ ] **Technical:** pointing links (IDEA-032) and one second kind (for
  example ribbons, IDEA-033) share the record with no exporter contract change
  for the second.
- [ ] **Technical:** every rendered mark can report its provenance on inspection.

## Risks And Open Questions

- [ ] Choosing fields before marks exist risks a speculative schema; add fields
  only with the PRD that needs them.
- [ ] Bone names differ between avatars; referents need a stable mapping.
- [ ] Should inferred marks be stored, or recomputed at view time from the event?

## Comparison And Learning

This is infrastructure for the meaning layer, so there is no recipient trial of
its own. Its evidence is technical: the second and third mark kinds ship faster
and render identically across devices. Revisit if every mark kind still needs
its own special-case fields; park if IDEA-032 is parked.

## Decision

v0 subset, 2026-10-22: [PRD-022](PRD-022-self-resolving-pointing.md) (approved)
delivers the first slice of this PRD with pointing links; see its "First mark"
section for exactly which fields and styles. The rest of this PRD stays Draft.

Pending until explicitly decided. Drafting this document is not approval to
build. Recommended sequencing: approve together with IDEA-032, not before it.

## Links

- Concept: [communication protocols](../concepts/communication-protocols.md),
  [what a hologram is](../concepts/what-a-hologram-is.md)
- Research: [open questions](../research/open-questions.md) (questions 6, 7)
- Related PRDs: [PRD-022 self-resolving pointing](PRD-022-self-resolving-pointing.md),
  [PRD-018 provenance](PRD-018-provenance.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
