# PRD: Decision stamps and task tokens

**Status:** Parked  
**Source ideas:** IDEA-027  
**Layer:** Meaning (added)  
**Depends on:** identity (PRD-037), a team workflow (PRD-048), HoloGrammar fields (PRD-003)  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md).
Rationale: a stamp creates a commitment, which needs explicit human intent,
an owner, and a team workflow that does not exist yet; the concept warns
against treating any gesture as approval. Revisit when a team trial (PRD-048)
shows decisions made in holograms getting lost before they become tasks.

## User Outcome

Before: a decision reached in a recorded review ("we move the bracket 2 cm
left; Sam does it") lives only in the recording and someone's memory.
After: the decision is stamped on the bracket at that moment with its owner and
rationale, and a task token carries the scene context to whoever does the work.

## Problem

Decisions and handoffs lose the context they were made in.

## Primary User And Moment

A team at the end of a recorded review; the person who does the work later.

## Proposed Interaction

- A deliberate action (never a gesture alone) creates a stamp on a referent:
  decision, owner, rationale.
- A stamp can produce a task token that opens the hologram at that moment.
- Stamps show provenance "added" and who created them.

## Why Holograms

Fair comparison: meeting notes with a task list.

- **Anchored to the event:** on a referent at the moment of decision.
- **Read from the body:** referent from pointing; the decision is explicit.
- **Intent, not a view:** states a commitment.
- **Works on a flat phone:** a stamp icon; the task opens the portal there.
- **Lost as a video:** the decision fixed to the part and moment it is about.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Seal on the referent | Explicit create |
| Phone portal | Stamp icon; task opens the moment | Tap |
| Desktop | Same | Click |
| Still image or Quick Look | Icon in stills | None |

## In Scope

- [ ] Explicit stamp creation, owner, rationale, task link.

## Out Of Scope

- [ ] Integration with task trackers; implicit approvals.

## Success Signals

- [ ] **Handoff:** the assignee does the right change without asking for context.

## Risks And Open Questions

- [ ] What workflows should be allowed to create commitments?

## Comparison And Learning

If reopened: a review producing two changes. Compare stamps with meeting notes.
Measures: correct changes and follow-up questions.

## Links

- Concept: [communication protocols](../concepts/communication-protocols.md)
- Research: [open questions](../research/open-questions.md) (question 6)
- Mockups: none
- Feature brief: none
- Implementation issue: none
