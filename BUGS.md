# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-005 — Avatar finger shape and wrist placement diverge from tracked hands

- **Area:** `apps/capture` hand retargeting (`HandFingerRetargeter`, arm IK)
- **Severity:** P2 — embodiment fidelity
- **Observed:** 2026-10-17 by `test:xr:hands` (IWER-emulated input; headset input pending)
- **Evidence:** `output/ci-hand-replay/iwer-emulated-pinch-report.json`. Finger
  curl follows the tracked hand over time (correlation 0.63–1.00, no lag) but
  with a constant offset of 30–66° per finger: an open tracked index measures
  5°/14°/3° at MCP/PIP/DIP while the avatar shows 29°/25°/14°; in a pinch the
  avatar bends the PIP 83° where the user bends 33°. The avatar wrist sits a
  constant ~7.5 cm (4 cm up, 6 cm forward) and ~49° from the tracked wrist.
- **Expected:** curl error ≤ 20°, correlation ≥ 0.8, wrist ≤ 5 cm and 25°
  (`TARGETS` in `apps/capture/scripts/lib/hand-fidelity.mjs`).
- **Reproduction:** `pnpm --filter @holoim/capture run test:xr:hands`.
- **Guard:** CI enforces today's values as ceilings until the fix lands.

### B-007 — Viewer AR spams `GL_INVALID_OPERATION` during IWER sessions

- **Area:** `apps/viewer-web` AR rendering
- **Severity:** P3 — rendering correctness, unconfirmed on device
- **Observed:** 2026-10-17
- **Evidence:** every AR session in `test:xr:viewer` logs `glDrawElements: Active
  draw buffers with missing fragment shader outputs` until Chromium suppresses it.
- **Expected:** no WebGL errors during AR rendering.
- **Reproduction:** run `pnpm run test:xr:viewer` and read the page console.

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
