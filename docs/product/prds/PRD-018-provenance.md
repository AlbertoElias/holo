# PRD: Recorded, inferred, or added on every mark

**Status:** Draft  
**Source ideas:** IDEA-024  
**Layer:** All layers  
**Depends on:** the first mark kind (IDEA-032); applies to synthesized locomotion now  
**Owner:** Unassigned  
**Last updated:** 2026-10-22

## User Outcome

Before: a viewer cannot tell whether the avatar's walk was performed or
synthesized, or whether a highlight came from the author's finger or from the
system's guess.
After: any viewer can inspect a mark or a span of motion and see whether it was
recorded, inferred by the system, or added afterwards, and inferred things look
visibly different by default.

## Problem

The lens makes provenance "a field from the first mark kind, not a later
feature". Synthesized locomotion and filled tracking gaps already exist as
inferred motion. Trust in embodied messages depends on knowing what the author
actually did.

## Primary User And Moment

A recipient who doubts a detail ("did they really point at that?"), and an
author who wants to show their message is unedited.

## Proposed Interaction

- Every mark and every edited or synthesized motion span carries provenance:
  recorded, inferred (with confidence), or added.
- Default appearance: recorded is plain; inferred is lighter or dashed; added
  carries the author's hue (the design-language Ink rule).
- Inspection on any device shows the provenance and, for edits, what changed.
- An optional "unedited" badge when nothing was added or edited.

## Why Holograms

Video provenance is about the whole file. Holograms are made of separable data,
so provenance can be per mark and per motion span. Fair comparison: no
provenance shown, measuring trust and correct attribution.

- **Anchored to the event:** provenance belongs to marks and spans of the event.
- **Read from the body:** distinguishes what the body did from what was read from it.
- **Intent, not a view:** the field is data; each device chooses a visual style.
- **Works on a flat phone:** dashed or lighter styles read on a small card.
- **Lost as a video:** per-element attribution.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Inferred marks lighter; inspection on gaze or point | Inspect |
| Phone portal | Same styles; long-press to inspect | Long-press |
| Desktop | Same | Hover |
| Still image or Quick Look | Styles baked into stills; Quick Look shows the event only | None |

## In Scope

- [ ] A provenance field in the meaning-layer record (PRD-003) from the first mark kind.
- [ ] Marking synthesized locomotion and filled tracking gaps as inferred spans.
- [ ] Viewer styles and inspection on phone and desktop.

## Out Of Scope

- [ ] Cryptographic signing or watermarking (a later question).

## Success Signals

- [ ] **Technical:** every mark and inferred span exported carries provenance; viewers render all three styles.
- [ ] **Trust:** see the trial below.

## Risks And Open Questions

- [ ] Which provenance must be visible by default, and which only on inspection?
- [ ] Clutter if every inferred step of locomotion is styled.

## Comparison And Learning

Task: recipients answer "did the author do this, did the system infer it, or was
it added later?" for five elements. Compare with and without provenance styles.
Measures: correct attribution and stated trust. Continue if attribution
improves; revise styles if they distract.

## Decision

v0 subset, 2026-10-22: [PRD-022](PRD-022-self-resolving-pointing.md) (approved)
delivers the first slice of this PRD with pointing links; see its "First mark"
section for exactly which fields and styles. The rest of this PRD stays Draft.

Pending until explicitly decided. Drafting this document is not approval to
build. The lens already requires the field; this PRD scopes how it is shown.

## Links

- Concept: [embodied communication](../concepts/embodied-communication.md),
  [what a hologram is](../concepts/what-a-hologram-is.md) (principle 7)
- Research: [open questions](../research/open-questions.md) (questions 4, 18)
- Related PRDs: [PRD-003 HoloGrammar v0](PRD-003-hologrammar-v0.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
