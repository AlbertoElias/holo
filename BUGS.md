# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

None.

### B-043 — The bubble pipeline test cannot click its card's AR button after the avatar-format uploads

- **Area:** `apps/viewer-web` e2e (`test:smoke:pipeline`, part of `verify:pr`)
- **Severity:** P2 (fails `verify:pr` locally; the pipeline stage is not in hosted CI)
- **Observed:** 2026-11-11 on `main` `623e4645f986` and on `bug/b041-avatar-objects`
- **Evidence:** `e2e/bubble-capture.pipeline.spec.ts:44` "real capture bubble exports, uploads and draws in feed and
  immersive AR" times out after 6 min at `bubble-capture.pipeline.spec.ts:126`: clicking the new card's
  `.ar-trigger-button` keeps hitting `<div data-reach="hidden" class="portal-controls" data-portal-mode="follow">`
  (and `.portal-controls-side`), which "intercepts pointer events". 2 of 2 full-stage runs on the branch and 1 of 1 on
  `main` fail the same way; the other 27 tests pass.
- **Expected:** the card's AR button is clickable whatever other cards the feed already holds.
- **Reproduction:** `pnpm run test:smoke:pipeline` (about 17 min). The spec alone passes
  (`RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer pnpm exec playwright test e2e/bubble-capture.pipeline.spec.ts` in
  `apps/viewer-web`, 57 s), so it depends on the three `avatar-formats` uploads that run before it. Suspect: a
  portal-controls overlay marked `data-reach="hidden"` still takes pointer events over the neighbouring card.

## Entry template

```md
### B-### — Short symptom

- **Area:** app/package
- **Severity:** P0 | P1 | P2 | P3
- **Observed:** YYYY-MM-DD
- **Evidence:** link, error, or test name
- **Expected:** behavior
- **Reproduction:** minimal steps
- **Fix:** commit hash and validation (when closed)
```
