# PRD: Claim capsules

**Status:** Parked  
**Source ideas:** IDEA-005  
**Layer:** Meaning (added)  
**Depends on:** HoloGrammar intent and confidence fields (PRD-003), IDEA-032  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md),
which lists IDEA-005 under "parked for now". Rationale: a capsule is meaning
typed by the author (statement, evidence, confidence, status) before any
meaning is read from the body, and the registry's own question is whether it
makes discussion feel bureaucratic. Revisit when PRD-003 has grown intent and
confidence fields from real mark kinds, and a review workflow (PRD-048) shows
people repeatedly losing track of which claim was made about which part.

## User Outcome

Before: in a recorded design review, a claim such as "this joint fails above
40 kg" is said once; later nobody can find what was claimed, about which part,
or whether it was checked.
After: the claim sits on the joint as a small capsule holding the statement,
its evidence, confidence, and status (open, supported, refuted), and a later
viewer can see and update its status.

## Problem

Spoken claims lose their referent and their state. Text documents keep the
state but lose the referent and the speaker.

## Primary User And Moment

An engineer recording a review of a part; a colleague reviewing the claims a
week later.

## Proposed Interaction

- During review the author turns a spoken sentence into a capsule bound to the
  referent they pointed at (IDEA-032), picking a confidence.
- Capsules show as small Ink objects on referents; opening one shows the
  statement, evidence link, and status.
- A later viewer can change the status (needs identity, IDEA-052).

## Why Holograms

A claim bound to a part, at the moment it was made, by a visible speaker. Fair
comparison: a review document listing claims with part numbers.

- **Anchored to the event:** on a referent at a moment.
- **Read from the body:** referent from pointing; the claim itself is typed.
- **Intent, not a view:** states a claim; devices decide how to show it.
- **Works on a flat phone:** a small capsule icon that opens a panel.
- **Lost as a video:** the claim's link to the part and its changing status.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Capsule on the referent | Point to open |
| Phone portal | Capsule icon; tap opens the claim | Tap |
| Desktop | Same | Click |
| Still image or Quick Look | Icon in stills; dropped in Quick Look | None |

## In Scope

- [ ] Capsule creation from a spoken sentence and a pointed referent; status changes.

## Out Of Scope

- [ ] Argument graphs, voting, automatic claim detection.

## Success Signals

- [ ] **Communication:** reviewers find and correctly attribute claims faster than from a review document.

## Risks And Open Questions

- [ ] Does this help discussions or make them feel bureaucratic?
- [ ] Status changes need ownership and history.

## Comparison And Learning

If reopened: a two-week review of one design. Compare capsules with a claims
document. Measures: claims found, correctly attributed to parts, and reviewer
preference. Park again if reviewers prefer the document.

## Links

- Concept: [communication protocols](../concepts/communication-protocols.md),
  [spatial language](../concepts/spatial-language.md)
- Research: [open questions](../research/open-questions.md) (question 6)
- Related PRDs: [PRD-003 HoloGrammar v0](PRD-003-hologrammar-v0.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
