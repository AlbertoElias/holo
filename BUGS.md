# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-020 — Capture's height check is not repeatable

- **Area:** `apps/capture` XR checks (`test:xr:height`)
- **Severity:** P3
- **Observed:** 2026-10-24
- **Evidence:** two runs of `main` (`eebf013`) with
  `XR_CHECK_CONCURRENCY=2` give `output/ci-xr-height/height-report.json`
  positions up to 0.45 mm apart (`baseWorldY`, sensor and bone positions),
  found while comparing the slice 0 port in
  `docs/features/ui-redesign.md`. The check still passes.
- **Expected:** identical reports, as `AGENT_CONTRACT.md` says of the XR
  checks; `compare-xr-reports.ts` tolerates 1 mm in this file meanwhile.
- **Reproduction:** run `pnpm --filter @holoim/capture run test:xr:height`
  twice and compare the two output folders with
  `node --import tsx scripts/compare-xr-reports.ts`.

### B-021 — The AR bubble render check sometimes times out waiting for the card

- **Area:** `apps/viewer-web` e2e (`test:xr:viewer`)
- **Severity:** P3
- **Observed:** 2026-10-24
- **Evidence:** `e2e/ar-bubble.spec.ts:70` fails at
  `toHaveAttribute("data-model-state", "rendered")` after 5 s with
  `"ready"`: 1 of 12 repeats on `main` (`eebf013`) and 3 of 18 on the
  slice 0/1 branch of `docs/features/ui-redesign.md`, with other sessions
  loading the machine.
- **Expected:** the card renders within the wait every time, or the wait
  follows the work it waits on rather than a fixed 5 s.
- **Reproduction:** `VITE_IWER_SEM_SCENE=office_small XR_TEST_MODE=iwer npx
  playwright test e2e/ar-bubble.spec.ts:70 --workers=1 --repeat-each=6`
  from `apps/viewer-web`.

### B-022 — Recorded floor is not the viewer's floor (feed cloche, AR placement)

- **Area:** `apps/viewer-web` (feed cloche, R3F AR); same pattern on
  `feature/viewer-xr-interface` (`features/xr/hologramAssets.ts` `standOnFeet`)
- **Severity:** P1 (every capture with a scene; a recorded person stands on the floor)
- **Observed:** 2026-10-25, reported by the user on https://holoim-viewer.pages.dev
- **Evidence:** the floor check in `e2e/bubble-capture.pipeline.spec.ts` on a
  real capture export: feed cloche foot 2.77 m below the recorded floor; AR
  recorded floor 12.5 m above the placement surface. Live uploads are
  consistent (ground 3–15 cm under the foot bones), so export is not at fault.
- **Expected:** the capture scene's ground under the author is the floor the
  viewer uses: the cloche's foot and shade on it, and in AR, it on the room floor.
- **Reproduction:** open a capture with a scene in the feed (the dome's foot
  sits under the terrain, so the grass reads at mid-height of the hologram) or
  in AR (the author floats far above the room floor). AR stood the model on the
  lowest point of the whole scene bubble (terrain flanks, the 6 m bubble
  sphere); the cloche stood on the lowest drawn point inside the bubble.

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
