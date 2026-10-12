# Feature Delivery Workflow

This is the canonical feature-delivery process. `AGENTS.md`, the
`feature-delivery` skill, and `AGENT_CONTRACT.md` only point here; edit this
file to change the process. `AGENT_CONTRACT.md` remains canonical for commands
and validation tiers.

## Where state lives (one authority per phase)

| Phase | Authority | Not duplicated in |
|---|---|---|
| Uncommitted product thinking | `docs/product/IDEAS.md` (Idea → PRD → Decision) | `TODOS.md` |
| Committed queue, not started | `TODOS.md` | Feature briefs |
| In flight | The feature brief in `docs/features/` (index: `docs/features/README.md`) | `TODOS.md`, `HANDOFF.md` |
| Verified defects | `BUGS.md` (open only; closed → `docs/archive/closed-bugs.md`) | `TODOS.md` |
| Session pointer | `HANDOFF.md` (next action + unverified only) | Briefs, trackers |
| Completed features | `docs/features/archive/` | Live brief index status beyond Complete |

Use this workflow for product behavior changes. Start by copying
[`templates/FEATURE_BRIEF.md`](templates/FEATURE_BRIEF.md). A small change can keep
all roles with one agent, but the lead must preserve the review and verification
steps. Changes to recording, retargeting, shared contracts, storage, or the
export-upload-render pipeline should use separate agents for review and verification.

## Roles

| Role | Responsibility | Required output |
|---|---|---|
| Lead | Owns the feature brief, scope, decisions, integration, and final handoff | Accepted brief and final evidence summary |
| Design reviewer | Challenges the approach before implementation | Failure cases, tradeoffs, and specific changes to the plan |
| Implementer | Changes only the assigned files and adds behavior coverage driven by the brief | Working code and the commands/artifacts it produced |
| Independent verifier | Evaluates the result from the brief and current tree, without relying on the implementer's account | Pass/fail against each acceptance criterion and reproducible defects |

The lead assigns one owner per file or module before parallel implementation.
Agents may investigate in parallel, but two agents must not edit the same file.
Shared contracts are owned by a single integrator, and downstream implementers
consume the agreed contract.

## Delivery sequence

1. **Brief.** State the user outcome, explicit exclusions, observable acceptance
   criteria, plausible failure cases, ownership, and validation plan.
2. **Design review.** Challenge boundary behavior and the simplest implementation
   that preserves capture -> upload -> render compatibility. Update the brief with
   the decision.
3. **Implementation.** Work within assigned ownership. A discovered scope change
   goes back to the lead before it spreads across modules.
4. **Independent verification.** Give the verifier the original brief and working
   tree. The verifier exercises the real workflow where practical and records an
   inspectable artifact such as a transcript, screenshot, or deterministic output.
5. **Integration.** The lead resolves findings, runs the commands required by
   [`../AGENT_CONTRACT.md`](../AGENT_CONTRACT.md), and records device-only gaps.
6. **Close.** Mark the brief Complete, move it to `docs/features/archive/`,
   update the index in `docs/features/README.md`, check off the `TODOS.md`
   item if one exists, and move any closed bugs to
   `docs/archive/closed-bugs.md`. Leave `HANDOFF.md` as a pointer to the next
   action only.

## Testing rules

- Prefer the end-to-end user workflow for complex behavior.
- If isolated tests are necessary, enumerate plausible system failure modes in the
  brief before writing the tests and select cases from that list.
- A reproduced regression becomes a test that fails before the fix when practical.
- IWER proves deterministic emulated XR behavior. It does not prove tracking feel,
  comfort, performance, or device-specific session behavior; list those checks as
  physical-device evidence or as an explicit remaining limit.
- Evidence must say what ran and what it established. A command name alone is not
  evidence when the result or artifact is unavailable.
