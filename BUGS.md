# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-076 — VR head walk: the legs seem to walk forward in every direction

- **Area:** apps/capture (`VrBodySolver` gait)
- **Severity:** P2
- **Observed:** 2026-11-20 (owner, on a Quest: "When using headset movement, the legs are always moving forward,
  even when lateral or backwards.")
- **Evidence:** the IWER head walk at 1.14 m/s (ignored audit `output/motion-audit/direction.ts`, tag `before-dir`).
  The recorded (forward) walk plays only forward and front-right, as decision 4 = B asks; every step lands within
  8° of the travel. Sideways the feet trail the pelvis: hips 51 cm (left) and 45 cm (right) ahead of the feet's
  midpoint, against 11 cm forward. The legs reach back under a body that slides sideways.
- **Expected:** the feet step in the travel direction and stay under the pelvis in every direction.
- **Reproduction:** `pnpm --filter @holoim/capture run test:xr:walk-direction`, head rows left and right.

### B-077 — VR stick walk: the body and the legs are not vertically aligned

- **Area:** apps/capture (`VrBodySolver.planRoot`, `MovementSystem`)
- **Severity:** P1
- **Observed:** 2026-11-20 (owner, on a Quest: "With stick, the body and the legs don't seem to be vertically
  aligned.")
- **Evidence:** full stick (1.83 m/s), audit tag `before-dir`. Forward: torso leans back 10.5° (neck 6 cm behind its
  standing place), pelvis 13 cm ahead of the feet. The root ran 8 cm ahead of the tracked eyes in the travel
  direction (backward too). Sideways the pelvis is 50–52 cm ahead of the feet; diagonals 41–45 cm ahead and 34–35 cm
  aside. Desktop at the same speed: 12.5 cm, no lean.
- **Expected:** the torso keeps its standing posture and the pelvis stays over the feet.
- **Reproduction:** `pnpm --filter @holoim/capture run test:xr:walk-direction`, stick rows.

### B-073 — VR elbows point out or up, not down (fixed elbow hint)

- **Area:** apps/capture (`ArmIkSolver`, `AvatarRig.createArmIkChain`)
- **Severity:** P2
- **Observed:** 2026-11-20
- **Evidence:** `test:xr:arms` and the Quest 3 hand take (`docs/features/realistic-avatar-motion.md`,
  cause 24). The bend plane comes from a fixed avatar-space hint that points almost straight
  sideways (`elbowHintLocal`). Elbow swivel about the shoulder–wrist line (0° down, 90° out):
  Quest take median 92° (elbows straight out the whole take); scripted rest and walk 140° (forward
  and up, 93–100% of frames above 120°); low side reach −175° (elbow up).
- **Expected:** a relaxed arm's elbow hangs down and back; a reach bends it down and out.
- **Reproduction:** `cd apps/capture && node --import tsx scripts/run-xr-checks.ts arms`, rows
  rest, side-low and walk, column swivelMed.
- **Decision needed (owner):** a better constant hint, or an elbow from the pose or from
  recorded motion (the owner prefers recorded motion to hand-tuned springs).

### B-074 — VR shoulders swing past a human range

- **Area:** apps/capture (`ArmIkSolver` protraction)
- **Severity:** P2
- **Observed:** 2026-11-20
- **Evidence:** cause 24. The clavicle aims at the target near full reach. Clavicle swing range:
  Quest take 77°, scripted hands 103°, across and chest reaches 68° (a human clavicle moves
  about 25–30°). The steep band (`smoothstep` 0.75–1.0 of the reach) still steps the clavicle
  up to 21°/frame on the across reach and 22° on the Quest take.
- **Expected:** the shoulder shrugs and protracts in a human range, without steps.
- **Reproduction:** as B-073, columns clavPush and clavStep.
- **Decision needed (owner):** cap the clavicle (a wrist then misses long reaches, the
  height-fitted arm is short) or fit the avatar's arm length to the user's.

### B-075 — Controllers miss long reaches by 15 cm

- **Area:** apps/capture (`HandEmbodiment`, `ArmIkSolver` reach stretch)
- **Severity:** P3
- **Observed:** 2026-11-20
- **Evidence:** cause 24: forward-far and overhead rows, controller wrist error 14.8 cm (hands
  3.6 cm). The 8% reach stretch is for tracked hands only; on controllers it broke the IWER
  resize take and desktop-reach-interruptions (gap 4).
- **Expected:** the avatar's hand stays on the controller on a full reach.
- **Reproduction:** as B-073 with `ARM_REACH_INPUTS=controller`.
- **Decision needed (owner):** together with B-074 (arm-length fit would close both).

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
