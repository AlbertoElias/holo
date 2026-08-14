# Product Knowledge System

This directory is the durable home for product thinking that has not yet
become implementation work. It is intentionally separate from `TODOs.md`,
which tracks work the engineering team has already decided to do.

## Lifecycle

| State | Meaning | Location |
| --- | --- | --- |
| Seed | Interesting, unvalidated idea | `IDEAS.md` |
| Concept | Related seeds have a shared product hypothesis | `concepts/` |
| Research | A question that needs evidence before product commitment | `research/` |
| PRD | A bounded user outcome ready for prioritization | `prds/` |
| Experiment | A test of a product hypothesis | `experiments/` |
| Decision | A product choice with rationale | `decisions/` |

## Rules

- Give every idea a stable `IDEA-###` identifier before discussing it deeply.
- Keep seeds short and noncommittal. Contradictory ideas can coexist.
- Create a PRD only for one user outcome, not for an entire vision.
- Link a PRD to its source ideas, open research questions, and later experiments.
- Move committed engineering work to `TODOs.md`; do not use this directory as a
  delivery tracker.

## Starting Points

- [Vision](VISION.md): the product thesis and communication principles.
- [Idea registry](IDEAS.md): all currently captured seeds from the holographic
  communication exploration.
- [Concepts](concepts/README.md): grouped thinking that remains deliberately fluid.
- [PRD template](prds/PRD-TEMPLATE.md): format for ideas that are ready to deepen.
- [Research questions](research/open-questions.md): evidence needed before choosing a direction.
