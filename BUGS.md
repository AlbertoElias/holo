# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-068 — post-grant retry test returns 409 under load

- **Area:** apps/viewer-api
- **Severity:** P3 (test flake; product behavior not shown wrong)
- **Observed:** 2026-11-18
- **Evidence:** `test/post-grant.test.ts:117` "gives the grant back when a post fails, so the same take can retry": `{"error":"This take is already uploading."}: expected 409 to be 201`, in `verify:pr`'s unit step on `feature/world-change` (no viewer-api changes).
- **Expected:** the failed post releases the grant before the retry, every run.
- **Reproduction:** not reproduced in isolation (3 of 3 pass with `npx vitest run test/post-grant.test.ts`); seen once in the full `test:unit:all` under machine load. Try `CI_EMULATE_LOAD=2 scripts/ci-emulate.sh` with `--repeat-each`.

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
