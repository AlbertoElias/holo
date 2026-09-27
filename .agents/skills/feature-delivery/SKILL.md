---
name: feature-delivery
description: Plan, implement, and verify HoloIM product features or meaningful behavior changes using the repository's feature brief, scoped agent roles, and risk-based validation. Use automatically for feature requests and substantial bug fixes in this repository.
---

# HoloIM Feature Delivery

Use this workflow when the user asks to add or materially change product behavior
in this repository. Do not activate it for questions, documentation-only edits,
formatting, or small mechanical changes. Honor the user's requested scope and
preserve any in-progress work in the shared tree.

## Start from the repository state

Read `HANDOFF.md`, `BUGS.md`, and `TODOS.md` when relevant. Inspect `git status`
before editing and identify changes that predate this feature. Read
`AGENT_CONTRACT.md` for commands, boundaries, and XR environment requirements.
For capture XR changes, also read `docs/IWSDK_AI_WORKFLOW.md`.

## Shape the feature

For a new feature or substantial behavior change, create a brief from
`docs/templates/FEATURE_BRIEF.md` under `docs/features/`. Keep the outcome small
and observable. State exclusions, acceptance criteria, likely failure cases,
validation evidence, and any physical-device checks. For a narrowly scoped bug
fix, a concise checklist in the working notes may replace a persisted brief when
that is enough to make expected behavior and regression coverage clear.

Investigate the current behavior and simplest compatible change before editing.
Preserve API compatibility unless versioning is explicit and keep the
GLTF export → upload → viewer flow compatible. For consequential design choices,
get a read-only challenge before implementation. Give each parallel implementer
exclusive files or modules; keep shared-contract decisions with one owner. For
small changes, one agent can perform these roles in sequence.

## Implement and verify

Implement only the agreed scope. Prefer checking the real end-to-end user flow for
complex behavior. When isolated tests are needed, first list plausible failure
modes and use them to decide what to cover; do not add tests merely to ratify code
after the fact. A reproduced defect should become a regression check when
practical.

After implementation, independently compare the working result with the original
acceptance criteria. Exercise boundary cases and inspect logs, screenshots, or
other outputs where useful. Do not rely only on the implementer's summary. Run
the affected app or package's `verify:fast`, then broaden validation according to
`AGENT_CONTRACT.md`; use `pnpm run verify:fast` for cross-app changes. Use
`pnpm run verify:xr` for XR behavior and `pnpm run test:smoke:pipeline` for
export, upload, storage, or render contract changes.

For browser-driven XR, use the repository's IWER/Playwright harness and HTTPS
setup. Report emulated results separately from physical headset evidence. IWER
does not establish tracking feel, comfort, real-device performance, or
device-specific session behavior.

## Finish the work

Resolve actionable review findings, update `BUGS.md`, `TODOS.md`, and
`HANDOFF.md` when current state or next actions change, and report what changed,
which checks passed, what the evidence establishes, and any remaining device-only
work. Keep the feature brief's status and evidence current when one was created.

Follow `docs/FEATURE_WORKFLOW.md` for the repository's role definitions and
`AGENT_CONTRACT.md` for the authoritative validation matrix.
