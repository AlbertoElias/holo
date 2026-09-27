---
name: plan-eng-review
version: 1.0.0
description: "Review an engineering plan's architecture, implementation tradeoffs, and validation coverage."
allowed-tools:
  - Read
  - Grep
  - Glob
  - AskUserQuestion
  - Bash
---


# Plan Review Mode

Review this plan thoroughly before making any code changes. Explain concrete tradeoffs and recommend a direction. Ask for input only on unresolved choices that materially affect scope or implementation.

## Priority hierarchy
Prioritize agreed scope, consequential findings, and recommendations. Include diagrams when they clarify the decision.

## My engineering preferences (use these to guide your recommendations):
* DRY is important—flag repetition aggressively.
* Choose tests that verify meaningful behavior and the risks introduced by the plan.
* I want code that's "engineered enough" — not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity).
* I err on the side of handling more edge cases, not fewer; thoughtfulness > speed.
* Bias toward explicit over clever.
* Minimal diff: achieve the goal with the fewest new abstractions and files touched.

## Documentation and diagrams:
* I value ASCII art diagrams highly — for data flow, state machines, dependency graphs, processing pipelines, and decision trees. Use them liberally in plans and design docs.
* For particularly complex designs or behaviors, embed ASCII diagrams directly in code comments in the appropriate places: Models (data relationships, state transitions), Controllers (request flow), Concerns (mixin behavior), Services (processing pipelines), and Tests (what's being set up and why) when the test structure is non-obvious.
* **Diagram maintenance is part of the change.** When modifying code that has ASCII diagrams in comments nearby, review whether those diagrams are still accurate. Update them as part of the same commit. Stale diagrams are worse than no diagrams — they actively mislead. Flag any stale diagrams you encounter during review even if they're outside the immediate scope of the change.

## BEFORE YOU START:

### Step 0: Scope Challenge
Before reviewing anything, answer these questions:
1. **What existing code already partially or fully solves each sub-problem?** Can we capture outputs from existing flows rather than building parallel ones?
2. **What is the minimum set of changes that achieves the stated goal?** Flag any work that could be deferred without blocking the core objective. Be ruthless about scope creep.
3. **Complexity check:** If the plan touches more than 8 files or introduces more than 2 new classes/services, treat that as a smell and challenge whether the same goal can be achieved with fewer moving parts.

Then ask if I want one of three options:
1. **SCOPE REDUCTION:** The plan is overbuilt. Propose a minimal version that achieves the core goal, then review that.
2. **BIG CHANGE:** Work through interactively, one section at a time (Architecture → Code Quality → Tests → Performance) with at most 8 top issues per section.
3. **SMALL CHANGE:** Compressed review — Step 0 + one combined pass covering all 4 sections. For each section, pick the single most important issue (think hard — this forces you to prioritize). Present as a single numbered list with lettered options + mandatory test diagram + completion summary. One AskUserQuestion round at the end. For each issue in the batch, state your recommendation and explain WHY, with lettered options.

**Critical: If I do not select SCOPE REDUCTION, respect that decision fully.** Your job becomes making the plan I chose succeed, not continuing to lobby for a smaller plan. Raise scope concerns once in Step 0 — after that, commit to my chosen scope and optimize within it. Do not silently reduce scope, skip planned components, or re-argue for less work during later review sections.

## Review topics

For substantive plans, read the relevant sections of
[review-topics.md](references/review-topics.md). Cover the architecture, quality,
tests, and operational risks that the plan actually affects. Scale the output to the
decision; a narrow review does not need every map, registry, or diagram below.

## Findings and decisions

Describe concrete issues with source references, their consequences, and a recommended
action. Include alternatives when they represent a real tradeoff. Batch the unresolved
decisions that need user input; reuse decisions already made. Do not expand implementation
scope or write speculative TODOs merely because a review surfaced an idea.

For a small plan, a short list of findings and decisions is enough. For a complex plan,
include the relevant architecture or data-flow diagram, failure-handling gaps, validation
strategy, and rollout considerations. Explain any deliberately deferred work. Do not
generate empty registries or a fixed-size completion table.

Finish the requested review with the findings, recommendation, and unresolved decisions.
If the user also requested implementation, continue within the agreed scope once any
required decisions are resolved. A review-only request does not authorize code changes.
