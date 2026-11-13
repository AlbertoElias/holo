# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-044 — On the user's table scan, the author's feet end 3 cm off the scan's floor

- **Area:** `apps/viewer-web` e2e and `packages/place` (split capture slice 2a)
- **Severity:** P3 (the case runs only where the user's own scan is on disk, an ignored file; the
  committed fixtures pass)
- **Observed:** 2026-11-11 on the merged slice 1 + 2a tree
- **Evidence:** `e2e/place-capture.pipeline.spec.ts:1042` "the downloaded scan table.spz", "the author's feet on the
  scan's floor": 0.029969515228847526 m against the 0.02 m limit, the same value in 2 of 3 runs (the third passed).
  The scan is a table rather than a room, 472,273 splats, from Scaniverse.
- **Expected:** the author stands on the scan's floor within 0.02 m, as on the committed fixtures.
- **Reproduction:** put the scan at `apps/viewer-web/public/local-places/table.spz` (and in the cached e2e build's
  `local-places/`), then in `apps/viewer-web` run
  `RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer pnpm exec playwright test e2e/place-capture.pipeline.spec.ts`.
  Suspect: the floor band of a scan whose floor is sparse around a table, or the end pose landing mid-step.

### B-054 — The summon XR check's `desktop-anytime` phase flakes on "mid-take row: no tray row"

- **Area:** `apps/capture` (`scripts/lib/tray-anytime-take.mjs`, `test:xr:summon`)
- **Severity:** P3 (a phase of the summon XR check; not in `verify:pr`'s pipeline stage)
- **Observed:** 2026-11-12 on `claude/bug-b-050-object-search-24dbf3`, found while verifying B-050
- **Evidence:** `SUMMON_ONLY=desktop-anytime` fails at `tray-anytime-take.mjs:204` (`checkRow(rowMid, { filled: 2, ... where: 'mid-take row' })`) with "no tray row": 2 of 3 runs with the B-050 fix, 1 of 4 without it, so the fix does not cause it. It ran at a load average of 30 or more.
- **Expected:** the tray dock shows its row mid-take on every run.
- **Reproduction:** `SUMMON_ONLY=desktop-anytime pnpm --filter @holoim/capture run test:xr:summon`, repeated on a loaded machine. Not isolated; suspect the same starved-page timing as B-050 (a wait that ends before the dock re-renders).

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

### B-062 — Find's Speak button stays on "Stop listening" after a refused recognition that has no recorder to fall back on

- **Area:** `apps/capture/src/objects/voiceInput.ts` (`startRecorder`, reached from `startRecognition`'s `onend`), shown by `ObjectFinder.tsx` and `VrFindPanel.ts`
- **Severity:** P3 (needs a browser that lists the Web Speech API but has no `navigator.mediaDevices`, i.e. a page served over plain `http://` on a LAN address; production is HTTPS. Typing and Enter still search; closing the sheet resets it)
- **Found:** 2026-11-13 by `/find-implicit-state-machines` (queue item 8, voice input), modeled in `VoiceInput.tla` (side-session notes), replayed against the real page
- **Reproduced (`test:xr:summon`, phase `desktop-voice-orders`):** tap Speak (recognition starts), the recognition fails with `not-allowed` and ends. `onend` sets the machine's `state` idle without telling the session, then `startRecorder` finds no `getUserMedia`, logs "no MediaRecorder" and shows "type instead", and returns without a state change. The session's `voice` is still `listening`: the button reads "Stop listening", Find stays disabled, and a tap on Stop calls `stop()` on nothing.
- **Expected:** the buttons follow the machine: back to "Speak" with the "type instead" line.
- **Fix:** `startRecorder`'s no-recorder branch sets the state idle through `setState`. Replay `desktop-voice-orders`: failed before the fix, passes after. Landed `f73048cc171b` (2026-11-13). Hosted run 43478134507 passed every capture job and the capture deploy; it is red only in a viewer redesign test from the viewer-timecode merge, so this stays open until a green run.
- **Not defects (modeled and replayed, recorded in `TODOS.md` item 8):** a transcription answer arriving after the sheet closed is discarded (abort); a `getUserMedia` answer after cancel is closed (generation).

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
