---
name: feature-delivery
description: Plan, implement, and verify HoloIM product features or meaningful behavior changes using the repository's feature brief, scoped agent roles, and risk-based validation. Use automatically for feature requests and substantial bug fixes in this repository.
---

# HoloIM Feature Delivery

Trigger skill only. The canonical process — roles, delivery sequence, testing
rules, and where state lives — is [`docs/FEATURE_WORKFLOW.md`](../../../docs/FEATURE_WORKFLOW.md);
commands and validation tiers are in [`AGENT_CONTRACT.md`](../../../AGENT_CONTRACT.md).
Do not duplicate that process here; edit those files to change it.

Use this workflow when the user asks to add or materially change product behavior
in this repository. Do not activate it for questions, documentation-only edits,
formatting, or small mechanical changes. Honor the user's requested scope and
preserve any in-progress work in the shared tree.

## On activation

1. Read `HANDOFF.md`, `BUGS.md`, and `TODOS.md` when relevant; inspect
   `git status` and identify changes that predate this feature.
2. Create a brief from `docs/templates/FEATURE_BRIEF.md` under
   `docs/features/`, add it to the index in `docs/features/README.md`, and
   follow the delivery sequence in `docs/FEATURE_WORKFLOW.md`. For a narrowly
   scoped bug fix, a concise checklist may replace a persisted brief.
3. For capture XR changes, also read `docs/IWSDK_AI_WORKFLOW.md`. For any UI
   or visual change, follow `docs/product/design/styleguide.md` and its
   `tokens.json`.
4. On close, follow the Close step in `docs/FEATURE_WORKFLOW.md`: archive the
   completed brief and any closed bugs, and update only the owning tracker.
