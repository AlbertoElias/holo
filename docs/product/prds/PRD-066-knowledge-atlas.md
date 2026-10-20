# PRD: Knowledge atlas

**Status:** Approved  
**Source ideas:** IDEA-068  
**Layer:** All layers  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Approved by explicit user direction (the user asked for a mini app for
visualizing repository knowledge, recorded in the
[knowledge atlas concept](../concepts/knowledge-atlas.md)), and delivered: the
[feature brief](../../features/archive/knowledge-atlas.md) is Complete and the
atlas end-to-end tests run in CI. This PRD is written afterwards so the idea has
a PRD like every other; it records the outcome and does not reopen scope.

## User Outcome

Before: product thinking lived in dozens of Markdown files; to follow an idea
to its concept, PRD, and open bugs a reader had to open files by hand.
After: a reader opens one read-only app, finds an idea, and follows it to its
concepts, PRDs, and open bugs, while the Markdown stays the only source of truth.

## Problem

Ideas, concepts, PRDs, and bugs are linked by IDs and relative links that are
hard to traverse in a file tree, and a second database would drift.

## Primary User And Moment

The product owner and agents, when choosing what to deepen next.

## Proposed Interaction

As delivered: an approach page, a searchable and filterable idea garden, a
concept wiki, a PRD list with statuses, a Markdown reader, and an open-bug view
read from `BUGS.md`. No editing, accounts, or atlas-only state.

## Why Holograms

Supporting tool, not part of the medium. The hologram test does not apply; the
atlas helps apply it by showing each idea's layer and PRD.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Not targeted | None |
| Phone portal | Responsive phone layout | Touch |
| Desktop | Primary layout | Mouse and keyboard |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [x] Everything in the feature brief's acceptance criteria.

## Out Of Scope

- [x] Editing, approvals, deployment, a second content store.

## Success Signals

- [x] **Technical:** the brief's acceptance criteria and desktop and phone browser evidence.
- [ ] **Use:** readers follow ideas to PRDs in the atlas rather than in the file tree (not measured).

## Risks And Open Questions

- [ ] Can readers traverse the repository knowledge without creating another source of truth? So far yes, by design; keep watching as PRDs grow.

## Comparison And Learning

Tool outcome; the evidence is the brief's browser artifacts and CI. No
recipient trial applies.

## Links

- Concept: [knowledge atlas](../concepts/knowledge-atlas.md)
- Feature brief: [knowledge atlas (complete)](../../features/archive/knowledge-atlas.md)
- Mockups: none
- Implementation issue: none
