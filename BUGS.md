# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-032 — A 1 s phone hold on TargetA came out "too brief" on CI

- **Area:** `apps/capture` AR recording (`ar-record` XR check, `marks-a`;
  `PointResolver.ts` `rejectReason`, `POINT_DWELL_SEC` 0.4 s)
- **Severity:** P1 (failed `main`'s Capture XR shard 1, so nothing deploys)
- **Observed:** 2026-10-27, CI run 40460444582 on `2f3067a`
- **Evidence:** `hold-on-target-a` (`phoneHold`, 1000 ms of wall time) made no
  link: the resolver's unlinked runs end with `"too brief"`, so the take had 2
  links, and the check paired the walking hold (12.083–12.683 s) with the
  stationary one's touch (11.233–11.533 s). The run recorded 789 camera keys;
  three emulated shard runs (`scripts/ci-emulate.sh`, `XR_SHARD=1/2 pnpm run
  test:xr:capture`) recorded 942–978 and passed, so the hosted runner was
  slower than the emulation and the failure did not reproduce. The same job
  passed on `a8dc19b`.
- **Expected:** a 1 s hold on a target makes its link whatever the frame rate,
  or the check says why it cannot; if a slow phone can lose a deliberate mark,
  that is a capture defect, not only a check's.
- **Reproduction:** not yet reproduced; try the emulator with fewer CPUs
  (`CI_EMULATE_CPUS=0`) or a throttled frame rate.

### B-025 — Portal "desktop freeze" check finds the feed back at the top

- **Area:** `apps/viewer-web/e2e/portal.spec.ts` ("desktop freeze: … scrolling away resets"), portal scroll capture
- **Severity:** P3
- **Observed:** 2026-10-26, on `main` at `ac700f0f`
- **Evidence:** `expect(await feedScrollTop(page)).toBeGreaterThan(0)` at
  `portal.spec.ts:408` receives 0. Fails 3 of 3 on `main` when the whole
  `portal.spec.ts` runs (`--repeat-each=3`, one worker), passes 3 of 3 when
  the test runs alone. The paused card's capture may undo the instant
  `scrollIntoView` before the reset lands.
- **Expected:** scrolling to the next card from a paused card stays there.
- **Reproduction:** `E2E_BASE_URL=https://localhost:3274 E2E_API_PORT=3101 VITE_IWER_SEM_SCENE=office_small XR_TEST_MODE=iwer pnpm --filter @holoim/web exec playwright test e2e/portal.spec.ts --repeat-each=3 --workers=1`

### B-024 — CI's pipeline shard can spend its whole timeout installing ffmpeg

- **Area:** `.github/workflows/ci.yml` pipeline job (`apt-get install ffmpeg`), `scripts/ci-emulate.sh`
- **Severity:** P2
- **Observed:** 2026-10-26, runs for `4178f157` and `da4a008b`
- **Evidence:** in both runs shard 1/2 never started its tests: the
  "Install Quick Look conversion dependencies" step pulled ffmpeg's ~90
  packages from `azure.archive.ubuntu.com` at minutes per package and the
  job hit `timeout-minutes: 20` (cancelled; CI Gate failed, deploy
  skipped). Shard 2/2 installed the same packages in seconds. The same
  tests pass locally in 5.2 min. Separately, `ci-emulate.sh` cannot run
  this suite: it installs Chromium through `@holoim/capture`, but the
  pipeline launches `chromium_headless_shell-1208`, which is missing.
- **Expected:** a slow apt mirror does not cancel the run; e.g. a
  static ffmpeg binary or a cached `.deb` set, and a step timeout so the
  failure names the install rather than the job.
- **Reproduction:** intermittent on hosted runners; see the two runs above.

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


### B-028 — A take drops set geometry whose vertices are far apart, such as a large floor

- **Area:** `apps/capture/src/recording/SceneBubbleSampler.ts` (`triangleInsideBubble`)
- **Severity:** P2
- **Observed:** 2026-10-25, while building AR recording (`docs/features/archive/ar-recording.md`)
- **Evidence:** the bubble clip keeps a triangle only when two of its
  vertices lie within 6 m of a sample. `fixtures/scenes/pointing-targets.gltf`'s
  `PointingFloor` is a 14 m box with 12 vertices, so no triangle qualifies:
  `output/ci-marks/desktop.glb` and `controllers.glb` (performer takes, the
  same code as `main`) and the camera take `output/ci-ar-record/phone-a.glb`
  hold `TargetA` and `TargetB` but no floor. The capture view shows the floor
  under the author.
- **Expected:** set geometry the take stood on or near is kept whatever its
  tessellation (for example, a triangle is kept when it comes within the
  radius of a sample, not only its vertices).
- **Reproduction:** `pnpm --filter @holoim/capture run test:xr:marks`, then
  list the node names of `apps/capture/output/ci-marks/desktop.glb`: there is
  no `PointingFloor_RecordedBubble`.

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
