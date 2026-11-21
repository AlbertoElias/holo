# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-087 — VR head walk: the pelvis drops in one frame at each foot landing

- **Area:** apps/capture (`VrBodySolver` pelvis height in the gait)
- **Severity:** P3 (found by measurement, not yet seen by the owner)
- **Observed:** 2026-11-20, on `bug/vr-legs-direction`
- **Evidence:** `test:xr:walk-direction`, head rows, with the head moved on every XR frame. In the steady walk the hips'
  vertical acceleration averages 1.8–4.1 m/s², but single frames at a foot landing reach 12.8 (forward), 20.7 (left),
  16.8 (back), 20.2 (right), 18.8 and 18.6 m/s² (diagonals). The head bobs smoothly (2 cm).
- **Expected:** the pelvis rises and falls smoothly with the stride, with no single-frame drop.
- **Reproduction:** `pnpm --filter @holoim/capture run test:xr:walk-direction`, then the hips' vertical second
  difference against the sample time `t` in `output/ci-walk-direction/head-samples.json`.

### B-076 — No-fingers avatar's desktop take diverges from the shipped avatar on `main`

- **Area:** apps/capture (`scripts/ci-avatar-formats-playwright.ts`, desktop locomotion take)
- **Severity:** P3 (the check fails; no person has seen a wrong pose)
- **Observed:** 2026-11-20, on `main` (`55f421598851`) and on `bug/vr-arm-natural`, the same values
- **Evidence:** `XR_AVATAR_ONLY=no-fingers` avatars check: the take's states are
  walk>idle>fall>idle>jump>fall>idle against the shipped avatar's
  walk>idle>fall>idle>fall>idle>jump>fall>idle, and leftHand is 4.0 / 7.1 / 1.6 / 4.0 cm off at
  2200 / 2300 / 2500 / 2600 ms. Its object sub-check also fails, on the B-069 desktop and phone rows.
- **Expected:** the no-fingers avatar plays the same take as the shipped avatar, inside the pose tolerance.
- **Reproduction:** `cd apps/capture && XR_AVATAR_ONLY=no-fingers node --import tsx scripts/run-xr-checks.ts avatars`
- **Cause (suspected):** the physics of the take diverges (one fall>idle is missing), so the hand
  error follows from a different state, not from the arm solve.

### B-086 — The house avatar sinks to the floor on a floor reach

- **Area:** apps/capture (floor reach, house base avatar)
- **Severity:** P2
- **Observed:** 2026-11-20
- **Evidence:** the capture `object` suite on the house base (the default avatar): in
  put-down, a still release, a still touch lift and desktop-floor-reach the hips go down
  to 0.08–0.18 m above the floor (limit 0.27 m), a knee drops to 0.07–0.19 m below its
  ankle (limit 0.02 m above) and a thigh turns 11.3–11.6° in one step (limit 10°). The
  stock avatar in the same runs: hips 0.24–0.25 m, no knee or thigh failure (its own
  failures are B-069). The crouch depth is in metres tuned on the stock avatar's legs;
  the base's legs are shorter.
- **Expected:** the reach crouch fits the avatar's leg length; the hips stay above the limit.
- **Reproduction:** `cd apps/capture && OBJECT_ONLY=desktop,mouse,phone,reach,resizeIwer node --import tsx scripts/run-xr-checks.ts object`

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

### B-081 — A dark strip of the default scene's mountain floats behind the performer on the card

- **Area:** apps/capture (`SceneBubbleSampler.triangleInsideBubble`), apps/viewer-web (feed dome clip)
- **Severity:** P3
- **Observed:** 2026-11-20, phone journey audit, card seen from behind the performer
- **Evidence:**
  - The strip is 82 triangles of `Montanha_lambert13_0`, 5.99–8.67 m from the bubble centre.
  - The export keeps a triangle whose nearest point lies within 6 m of a sample.
  - The feed's dome (radii about 7 × 4.7 × 7 m) is wider than the 6 m reach, so the card shows the triangles.
  - The viewer, XR and AR fade the set past the reach, so they do not show it.
  - Renders and per-mesh measurements are in the session notes `option-b/` folder (`compare.jpg`, `C-compare.jpg`, `clip-reach-3d.txt`).
- **Expected:** set past the take's reach does not float as a separate shape on the card.
- **Tried and rejected:**
  - A hard cut at the reach in the feed: it broke a structure 2 m behind the performer on an old take.
  - The sphere's soft fade in the feed: it faded the ground under the performer on another old take.
  - The owner kept the card as it is.
- **Next:** a take whose spawn keeps the mountain more than 6 m away removes the strip at its source (B-082).
- **Reproduction:** post a phone take on the default scene, then view its card from behind the performer.

### B-082 — A take on the default scene starts on the statue

- **Area:** apps/capture (`CharacterMotor` spawn search), apps/viewer-web (cloche rim)
- **Severity:** P2
- **Observed:** 2026-11-20, phone journey audit
- **Evidence:**
  - The spawn search takes the scene's centre first, and the statue stands there, so every default-scene take starts on top of it.
  - The fix 3400acffe803 (branch `bug/spawn-off-statue`) skips a pedestal.
  - With that fix, `bubble-capture.pipeline.spec.ts` failed twice with "start: bins off the ground". At bin 12 the rim is at 18.67 and the raycast ground at 17.91, edge (7.95, 2.99).
  - So the fix is not on `main`.
- **Expected:** the performer starts on the grass beside the statue, and the rim stays on the ground.
- **Reproduction:** record any take on the default scene in capture.
- **Next:**
  - Find what the rim stands on at bin 12 with the spawn fix: geometry that the test's ground list (grass and mountain) leaves out, or an export fault.
  - A spawn spot off the statue with flat ground at the rim, and with the mountain more than 6 m away, is also acceptable.

### B-083 — The performer floor on the card makes the AR route miss its 20 s load on a slow runner

- **Area:** apps/viewer-web (`HologramCardCanvas` fit, `motionPoints`)
- **Severity:** P1 (`main` red on runs 44815715770 and 44826449489)
- **Observed:** 2026-11-20, hosted pipeline shard 1
- **Evidence:**
  - `bubble-capture.pipeline.spec.ts:142`: `.xr-view-container` does not mount within 20 s after "View in your room"; the page shows "Loading hologram…" later.
  - CI emulator, bubble-capture ×3: 0af7fc10cc under `CI_EMULATE_LOAD=2` passes 3/3; caf7cad fails at :142; caf7cad without 85ee704b62ba passes 3/3; caf7cad at plain load passes 3/3.
  - 85ee704b62ba adds a third `drawnPoints` + `motionPoints` pass over the whole take for each card, in `fitClocheNow`, which runs again when the bubble or the place gate changes.
- **Expected:** the performer floor costs no more than one fit pass, and the AR route mounts in time on a loaded runner.
- **Reproduction:** `CI_EMULATE_LOAD=2 scripts/ci-emulate.sh bash -c "cd apps/viewer-web && RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer npx playwright test e2e/bubble-capture.pipeline.spec.ts --workers=1 --repeat-each=3"` on caf7cad.
- **Next:** 85ee704b62ba is reverted on `main`. Bring the floor back with the performer's points taken from the same sampling pass, and pass the reproduction above before the merge.

### B-084 — The feed take does not start in bubble-capture after the VR arm change

- **Area:** apps/capture (arm IK, 12b0a45c2d1a) or apps/viewer-web feed playback
- **Severity:** P2
- **Observed:** 2026-11-20, CI emulator
- **Evidence:**
  - `bubble-capture.pipeline.spec.ts:98`: "feed sphere follows recorded motion (clip time 0 → 0 s, running false)".
  - 12b0a45 without 85ee704b62ba: 1 of 3 at plain load, and with :126 ("the rim's largest change in a frame") in 3 of 3 under `CI_EMULATE_LOAD=2`.
  - 0af7fc10cc and caf7cad without 85ee704b62ba never failed at :98 or :126 (6 runs).
- **Expected:** the take plays in the feed on every run.
- **Reproduction:** the B-083 command on `main` after the revert, at plain load and at load 2.

### B-085 — Deep zoom: the camera mode is "follow", not "free", when the wheel stops (hosted, once)

- **Area:** apps/viewer-web (`e2e/deep-zoom.spec.ts`, portal wheel gesture)
- **Severity:** P3 (test flake; no person has seen a wrong camera)
- **Observed:** 2026-11-20, hosted run 44815715770 (caf7cad), job "Portal view end-to-end"
- **Evidence:** `deep-zoom.spec.ts:241`: `expect(stopped.mode).toBe("free")` received `"follow"`. The next run on `main`
  (44826449489, 12b0a45) passed the same job. caf7cad holds the performer floor (85ee704b62ba, B-083), which
  changes the card's camera fit, so a slow fit is a suspect.
- **Expected:** the wheel gesture that stops at the inside end leaves the camera in free mode on every run.
- **Reproduction:** not tried yet. Try `CI_EMULATE_LOAD=2 scripts/ci-emulate.sh bash -c "cd apps/viewer-web && VITE_IWER_SEM_SCENE=office_small RUN_E2E_PIPELINE=1 XR_TEST_MODE=iwer npx playwright test e2e/deep-zoom.spec.ts --workers=1 --repeat-each=5"` on caf7cad.

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
