# Claude prompt: refactor capture onto native IWSDK

Copy the text below into a new Claude Code session attached to this repository.
This is an implementation prompt, not a request to run another spike.

---

Implement the production IWSDK runtime refactor for HoloIM capture. The
locomotion, terrain, height/refit and room-scale body work has landed on main.
We want clean, performant, testable code and fast, reliable agent iteration.
Preserve all current behavior and recorded-event fidelity while replacing custom
runtime infrastructure with native IWSDK. Do the implementation, resolve
migration failures, verify it, and commit/push the finished branch; do not stop
at a proposal or leave the old orchestrator wrapped as the final result.

The handoff is on `origin/infra/iwsdk-prototype`. First read:

- `docs/features/archive/iwsdk-runtime-refactor.md` — the authoritative scope, architecture,
  frame/transform contract, failure cases, delivery sequence, acceptance and gates.
- `docs/IWSDK_RUNTIME_PROTOTYPE.md` and `docs/evidence/iwsdk-runtime-prototype/`
  — successful older prototype and its actual limits.
- Current main's AGENTS.md, AGENT_CONTRACT.md, `.agents/skills/feature-delivery/SKILL.md`,
  FEATURE_WORKFLOW.md, IWSDK_AI_WORKFLOW.md, and hologram concept.

Fetch and inspect Git before touching files. The handoff observed main at
`cdad1c4a869eb1d75242e7a14dbfc292c78d0cd6`; refresh it rather than treating that
SHA as the forever baseline. The prototype runtime commit `fb5c1d61d22d` predates
all the completed movement work. Start a new worktree/branch from latest main,
not from the prototype branch. Suggested setup (first check the path/branch do
not already exist; reuse only a suitable worktree):

```bash
git fetch origin
git worktree add ../holoim-iwsdk-refactor -b infra/iwsdk-runtime-refactor origin/main
cd ../holoim-iwsdk-refactor
git restore --source=origin/infra/iwsdk-prototype -- \
  docs/features/iwsdk-runtime-refactor.md \
  docs/IWSDK_RUNTIME_PROTOTYPE.md \
  docs/prompts/claude-iwsdk-runtime-refactor.md \
  docs/evidence/iwsdk-runtime-prototype \
  docs/features/archive/iwsdk-runtime-prototype.md
pnpm install --frozen-lockfile
```

Those restores import documentation/evidence only. Add the active brief to the
CURRENT main-based feature index, preserving its existing rows. Do not import
this old branch's root trackers/instructions, manifests, lockfile, tsconfig, or
whole runtime commit. Inspect prototype source with `git show` and selectively
port useful ideas. Current main requires Node 22 and native TypeScript 7
(`tsc` is its stable native binary); preserve the current shared lint/config.

The shared main checkout had another session's uncommitted hand/IK/UI/recording/
export fixes and a real Quest hand fixture. Check whether their owner has now
committed/pushed them and incorporate that committed work before editing the
same modules. Do not stash, reset, stage, copy or overwrite another session's
work. The plan lists the observed paths. Keep useful baseline/design work moving
while that ownership is resolved; ask only if a concrete blocker remains.

Use the feature-delivery workflow with separate design review and independent
verification. Native World should own the production scene/renderer/XR lifecycle
and ordered systems, with one clock and one simulation pipeline. Preserve Rapier,
LocomotionAnimator, TerrainLegSolver, VrBodySolver/legIk, height/refit and
hand-retarget algorithms initially. Keep one writer per transform and correct
real-XR device frame order. Do not enable SDK locomotion/physics on top of the
existing motor. Keep current desktop/VR/AR controls, recordings, GLB/audio/bubble,
portal viewer and USDZ compatibility. No viewer migration or UI redesign here.

Close the spike's missing software coverage: production entry/build, AR
recenter/alpha, height/body integration, diagnostic/spectator rendering,
deterministic clock adapters and actual outer CLI/MCP transport. Prove native
pause/step and useful domain controls affect real simulation and recording.
Remove redundant render/session/debug glue and the all-in-one compatibility
wrapper. Preserve the documented UIKit dedupe and unused spatial-audio clock
boundary or replace them with independently verified equivalents.

Run current gates, not the old prototype's smaller suite. Capture now includes
mock-vr, locomotion, terrain, hands, height and body; retain body fault injection
and deterministic replay. The pipeline includes capture-to-viewer, bubble-capture
and portal tests. Establish the latest baseline and distinguish pre-existing
failures from migration regressions; do not hide them with skipped checks,
threshold relaxation or retries. Use free isolated ports and keep browser suites
sequential unless every runtime resource is isolated. Run verify:agent during
edits and verify:pr before PR/merge, per the current contract.

Save before/after metrics and deterministic samples, rendered screenshots/video,
exports and viewer readback, actual MCP transcript, performance measurements and
an explicit deleted/retained infrastructure map. Use the same workload for
comparisons; do not claim that adopting IWSDK inherently improves frame rate.
If physical Quest measurement is unavailable, finish and publish the verified
software work with that device gap stated clearly. Respect existing consequential-
action boundaries and repository integration policy. Keep the feature brief as
the single implementation authority and finish with evidence and exact remaining
limits.
