# PRD: Conversational memory palace

**Status:** Parked  
**Source ideas:** IDEA-029  
**Layer:** Conversation  
**Depends on:** many linked holograms: replies (PRD-012), decisions (PRD-060), claims (PRD-052)  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md).
Rationale: a graph of claims, artifacts, and decisions needs those things to
exist in quantity first, and legibility at scale is the open risk. Revisit
when a team has accumulated enough linked holograms that finding the decision
path is a real problem.

## User Outcome

Before: to understand why a design ended up as it is, a newcomer has to watch
months of recordings or ask around.
After: they walk a navigable map of the conversation (claims, decisions,
objects) and open the moment each decision was made.

## Problem

Long-running spatial discussions leave no navigable record of their reasoning.

## Primary User And Moment

A newcomer joining a project with a history of recorded reviews.

## Proposed Interaction

- Nodes are holograms, claims, and decisions; links are replies and references.
- Navigated as a space (rooms by topic) or as a plain graph on flat screens.
- Each node opens the hologram at its moment.

## Why Holograms

Fair comparison: a decision log document with links to videos.

- **Anchored to the event:** every node points into an event.
- **Read from the body:** links come from referents.
- **Intent, not a view:** structure, not cameras.
- **Works on a flat phone:** a plain graph or list view.
- **Lost as a video:** links between moments, places, and decisions.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Rooms of linked holograms | Walk |
| Phone portal | Graph or list | Tap |
| Desktop | Graph | Click |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Graph of one project's holograms, claims, and decisions.

## Out Of Scope

- [ ] Automatic summarization.

## Success Signals

- [ ] **Understanding:** newcomers explain the decision path correctly.

## Risks And Open Questions

- [ ] How can a graph remain legible at scale?

## Comparison And Learning

If reopened: compare the palace with a decision log for onboarding.
Measures: correct explanation of three past decisions, and time.

## Links

- Concept: [async holograms](../concepts/async-holograms.md)
- Research: [open questions](../research/open-questions.md) (question 6)
- Mockups: none
- Feature brief: none
- Implementation issue: none
