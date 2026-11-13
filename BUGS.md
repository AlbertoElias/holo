# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-055 — The ar-record check's `phone-put-back` phase flakes: "the tray dock is not shown"

- **Area:** `apps/capture` (`scripts/ci-ar-record-playwright.ts`, `test:xr:ar-record`, capture XR shard 1/2)
- **Severity:** P3 (a flaky check; the product behaves correctly)
- **Observed:** 2026-11-12 on hosted CI run 43330664456 at `main` `03d7961d3c6a`: `ci-ar-record-playwright.ts:518` `tapDock`, called from `putBackPhase`'s Close-ring step, "Error: the tray dock is not shown".
- **Cause:** a race in the check, not in the app and not in B-050's change. The Stop tap starts the export. While `recordingState` is `exporting`, `PhoneArChrome.update()` hides the tray dock and closes its row. On a runner where the export outlasts the Stop tap's own `drive` (`nextFrame` waits for an animation frame, or 100 ms), `advanceUntilDownload` stops stepping the manual clock the moment the download lands. The state is `idle` by then but no step has run, so `tapDock` read the stale dock (hidden, "Exporting...") and threw. Locally the export finishes inside the tap's `drive`, so the check passed on every normal-speed run (native 9 of 9, ci-emulate 8 of 8).
- **Reproduced** by forcing the slow export: the next 100 ms timer stretched to 3 s and one animation frame ignored. The probe then read "tray dock right after the download: false, row open false, status Exporting..." and the exact hosted error followed.
- **Fix:** `tapDock` steps the simulation until the dock is visible (a frame does not step the manual clock). `putBackPhase` now forces a slow export at the Stop tap (`slowNextExport`), so every run exercises the exporting → dock hidden → dock returns path. That exposed a second stale read: after the row reopens it is still sliding out, so the Close-ring step waits until the ring holds still before tapping.
- **Expected:** the phase passes at any export speed.
- **Reproduction:** before the fix, with the slow export forced, `AR_RECORD_ONLY=put-back pnpm --filter @holoim/capture run test:xr:ar-record`.
- **Fix status:** merged; close this entry once a hosted run of `main` passes shard 1/2.

### B-060 — A feed canvas connects pointer events to a container that is gone

- **Area:** `apps/viewer-web` (`features/feed/HologramCardCanvas.tsx`, `features/ar/ARView.tsx`; `@react-three/fiber` 8 `Canvas`)
- **Severity:** P3 (a page error, no visible break; fails any e2e that asserts no runtime errors, which skips every deploy)
- **Observed:** 2026-11-13 on hosted CI, run 43356706702 (`8f5b5f3e58`), pipeline shard 8, `profiles.pipeline.spec.ts`
  "a byline name opens that creator's page": `TypeError: Cannot read properties of null (reading 'addEventListener')` in
  R3F's `events.connect`, called from the `Canvas`'s `onCreated`. The next run (43360131531) passed the shard.
- **Evidence:** not reproduced in 8 runs of that test under `CI_EMULATE_LOAD=2` (those runs failed twice on the
  5 s `expect` deadline instead (6/8 passed), fixed in the same change by the pipeline's 20 s `expect` timeout:
  the whole `profiles.pipeline.spec.ts` ×5 under load 2 then passed 30/30.
- **Expected:** a card that unmounts while its canvas is still being created leaves no page error.
- **Suspect:** R3F connects events to the `Canvas`'s wrapper `div` (`divRef.current`) in `onCreated`, which runs after
  the root renders; a card torn down in between (the search feed replaced by the creator page) leaves the ref null.
  Fix candidate once reproduced: an `events` factory whose `connect` ignores a null target.
- **Owner:** the CI reliability session (claim in `.git/holoim-ci-owner.json`).

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
