# Product Knowledge System

This directory is the durable home for product thinking that has not yet
become implementation work. It is intentionally separate from `TODOS.md`,
which tracks work the engineering team has already decided to do.

Every idea, concept, and PRD here is read through one lens:
[what a hologram is](concepts/what-a-hologram-is.md). Each names the layer it
belongs to (event, meaning, or view) and answers that page's test.

## Lifecycle

Three states only. Supporting notes (`concepts/`, `research/`) develop an idea
but are not states, and no other stage directory is created until a real
artifact needs it.

| State | Meaning | Location |
| --- | --- | --- |
| Idea | Interesting, unvalidated; seeds and concepts coexist | `IDEAS.md` |
| PRD | One bounded user outcome, ready for prioritization | `prds/` |
| Decision | A PRD approved or parked, with rationale recorded in it | `prds/` (PRD status) |

## Rules

- Give every idea a stable `IDEA-###` identifier and a layer before discussing
  it deeply.
- Keep ideas short and noncommittal. Contradictory ideas can coexist.
- Create a PRD only for one user outcome, not for an entire vision.
- Link a PRD to its source ideas and open research questions.
- When mockups or prototypes are made for an idea, link them in the same
  change: from the PRD's Links section if a PRD exists, otherwise from the
  idea's Details cell in `IDEAS.md`. Give the date and a one-line summary of
  what they show.
- Record a decision by setting the PRD status to Approved or Parked and
  adding the rationale to that PRD; do not create a separate decision log.
- Move committed engineering work to `TODOS.md`; do not use this directory as a
  delivery tracker.

## Starting Points

- [Approach](APPROACH.md): framing problems, brainstorming, selecting experiments, and building with agents.
- [What a hologram is](concepts/what-a-hologram-is.md): the definition, layers,
  principles, and test.
- [Vision](VISION.md): the product thesis and communication principles.
- [Idea registry](IDEAS.md): all currently captured ideas, by layer.
- [Concepts](concepts/README.md): grouped thinking that remains deliberately fluid.
- [PRD template](prds/PRD-TEMPLATE.md): format for ideas that are ready to deepen.
- [Research questions](research/open-questions.md): evidence needed before choosing a direction.

- [Conversation coverage](research/conversation-coverage.md): archived recommendations and current decisions.
- [Historical productization proposal](research/historical-productization-plan.md): the superseded 90-day proposal.

## Authority And Reading Views

Markdown in this directory remains the product knowledge source of truth. A
knowledge browser may index and render it, with links to concepts and PRDs, but
must not become a second editable database. Open defects remain in
[`../../BUGS.md`](../../BUGS.md); the browser reads that file rather than copying
its contents into this directory.

Follow [`../FEATURE_WORKFLOW.md`](../FEATURE_WORKFLOW.md) when approved thinking
becomes delivery: `TODOS.md` owns the committed queue, an in-flight feature's
brief owns delivery state, and `HANDOFF.md` is a pointer. The three-state product
lifecycle above does not add Experiment, Research, or Concept as extra states.
Those are activities or supporting documents. A draft PRD is not approval to build.

## Visual Reading Guide

Start with the [Atlas reading guide](ATLAS_GUIDE.md) for the Event / Meaning /
View map, one conceptual wireframe, idea territories and the learning loop.
Its Mermaid diagrams and concise tables are readable here and rendered by the
read-only app; the canonical documents linked above still own the decisions.
