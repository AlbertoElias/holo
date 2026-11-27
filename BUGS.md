# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-113 — Pipeline e2e: an unknown hologram id shows "You're offline" on a heavily loaded Mac (once)

- **Area:** apps/viewer-web (`e2e/profiles.pipeline.spec.ts:124`, the `/h/<id>` page of an unknown id)
- **Severity:** P3 (test flake; no person has seen it)
- **Observed:** 2026-11-26, once, in `verify:pr --no-cache` on `infra/hosted-branch-gate` (no viewer-web change);
  lint and typecheck took 28 minutes in the same run. The status said "You're offline. The feed loads again when
  you're back online." for the 20 s of the check, not "not here any more". The 12 other pipeline spec files passed,
  and the hosted gate run 45852488789 passed this spec on the same tree.
- **Expected:** a 404 for an unknown id shows "not here any more", also when the API answers slowly.
- **Reproduction:** not reproduced. A suspect: a slow or failed request that the page takes as offline, not as a 404.

### B-112 — viewer-api unit test "waits past the deadline" times out on a heavily loaded Mac (once)

- **Area:** apps/viewer-api (`test/object-routes.test.ts`, "object search with a stalled Poly Pizza download")
- **Severity:** P3 (test flake; no product effect)
- **Observed:** 2026-11-26, once, in `verify:pr --no-cache` on `infra/hosted-branch-gate` (no viewer-api change)
  at load average 22: "Test timed out in 5000ms" after 54.9 s. In the same run, lint and typecheck took 29 minutes.
- **Expected:** the test finishes inside its limit on a loaded machine, or its limit fits a loaded machine.
- **Reproduction:** not reproduced. Alone, the file passes in 4.5 s (this test takes 1.5 s).

### B-111 — Viewer browser shard hits its 10-minute limit when the Playwright cache misses and apt is slow (once)

- **Area:** CI (`.github/actions/setup`, job "Viewer and Knowledge browser checks")
- **Severity:** P3 (CI flake; no product effect)
- **Observed:** 2026-11-24, hosted run 45330508669 (af3e48fa), attempt 1, shard 2/4: the job was cancelled at
  `timeout-minutes: 10`. The Playwright Chromium cache missed, and `playwright install --with-deps chromium`
  took about 7 minutes on a slow apt mirror, so the tests did not finish. Attempt 2 passed.
- **Expected:** a cache miss costs at most a few minutes and never takes a shard past its limit.
- **Reproduction:** not reproduced; it needs a cold Playwright cache and a slow Ubuntu mirror at the same time.
  `scripts/ci-apt.sh 240` bounds only the apt part with a fallback mirror (B-024).
- **Found by:** the first-attempt failure count in `docs/features/hosted-branch-gate.md`.

### B-104 — Authored takes: held grips drift since B-092 (stone sD snap, goodbye grip turn, held and support)

- **Area:** apps/capture (`scripts/authoring/lib/direct.ts`: the arm solve and the clearing plan), the sheets
- **Severity:** P2 (stone sD and goodbye v35 still fail after B-103; pinned in `sheets/regression/pins.json`)
- **Observed:** 2026-11-23, quick builds at each merge from 1f881a29c2d2 (both pieces pass every arm bar) to main.
- **Evidence:** stone sD: arms.held 107.6 mm appears at B-092 (7fcd584ec27f, the bar is new there: the 9 cm fist grip
  on a 24 cm stone is in the sheet); jump.props 5.76 m/s at 4.77 s appears at B-095 (322f09c806e7) and stays after
  B-103 (5.73 m/s; jump.me 4.69 m/s, turn.me 1008°/s at 5.07 s). Without the clearing the stone jump falls to
  3.04 m/s, but the forearm goes 5.3 cm into the torso. Goodbye v35: grip.h-bag 1.0 mm 6.4° and arms.held at B-092,
  jump.props 2.18 m/s at B-095, 3.66 m/s at B-096 (68558995a9e2); after B-103 0.4 mm 8.1°, turn.him 515°/s,
  jump.props 2.55 m/s at 1.70 s, held 9.3 mm, support 0 %. Baker: jump.b 3.71 m/s and jump.props 4.80 m/s at 4.53 s,
  held 78 mm, support 3 %.
- **Expected:** stone sD and goodbye v35 pass their arm bars again with no bar change.
- **Next fix:** trace the stone at 4.6 to 5.1 s (`HB_TRACE`-style per-frame logs, as in B-103) and find which B-095
  change moves the left hand off the stone after its grip; for the goodbye, find why the bag fist stays 8° off and
  under the bag (support 0 %). Run `pnpm --filter @holoim/capture run test:authoring:solver` and lower the pins with
  `--write-pins` as each piece improves.
- **Tried (2026-11-24, stone sD held gap):** the held gap comes from the sheet, not the solver. The 9 cm fist radius
  on the 24 cm rock puts the left thumb about 10 cm into it. Grip trials on `stone-sD.json` (solver at b9927e89e78e,
  `solver-regression.ts stone-sD`; the sheet is unchanged after the trials):

  | grip (at, radius) | grip.find (bar 5°) | arms.held.me (pin 109.2 mm) | other rows |
  |---|---|---|---|
  | [0,0.06,-0.08], 0.09 (now) | 0.3 mm, 4.5° | 109.2 mm | at the pins |
  | [0,0.06,-0.08], 0.105 | 0.4 mm, 5.5° X | 92.7 mm | smooth 12 % (pin 19 %), turn.me 514°/s |
  | [0,0.06,-0.08], 0.11 | 0.4 mm, 5.8° X | 87.0 mm | smooth 10 % |
  | [0,0.06,-0.08], 0.12 | 0.4 mm, 6.5° X | 76.2 mm | smooth 9 % |
  | [0,0.04,-0.055], 0.105 | 0.4 mm, 5.9° X | 60.8 mm | turn.me 1584°/s, arms.prop 20 mm |
  | [0,0.02,-0.03], 0.12 | 2.4 mm, 6.8° X | 44.7 mm | look-at-it 33 mm, turn.me 2145°/s |
  | [0,0,0], axis x, 0.10 | 80.5 mm, 12.3° X | — | turn.me 5004°/s, jump.props 8.25 m/s |

  Each grip that lowers the held gap puts grip.find over its 5° bar, so no grip edit passes. A fist cannot close
  around a 24 cm rock. A story change (a smaller stone, or two hands) is the owner's choice, as for the baker.
- **Tried (2026-11-24, goodbye v35 bag grip):** a per-frame wrist trace in `orientHand` (pose.ts) at the grasp
  (1.70 s) shows two causes of the 8.1°. About 2° is a turn about the fingers' own axis, which the wrist bend drops.
  The rest is the ulnar limit: the wrist wants 36° of ulnar deviation and stops at 30°, as for the baker.
  - Roll passes in `orientHand` (a further forearm roll gives back the dropped turn; patch
    `b104-roll-passes.patch` in the lead's shared notes folder, not on the branch): grip.h-bag 0.3 mm, 6.4° (pin
    8.1°, bar 5°), turn.him 270°/s (pin 515). But jump.props 3.65 m/s (pin 2.55), held 10.4 mm (pin 9.3),
    arms.elbow.him 5° (pin 3), jump.her 1.19 m/s (pin 1.04), turn.her 453°/s (pin 426). Not kept.
  - With the roll passes, bag `facing` as a number instead of `him.hips` (the handle line is a line, so 180° is the
    same): 0° 38.3°, 20° 37.5°, 45° 26.5°, 70° 16.3°, -25° 5.8° (jump.props 5.62 m/s), -40° 6.4° (jump.props
    2.52 m/s, turn.him 470°/s, held 10.4 mm, turn.her 455°/s), -55° 6.3° (jump.props 5.24 m/s, held 16.6 mm).
  - Support 0 % is by design here: the bag hangs from its handle, so no hand is under its lower half. Only a bar
    change (a hanging carry) clears that row, and no bar is changed.
  No variant passes grip.h-bag's 5° bar. The ulnar limit leaves a story change (the bag handle across the hand's
  line, a shoulder strap, or the left hand) or a time-smoothed elbow swing, as for the baker.
- **Owner verdicts (2026-11-24):** baker approved ("the loaf is fully approved"): the wall-fix draft
  (`output/proof-b104/baker-wall-fixed-draft.mp4`, solver at b9927e89e78e) is the accepted baker hold. Stone sD
  accepted "for now" ("stone is good enough for now"); no more work on its hold. Goodbye v35: the story session
  reworks its grab and face; this entry does not change the goodbye hold.
- **Baker re-pin (owner approved the draft on 2026-11-24):** the main code gives the draft's baker to 0.0 mm
  (256 frames), so the pins follow the draft. No bar and no wrist limit changes. Old → new: grip.take pass 4 mm,
  2.8° → fail 0.3 mm, 12.7°; reach.offer#2 pass 15 → fail 34 mm; reach.offer 13 → 14 mm; reach.carry 15 → 14 mm;
  reach.open 12 → 8 mm; arms.elbow.b 4° → 5°; arms.held.b fail 78 → 80.5 mm; arms.prop.b fail 42 → 25 mm;
  arms.support.b fail 3 → 25 %; jump.b fail 3.71 → pass 1.47 m/s; jump.props fail 4.8 → pass 0.64 m/s;
  turn.b 835 → 691 °/s; smooth.b 4 → 3 %. The new stone-sE case (the lid-edge reach) gets its first 15 pins.

### B-091 — verify:pr: the pipeline Playwright run does not exit after test timeouts

- **Area:** `test:smoke:pipeline` (`@holoim/web` `test:e2e:pipeline`, Playwright teardown), `verify:pr` lock
- **Severity:** P2 (a stuck run holds the machine-wide check lock, so every other `verify:pr` waits)
- **Observed:** 2026-11-22, two runs: `verify:pr` on `bug/statue-off-centre` (pid 79871) and one in the
  story session.
- **Evidence (`bug/statue-off-centre`):** the machine was overloaded (CPU 2% idle, 88 MB unused; `build`
  took 3183 s). Pipeline tests failed on their timeouts after 12 to 18 min each: `avatar-formats` unreal-cm
  (16.1 min), vrm0-minus-z (17.0 min), pointing take (15.2 min), `bubble-capture` (12.0 min),
  `capture-to-viewer` (15.9 min), `hand-traces` ×4 (15.1 to 17.9 min), `hologram-budgets` 3 M splat
  (15.0 min). Then "Worker teardown timeout of 30000ms exceeded". After that, the Playwright runner stayed for
  about 3 h with no worker and no browser. Only its web servers stayed (vite preview on 3174 and 5175, the API,
  the registry fixture server), all at 0% CPU. The run ended only when it was stopped by hand.
- **Expected:** after test timeouts and a teardown timeout, the runner exits with a failure and `verify:pr`
  releases the lock.
- **Reproduction:** run `verify:pr` on a machine with no free CPU or memory, so the pipeline tests time out.

### B-088 — Feed card: R3F events connect to a null div (seen once, not reproduced)

- **Area:** apps/viewer-web (`HologramCardCanvas`, R3F 8.18 `Canvas`)
- **Severity:** P3 (one e2e failure, no user report)
- **Observed:** 2026-11-21, once, in a `verify:pr` on `feature/story-first-authoring` merged with `b4cdc100`
- **Evidence:** `e2e/profiles.pipeline.spec.ts:127` ("search narrows by title or creator…") failed on "viewer
  runtime errors": `TypeError: Cannot read properties of null (reading 'addEventListener')` in
  `Object.connect` ← `onCreated`. R3F's Canvas calls `events.connect(divRef.current)` when the inner
  (concurrent) root makes its first commit, a task after the outer commit. So the card's div was detached
  before that commit. FrameGate is not the cause: the card Canvas had the same props before it (`06572ed5`).
- **Not reproduced:** on `b4cdc100` under `CI_EMULATE_LOAD=2 scripts/ci-emulate.sh`: the test alone ×20 and the
  whole spec ×5 (30 tests) all passed. Four forced-race pages on the dev server did not throw either: an
  unmount during the inner render, an unmount at four timings (with and without StrictMode and transitions),
  suspending canvases under an outer Suspense, and StrictMode's double cleanup then a re-render and an unmount.
  React 18 renders the default-lane inner root without yielding, and an unmount before it batches a null update
  with the mount, so the window that is left is narrow.
- **Expected:** a card that leaves before its scene commits throws nothing.
- **Candidate fix (not landed, unproven):** pass `events={safeCanvasEvents}` to the card and AR canvases, where
  `safeCanvasEvents` wraps R3F's `events` and skips `connect` for a null target. The root then connects to its
  own canvas element. Land it when the failure shows again, and prove it against that run's conditions.
- **Reproduction:** none known. If it shows again, keep the run's `test-results` trace and note the load and
  the other specs in the same worker.

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
  After B-086's fix (2026-11-23), on the house base (the default avatar) desktop-object-bracket fails the
  same way (walking into the prop moves it 0.014–0.096 m across runs, a glancing hit), while on the stock
  avatar it now passes; the mouse let-go is 0.036 m up and the prop rests at 0.084 m.
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

### B-085 — Deep zoom: the camera mode is "follow", not "free", when the wheel stops (hosted 3 times; reproduces in CI emulation)

- **Area:** apps/viewer-web (`e2e/deep-zoom.spec.ts`, portal wheel gesture)
- **Severity:** P3 (test flake; no person has seen a wrong camera)
- **Observed:** 2026-11-20, hosted run 44815715770 (caf7cad), job "Portal view end-to-end"
- **Evidence:** `deep-zoom.spec.ts:241`: `expect(stopped.mode).toBe("free")` received `"follow"`. The next run on `main`
  (44826449489, 12b0a45) passed the same job. caf7cad holds the performer floor (85ee704b62ba, B-083), which
  changes the card's camera fit, so a slow fit is a suspect.
- **Expected:** the wheel gesture that stops at the inside end leaves the camera in free mode on every run.
- **Observed again:** 2026-11-23, hosted run 45195106971 (22199d76), same job and line. Later runs on `main` passed it.
  (An earlier line also named run 45269930460 on 79475539; its log shows `portal.spec.ts:214`, which is B-090.)
- **Reproduction:** `scripts/ci-emulate.sh bash -c "cd apps/viewer-web && VITE_IWER_SEM_SCENE=office_small XR_TEST_MODE=iwer pnpm exec playwright test e2e/deep-zoom.spec.ts --workers=1 --repeat-each=5"`
  with no extra load fails at line 241 in 5 of 5 runs on 9cc877c5 and 4 of 5 on 22199d76. On a Mac it passes.
  So the failure is in the code before 22199d76; the render-order change there (avatar see-through parts) is not the cause.
- **Seen in the same job, a different test (2026-11-24):** hosted run 45340950168 (8107f752, a tooling-only merge),
  attempt 1. `portal.pipeline.spec.ts:120`: after two wheel steps on a point of the hologram, the camera distance
  stayed 7.14 (expected the inside distance, 1.6) for the 10 s of the poll. `deep-zoom.spec.ts` passed in that
  attempt. Attempt 2 of the same commit passed the job, and four local runs of the file passed that day. It is
  possibly the same cause (a wheel on the hologram that the slow runner does not take as a zoom); not examined.
- **`portal.pipeline.spec.ts:120` observed again (2026-11-26):** gate run 45847778751 (`verify:hosted`, tree a7cd7367,
  `infra/hosted-branch-gate`, no viewer-web change), attempt 1: the same numbers (7.14 against 1.6 for the 10 s poll).
  The gate's one rerun of the job passed.

### B-101 — House avatar: the jumper's sleeve end has a jagged edge at the wrist

- **Area:** `apps/capture/scripts/authoring` house avatar (jumper cuff mesh against the hand skin)
- **Severity:** P3 (a draft look fault; no bar sees it)
- **Observed:** 2026-11-23, pinch v14 at 1.0 to 3.9 s (right wrist); the approved pinch v8 has the same edge
- **Evidence:** the opus review of pinch v14 and crouch v43 saw a saw-tooth edge where the cuff meets the hand skin.
  It is the line where the two meshes cross, not a gap. The B-099 cuff refit does not make it worse (the same edge is in
  v8 and v12). In v14 the palm faces the camera, so more of the edge is in view. The crouch sleeve end is smooth.
- **Expected:** the sleeve ends in a clean ring at the wrist.
- **Reproduction:** `node --conditions=development --import tsx scripts/authoring/make.ts output/authoring/gesture-proof/pinch.json`
  in `apps/capture`, then `review.ts` on the take and a crop of the right hand at 3.4 s.
- **Tried (2026-11-24, not merged):** in `house-base/build.py` (the `sleeveEnd` block), each vertex in a face that
  crosses the cut plane moved onto the plane, in the base mesh and in every shape key. The saw-tooth stayed. The
  separate jumper garment (`dress.garments`, called after the sleeve block) is made from the body's jumper faces,
  with ease along the normals, a taper at the openings (`taperAt`), smoothing and a push out. Its own wrist boundary
  makes the flaps, which stand off the skin.
- **Tried (2026-11-24, branch `bug/sleeve-end` 9a8883e80aec, not merged):** with the `sleeveEnd` plane 1 cm up the
  forearm, the sleeve's opening is on the forearm bones, so the jumper's `taperAt` (the hand bones) never tapered
  it: the opening had the full 16 mm ease and stood off the skin in flaps. In `dress.py` a `cuff` block now takes
  the opening on the forearm and hand bones, pins it, sets it to a circle on a plane across the forearm (radius
  28 mm, the widest point plus 8 mm), fades that ease into the sleeve over `taper`, and keeps the body's faces
  within 4 cm of it as skin under the cuff. In close renders of pinch at 3.4 s (Blender, 4 views of the right hand,
  old v14 against new) the opening is now one round ring. But it reads as a wide open tube, its inside shows, and
  the kept skin under it has thin spikes where its faces meet the hand. Not better enough to keep.
- **Tried (2026-11-24, `bug/sleeve-end` 2e84de1953fd and 424b6b138fbd, not merged):** the ring closed on the wrist
  (ease 3 mm, the opening's mean radius) and turned in by one row (`hem` 6 mm up the sleeve), the skin kept 2 cm
  under it. In close renders of pinch at 2.0 s (wrist bent) and 3.4 s the saw-tooth is gone: the cuff ends in one
  clean ring with a thin light hem, and the skin under it shows no spikes. The dressed avatar is 1.56 MB (bar 1.80).
  But the jumper's vertices feed the arm samples of the solver and the arm checks (`bindVertices` in
  `arm-quality.ts` takes every visible skinned mesh), so the cuff moves pinned numbers (the files on `main` pass all
  cases):
  - with the `sleeveEnd` plane (the jumper ends 1 cm before the wrist): baker arms.prop.b 48 mm (pin 42), goodbye
    arms.elbow.him 4° (pin 3), stone-sD smooth.me 10 % (pin 19) and arms.support.me 0 % (pin 3). The same without the
    vertex snap.
  - the ring at the jumper's own sleeve end (no `sleeveEnd` plane): only stone-sD moves, smooth.me 11 % (pin 19),
    and arms.prop.me 20 mm (pin 15) with the skin kept under the cuff. Without the kept skin, and without the hem,
    smooth.me stays at 11 %.
- **Next fix:** decide which surface the arm samples take. If the solver and the arm checks should see the body and
  not the clothes, `bindVertices` takes the `Body` mesh only; the cuff then moves no number, but the pins move once
  for every case (a re-pin that waits for the owner). Otherwise accept stone-sD smooth.me 11 % in the stone re-pin
  that already waits for the owner. The render tool and the before/after crops are in the shared notes
  (`b101-cuff/`).

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
