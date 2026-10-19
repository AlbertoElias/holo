# Knowledge Atlas

**Layers:** All layers (supporting knowledge access).

**Source idea:** IDEA-068.
**Provenance:** The user requested a mini app for visualizing repository
knowledge while keeping the knowledge base authoritative. Application delivery
belongs to the [feature workflow](../../FEATURE_WORKFLOW.md), not this note.

## Reading Experience

- A main page explains the vision and practical method for thinking about
  problems, brainstorming, selecting experiments, evaluating, and using agents.
- An idea list exposes stable IDs, themes, lifecycle state, next questions,
  and links to related detail, concepts, and PRDs.
- A separate wiki explains concepts and how the product thinks about them.
- PRDs retain their own status, scope, risks, and decisions; a draft looks like
  a draft, while PRD-001 now shows its Parked decision. IDEA-031 remains an exploration.
- Open bugs are read from [BUGS.md](../../../BUGS.md), not maintained in a
  second product list. Historical proposals and completed work must not look
  like open defects or current commitments.
- Coverage/provenance notes let readers distinguish user requests, assistant
  recommendations, historical plans, and questions needing research.

## Source Of Truth

The app only reads repository Markdown. Search indexes, navigation, and rendered
views are derived representations. Editing, approval, and delivery state remain
in their existing owning files; there is no atlas-only database or status.
Relative links should continue to lead to the source material, and unavailable
external artifacts should not be presented as locally archived content.
