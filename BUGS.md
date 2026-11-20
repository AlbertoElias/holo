# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-071 — Place take's second pointing link plays back 1.39 m from its hit (fails `verify:pr` on `main`)

- **Area:** apps/viewer-web (place playback) or apps/capture (link export)
- **Severity:** P1 (a stored link draws in the wrong place, and `verify:pr` fails on every branch)
- **Observed:** 2026-11-20, on a clean `origin/main` worktree (`b84dde250fb2`) and on `bug/avatar-jump`, the same value each run
- **Evidence:** `e2e/place-capture.pipeline.spec.ts:711` "link 1: the end plays back within 0.02 m of the hit": received 1.388 m. Link 0 passes, and so does the stored end of link 1 (line 705), so the error is in playback, not in the stored point.
- **Expected:** both links draw within 0.02 m of where their rays landed.
- **Reproduction:** `cd apps/viewer-web && RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer pnpm exec playwright test e2e/place-capture.pipeline.spec.ts --workers=1`

### B-072 — Feed card's reach controls sometimes stay folded under a hover (bubble-capture flake)

- **Area:** apps/viewer-web (feed card reach controls, `e2e/bootstrap.ts` `reachFor`)
- **Severity:** P3 (test flake; not seen by a person)
- **Observed:** 2026-11-20: failed 2 of 4 runs on `bug/avatar-jump` and 1 of 2 on a clean `origin/main`
- **Evidence:** `e2e/bubble-capture.pipeline.spec.ts:134` `pressViewInAr`: `.portal-controls` stays `data-reach="hidden"` through 120 s of hovers.
- **Expected:** a cursor move over the card brings out its controls every time.
- **Reproduction:** `cd apps/viewer-web && RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer pnpm exec playwright test e2e/bubble-capture.pipeline.spec.ts --workers=1`, a few runs.

### B-069 — Desktop and phone object checks fail on `main` (outside `verify:pr`)

- **Area:** apps/capture (objects)
- **Severity:** P2
- **Observed:** 2026-11-18
- **Evidence:** `pnpm --filter @holoim/capture run test:xr:object` on `main`'s sources:
  desktop-object-bracket (walking into the resting prop moves it 0.014 m, needs 0.1),
  desktop-mouse-object (aim 10 px off centre; a still release lets go 0.076 m up and the prop
  rests at 0.094 m), phone-touch-object (ankle jumps 0.041 m on a still lift),
  desktop-floor-reach (ankles dip 0.022 m during the reach, an ankle trails 0.35 m),
  reach-trench (G starts no reach), fetch-desktop (the let-go prop rests at 0.092 m, on no
  surface). The suite is not in `test:xr`, so nothing gates it. On `bug/desktop-gait` the same
  set fails, plus the floor-reach step stopping 0.18 m from the grasp point (needs 0.20–0.30)
  and still releases 1–2 cm higher (bracket put-down 0.043 m, phone lift 0.041 m, limit 0.03),
  since the desktop arms now rest in the Idle's pose instead of the bind pose.
- **Expected:** every object check passes, and the suite runs in `verify:pr`.
- **Reproduction:** `cd apps/capture && OBJECT_ONLY=desktop,mouse,phone,reach,trench,fetchDesktop node --import tsx scripts/run-xr-checks.ts object`

### B-068 — post-grant retry test returns 409 under load

- **Area:** apps/viewer-api
- **Severity:** P3 (test flake; product behavior not shown wrong)
- **Observed:** 2026-11-18
- **Evidence:** `test/post-grant.test.ts:117` "gives the grant back when a post fails, so the same take can retry": `{"error":"This take is already uploading."}: expected 409 to be 201`, in `verify:pr`'s unit step on `feature/world-change` (no viewer-api changes).
- **Expected:** the failed post releases the grant before the retry, every run.
- **Reproduction:** not reproduced in isolation (3 of 3 pass with `npx vitest run test/post-grant.test.ts`); seen once in the full `test:unit:all` under machine load. Try `CI_EMULATE_LOAD=2 scripts/ci-emulate.sh` with `--repeat-each`.

### B-070 — Quick Look check: CPU budget fires after a successful conversion

- **Area:** apps/viewer-api/tools (`glb_to_usdz.py` budget timer, `check_usdz_tools.sh`)
- **Severity:** P2 (the check is the gate before USDZ-tool changes deploy; a false failure blocks a sound change)
- **Observed:** 2026-11-18, twice on macOS. Both on the watering take, case `animated-ancestor-and-face`: the slice 1f verifier's run, and a slice 1g run.
- **Evidence:**
  - The conversion log prints "Successfully converted …", then "Quick Look conversion used more than its 100-second CPU budget".
  - The whole four-case check, inspections included, used 94.6 s of user CPU (`time -p`), so no single conversion can have spent 100 s of its own.
  - Converting the same case file alone takes 3.6 s of CPU.
  - Other runs of the same file pass all four cases.
- **Expected:** the CPU budget (`ITIMER_PROF`) fires only when the conversion itself spends 100 s of CPU.
- **Reproduction:** `bash apps/viewer-api/tools/check_usdz_tools.sh <watering.glb> <out>` on a loaded Mac. It is intermittent (about 1 run in 3 so far). The case with audio is the one that fails, so the ffmpeg child or its teardown is a suspect.

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
