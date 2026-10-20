# PRD: Gesture-drawn marks

**Status:** Draft  
**Source ideas:** IDEA-004  
**Layer:** Meaning (added)  
**Depends on:** hand-tracking fidelity (in verification), IDEA-031 (held Ink mode)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: when an author traces "it moves along here" or circles "this whole
area" in the air, the gesture is gone the moment their hand moves on, and a
recipient who looked away misses it.
After: a deliberate drawn gesture becomes a clean arrow, path, or boundary
bound to what it was drawn around, and the recipient sees it from any angle.

## Problem

Authors already draw in the air while explaining. A hand path (IDEA-033)
preserves the raw motion; this idea goes further and turns an intentional
stroke into an editable primitive. The risk is the reverse: ordinary gesturing
becoming marks nobody meant.

## Primary User And Moment

An author in VR explaining a route, a boundary, or a direction of motion, who
wants the drawing to remain. The recipient watches later through a phone portal.

## Proposed Interaction

- Strokes become marks only while a held Ink mode is active (the design-language
  rule "modes are held, never toggled"), so free gesturing never draws.
- On release, the stroke is recognized as one of three shapes: arrow, open path,
  or closed boundary. Unrecognized strokes stay as freehand Ink.
- The mark binds to the object or place nearest the stroke and appears for the
  rest of the take (or until the author dismisses it).

## Why Holograms

A mark drawn in 3D around a real place reads correctly from any side; a video
overlay drawn from one camera misplaces it as soon as the view changes. The
fair comparison is the same recording with raw hand-path ribbons (IDEA-033)
only.

- **Anchored to the event:** bound to the nearest object or place and to a moment.
- **Read from the body:** the stroke is the body; recognition only tidies it.
- **Intent, not a view:** the mark says "this route", not where to look from.
- **Works on a flat phone:** arrows and outlines read well through the portal.
- **Lost as a video:** a 3D path around an object, inspectable from the side.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Ink stroke at true scale, cleaned shape on release | Hold non-dominant pinch or trigger, draw with dominant hand |
| Phone portal | Same mark, thickened for legibility | Viewer can hide marks in Free |
| Desktop | Same | Same |
| Still image or Quick Look | Flattened in a still; dropped in Quick Look | None |

## In Scope

- [ ] Held Ink mode in capture on hands and controllers.
- [ ] Recognition of arrow, open path, and closed boundary; freehand fallback.
- [ ] Binding to the nearest referent; storage with provenance "added".

## Out Of Scope

- [ ] Recognizing ordinary gestures without a held mode (that is IDEA-033/034).
- [ ] Diagrams, symbols, or text recognition.
- [ ] Editing marks after the take.

## Success Signals

- [ ] **Technical:** recognition picks the intended shape in at least 9 of 10
  deliberate strokes on a physical headset; zero marks appear outside Ink mode.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Can the held-mode grammar be learned without breaking speech?
- [ ] Emulation cannot judge stroke feel; physical-headset validation is required.
- [ ] Does a cleaned shape lose nuance a raw ribbon kept?

## Comparison And Learning

Task: describe a route through a recorded scene and a region to avoid. At least
five recipients reproduce the route and region on a top-down sketch after
viewing either the raw-ribbon version or the gesture-mark version. Measures:
route accuracy and region accuracy. Continue if marks improve accuracy; park in
favor of IDEA-033 if raw ribbons do as well.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Recommended sequencing: after IDEA-033 shows whether raw paths suffice.

## Links

- Concept: [spatial language](../concepts/spatial-language.md),
  [design language](../concepts/design-language.md) (Ink becomes shapes)
- Research: [open questions](../research/open-questions.md) (question 8)
- Related PRDs: [PRD-023 hand-path ribbons](PRD-023-hand-path-ribbons.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
