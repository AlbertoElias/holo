# Product Knowledge System

This directory is the durable home for product thinking that has not yet
become implementation work. It is intentionally separate from `TODOS.md`,
which tracks work the engineering team has already decided to do.

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

- Give every idea a stable `IDEA-###` identifier before discussing it deeply.
- Keep ideas short and noncommittal. Contradictory ideas can coexist.
- Create a PRD only for one user outcome, not for an entire vision.
- Link a PRD to its source ideas and open research questions.
- Record a decision by setting the PRD status to Approved or Parked and
  adding the rationale to that PRD; do not create a separate decision log.
- Move committed engineering work to `TODOS.md`; do not use this directory as a
  delivery tracker.

## Starting Points

- [Vision](VISION.md): the product thesis and communication principles.
- [Idea registry](IDEAS.md): all currently captured ideas from the holographic
  communication exploration.
- [Concepts](concepts/README.md): grouped thinking that remains deliberately fluid.
- [PRD template](prds/PRD-TEMPLATE.md): format for ideas that are ready to deepen.
- [Research questions](research/open-questions.md): evidence needed before choosing a direction.
