---
name: test-audit
description: "Writing/changing/reviewing/sweeping tests: reject duplicate or implementation-coupled proof; remove test-only production seams."
---

# Test Audit

- Authoring gates every new/changed test.
- Audits: remove low-value proof in coherent owner batches; never chase deletion counts.
- Whole-subsystem campaign: read [CAMPAIGN.md](CAMPAIGN.md) first.
- Adapted from openclaw/openclaw `.agents/skills/test-audit` for HoloIM (apps and packages, not plugins).

## Authoring gate

Before adding test, answer:

1. Protected observable behavior, invariant, or independent contract?
2. Credible regression that makes it fail?
3. Why existing proof misses it? Each contract: one primary owner at strongest
   boundary. Another layer needs distinct transport/lifecycle risk. Extend
   tables/shared fixtures; consolidate repeated setup.
4. Export, flag, wrapper, injection hook with no production caller needed?
   Move proof to real boundary instead.

- Follow the testing doctrine in the root `AGENTS.md` and `AGENT_CONTRACT.md`: end-to-end tests are the
  preferred proof for complex features; never add tests after the fact to ratify code.
- Regressions must fail pre-fix for intended reason, pass after repair; report
  unavailable baseline proof.
- One owner regression covers bug; never replay at every crossed layer.
- Behavior-preserving refactors should not break test.

## Junk patterns

- Reject self-comparisons, copied inventories, source greps,
  implementation/call-shape assertions, duplicate contracts, test-only seams,
  subject-generated expected values, mocks supplying asserted behavior.
- Fixtures must not fabricate owner receipts/order or claim persistence path
  never writes.
- Negative controls must fail at intended guard; names must match exercised behavior.
- Auditing candidates: use [full checklist](references/audit.md#junk-patterns).

## Retention bar

- Keep independent API, SDK, protocol, config, migration, storage, security,
  platform, default, prompt-byte, generated-language, package, release,
  architecture, observable-ordering contracts. Static/slow ≠ disposable.
- Source inspection must survive identifier-only refactors and guard independent
  user-facing contract.
- Baseline failures may be bugs to repair, not tests to delete.

## Audit and validation

- Before audit edit: read [candidate evidence and workflow](references/audit.md#candidate-evidence);
  inspect full owners/callers/history; record remaining proof before deletion.
- Delete obsolete production seams with tests; never optimize for deletion counts.
- Follow the doctrine in `AGENTS.md`: run owner/sibling proof with the narrowest check first
  (`AGENT_CONTRACT.md` "Fast Agent Loop"), then `pnpm run verify:agent`; never rely on hosted CI.
  Do not edit the checkout during a running test; then run `/code-review`.
- Report causes, retained contracts, proof/cost, production versus test LOC,
  follow-ups. Commit and merge per the workflow in `AGENTS.md` (own worktree, local `verify:pr`, merge to `main`, no PRs).
