# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-019 — Desktop pointing take ends its link early on hosted CI, blocking deploys

- **Area:** apps/capture (pointing desktop take), apps/viewer-web pointing pipeline e2e
- **Severity:** P1 (the CI gate skips every deploy while it fails)
- **Observed:** 2026-10-24, main CI on `cbf22beb`, `935f02e1` and `3538a339`
- **Evidence:** `e2e/pointing.pipeline.spec.ts:145` › desktop-recorded take:
  `B: link 4.8–5.75 s is not within 0.35 s of the hold 4.8–6.2 s`, the same
  numbers on every run. Passes locally on macOS and under `scripts/ci-emulate.sh`
  (pipeline shard 1, 6/6).
- **Expected:** the recorded link ends within 0.35 s of the scripted hold.
- **Reproduction:** push to `main` with a pipeline-area change; pipeline shard 1
  fails. Not yet reproduced off the hosted runner (x86_64 Ubuntu, 2 vCPU).

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
