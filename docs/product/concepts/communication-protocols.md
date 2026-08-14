# Communication Protocols

## Hypothesis

Holograms become a communication medium when they help people establish shared
understanding, repair misunderstandings, record decisions, and carry work
forward. Visual richness alone is insufficient.

## Seeds in Scope

- IDEA-001 HoloGrammar
- IDEA-005 Claim Capsules
- IDEA-006 Understanding Mirror
- IDEA-007 Grounding signals
- IDEA-008 Reference Lock
- IDEA-027 Decision stamps and task tokens
- IDEA-030 Audience simulation

## HoloGrammar

```txt
Utterance = Intent + Referent + SpatialAction + TimeScope + Confidence + ResponseContract
```

An utterance might be: "This wrist rotation is a risk at 00:12; inspect it and
approve or request a change." The risk is attached to the wrist and appears
only for the relevant interval.

## Core Protocols

- Grounding loop: present, acknowledge, paraphrase if needed, then lock shared understanding.
- Reference lock: identify the person, object, region, or moment currently under discussion.
- Divergence: fork alternatives, compare them in the same scene, then merge or preserve the disagreement.
- Decision: create a durable decision stamp containing rationale, alternatives, and owner.
- Repair: create a question beacon, clarify in context, and resolve the thread.
- Handoff: convert a decision into task tokens that retain the scene context.

## Open Questions

- Which protocol should be explicit to users, and which should be inferred from interaction?
- How do structured claims feel helpful rather than bureaucratic?
- Can an Understanding Mirror objectively reveal misunderstanding well enough to earn trust?
