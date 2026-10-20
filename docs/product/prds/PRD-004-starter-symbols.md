# PRD: Starter symbol set

**Status:** Draft  
**Source ideas:** IDEA-003  
**Layer:** Meaning (added)  
**Depends on:** IDEA-001 (meaning-layer record, PRD-003), IDEA-031 (Ink material)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author who wants to say "this is a risk" or "this one depends on
that" must say it aloud and hope the recipient connects the words to the right
thing.
After: the author places one of a few built-in 3D symbols on the thing they
mean, and a recipient on a phone recognizes the symbol and its referent without
the author having to repeat the explanation.

## Problem

Some relationships recur in explanations: risk, uncertainty, dependency,
direction of force, an open question. Speech carries them but does not fix them
to a referent, and the body has no native gesture for "this is uncertain".
Symbol Forge proposes team-created symbols; a custom vocabulary is premature
before we know whether any symbol is understood without teaching.

## Primary User And Moment

An author explaining a design or repair to a colleague, in VR, right after
recording or during it. The recipient watches later on a phone and needs to
know which part is risky or which parts depend on each other.

## Proposed Interaction

- Up to eight built-in symbols drawn from the spatial-language primitives:
  force arrow, constraint ring, risk cloud, dependency bridge, question beacon,
  and a few others chosen by the trial below.
- The author binds a symbol to a referent (a bone, an object, a place) for a
  span of time. Binding uses the "this/here" grammar from the design-language
  exploration; no free-floating placement.
- Recipients can tap or gaze at a symbol to see its name.

Symbol creation by teams (the full Forge) is excluded until built-ins earn it.

## Why Holograms

A symbol bound to a referent keeps pointing at it from every view; a video
overlay only works from the one camera. The fair comparison is the same
recording with the author saying the relationship aloud and no symbols.

- **Anchored to the event:** bound to a bone, object, or place for a time span.
- **Read from the body:** not read; this is added meaning, so it must justify
  itself against IDEA-032 and IDEA-028 first.
- **Intent, not a view:** the symbol says what matters; each device sizes it.
- **Works on a flat phone:** each symbol needs a legible flat silhouette.
- **Lost as a video:** the binding to a referent the viewer can orbit around.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Volumetric Ink symbol at true scale on the referent | Author binds with held Ink or Halo; viewer gazes to name |
| Phone portal | Flat-readable silhouette, scaled for legibility, still on the referent | Tap to name |
| Desktop | Same as phone | Hover to name |
| Still image or Quick Look | Flattened icon at the referent in a still; dropped in Quick Look | None |

## In Scope

- [ ] Up to eight built-in symbols with headset and phone renderings.
- [ ] Binding to a referent and time span, stored in the meaning-layer record.
- [ ] Provenance "added" on every symbol.

## Out Of Scope

- [ ] Team-authored or custom symbols (the full Symbol Forge).
- [ ] Symbols that open evidence, media, or simulations.
- [ ] Live, multi-person symbol creation.

## Success Signals

- [ ] **Technical:** a bound symbol survives export -> upload -> render and stays
  on its referent while the avatar moves.
- [ ] **Recognition:** recipients name at least six of eight symbols without a legend.

## Risks And Open Questions

- [ ] Which eight are universally useful? The registry question remains open.
- [ ] Symbols may duplicate what the body already says; check IDEA-032 first.
- [ ] Clutter when several symbols overlap on a small phone card.

## Comparison And Learning

Task: a short design review where two parts are risky and one depends on
another. At least five recipients each view the same recording, with symbols
or with speech only (counterbalanced across two equivalent recordings).
Measures: correct identification of risky parts and the dependency, and
clarification questions. Continue if symbols improve identification without
slowing playback; revise the set if some symbols are misread; park if speech
alone performs the same.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [spatial language](../concepts/spatial-language.md),
  [design language](../concepts/design-language.md)
- Research: [open questions](../research/open-questions.md) (question 8)
- Mockups: none
- Feature brief: none
- Implementation issue: none
