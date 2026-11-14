# Feature brief: The avatar moves naturally, whatever drives it

**Lead:** Claude Code (Opus), session "natural avatar motion"
**Status:** Reviewed (scope approved by the user 2026-11-13; design review below)
**Layer:** event (the recorded body is the hologram's raw material; see
`docs/product/concepts/what-a-hologram-is.md`)

## User outcome

Whatever drives the avatar — a VR headset (hands, controllers, room-scale
body), Quest passthrough AR, phone AR, the camera (IDEA-078) or keyboard,
mouse and controller on the desktop capture page — the recorded body moves
like a person: feet plant instead of sliding or sinking, knees and elbows
never bend backwards, nothing trembles when the user holds still, and hands
and aim land where the user put them. One report grades every source the same
way, so "natural" is a number per source, not an opinion per brief.

This brief is the umbrella for all avatar driving (solving, IK, retargeting,
smoothing, locomotion) and its grading. It owns the TODOS item "Make all
avatar movement look completely natural, in XR and 2D".

## Scope

**Included:** one motion-quality instrument for every source; per-source
baselines and targets; fixing the worst gaps in order; one lean guard per
source inside the existing replay checks; the camera driver (folded in from
the camera spike).
**Excluded:** the phone journey (Record button, sign-in, share sheet,
post-take upload) — owned by "Phone capture mandate", which consumes the
camera driver; physical-device validation until the user is back from
travelling; an all-fixture regression corpus; analytics.

## Undo

None: this changes how the avatar is solved and graded, not what the author
can do in a take.

## The instrument

`apps/capture/scripts/lib/motion-quality.ts` (`measureMotion`, `judgeMotion`,
`MOTION_TARGETS`), with the CLI `scripts/motion-quality-report.ts` for saved
samples. It measures what mocap cleanup studios clean up:

| Metric | Definition |
|---|---|
| Foot contact | Sole (lower of ankle and toe) within 2 cm of its rest height **and** moving under half the hips' speed (floor 0.3 m/s), for at least 100 ms. Speeds are ±33 ms central differences |
| Foot skate (max, share) | Max horizontal slide of the foot's stiller end (heel at strike, ball at push-off) across one contact; share = contact frames moving faster than 15 cm/s |
| Float p95 · penetration | Sole height above its rest height while still in contact · deepest sole below it. Rest height comes from the take's first 0.5 s (every in-app check starts standing), so a foot that lifts or sinks after the rest reads; a take that floats from its first frame is offset away, and the body replay's absolute planted-sole guard (≤ 2 cm above the ground raycast) catches that one |
| Pops p99 | p99 joint acceleration over exactly ±50 ms, every joint and frame: pin and release snaps and solver flips, with or without input. Each side is read at t ± 50 ms by linear interpolation between the frames around it, so a take stepped unevenly (the replay's 32/48 ms frames) is read at the same span as the CMU walks the target came from. Rounding the span to whole frames read only ±34 ms on the replay (inflating pops); taking the nearest frames ≥ 50 ms away read ±64–80 ms (hiding them) |
| Joint limits | Share of frames with a knee bent backwards (against both the hips' and that foot's forward), an elbow bent the wrong way, a knee or elbow folded tighter than 25°/30°, or the spine twisted > 45° |
| Jitter p95 | p95 deviation from the joint's own smooth path, a centred 1 s least-squares quadratic fit against timestamps (Savitzky–Golay), inside held-still windows (≥ 1 s, trimmed 0.3 s each end), so a held joint that settles along a curve is not counted as noise. A quadratic also absorbs a slow wobble (period ≳ 1 s) that a moving mean counted; tremor-rate noise is unchanged. Rays keep the camera spike's centred 1 s moving mean, in degrees |
| Following | Wrist error p95 against tracked input, best-fit latency, jerk ratio avatar/input, aim error median |

Every guard reads the same functions; a source only chooses its target row.
The tracked input is also run through the instrument, so each row shows the
"input floor" a solver cannot beat.

## Baselines (2026-11-13) and targets

Targets are aggressive and anchored to real motion:
- **Feet and pops:** two CMU Motion Capture Database walks (subjects 02 and 07, trial 01; BVH in ignored `output/mocap/`), graded by the same instrument. They read skate max 2.6–3.9 cm, skate share 10–16%, pops p99 34–45 m/s², 0% joint limits. Targets sit at or below the better walk: skate ≤ 3 cm / ≤ 10%, pops ≤ 35 m/s². Penetration ≤ 0.5 cm and float ≤ 1 cm are mocap-cleanup tolerances (the CMU floor drifts ~3 cm, so its own reads are unusable).
- **Hands:** the Quest 3 recording (`fixtures/input-recordings/headset-open-fist-pinch-point-wave-reach.json`).
- **Camera:** the user's 80 s iPhone clip.

Calibrating against the CMU walks changed the instrument: the first version
scored real walking at 32–50 cm skate (toe clearance in swing is 1–2 cm, so
height alone took swing for contact) and the hips-forward knee test flagged
turns. All body fixtures are IWER-synthetic; the only real headset data is
hands-only.

| Source | Feet: skate max / share · float · penetration | Pops p99 | Joint limits | Jitter (input floor) | Following | Verdict |
|---|---|---|---|---|---|---|
| **Target, all bodies** | ≤ 3 cm / ≤ 10% · ≤ 1 cm · ≤ 0.5 cm | ≤ 35 m/s² | 0% | ≤ 2 mm (camera ≤ 8 mm, rays ≤ 3.5°) | wrist ≤ 1.5 cm (hands 2 cm), latency 0 (camera ≤ 100 ms), jerk ≤ 1.2, aim ≤ 3.5° | |
| Human reference (CMU 02_01 / 07_01) | 3.9 / 16% · 07_01 2.6 / 10% | 34 / 45 | 0% | — | — | anchor |
| Desktop keyboard (walk, strafe, back, crouch-walk, flat floor) | 0.7 cm / 4.0% · 0.9 · 0.0 (was **8.6 / 16% · 0.3 · 5.3** at 3.24 m/s) | 31 (was **116**; 27.6 on the earlier whole-frame stencil) | 0% | 0.1 mm | n/a | pass at 1.8 m/s (gap 1 done) |
| Camera (spike, `bodycam:report`) | unmeasured | unmeasured | unmeasured | ray **5.7–20°** (best variant 2.6°) | aim at the lens median **8.6°** (best ray: knuckle, perspective-corrected; target 3.5°), head yaw p95 8.2° | aim miss accepted (Decision 4); body unmeasured |
| VR body, walk ramp | 1.6 cm / 5.3% · 0.0 · 0.1 (base **4.1 / 3.8% · 1.0 · 1.2**) | 34 (base **37**) | 0% | 0.3 mm (base 1.8) | — | pass (gap 3 done) |
| VR body, walk | 2.0 cm / 3.6% · 0.0 · 0.0 (base 2.9 / 3.8% · **1.05** · 0.3) | 34 (base 35) | 0% | 0.6 mm (base 1.3) | — | pass |
| VR body, turn | 0.6 cm / 2.3% · 0.0 · 0.0 (base 2.5 / 2.5% · 0.6 · 0.3) | 29 (base 28) | 0% | 0.6 mm | — | pass |
| VR body, small steps and sway | 0.7 cm / 1.2% · 0.0 · 0.0 (base 0.7 / 1.9% · 0.8 · 0.3) | 10 | 0% | 0.4 mm | — | pass |
| VR body, crouch and lean | 0.0 cm / 0% · 0.0 · 0.0 (base 0.1 / 0% · 0.7 · 0.3) | 5 | 0% | 1.2 mm (base 1.2) | — | pass |
| VR body, every skeleton (worst of 7 fixtures × 5 rows) | 2.0 cm (walk, every fixture) / 5.4% (twisted T-pose, ramp) · 0.0 · 0.1 | 34 | 0% | 1.2 mm (crouch) | — | pass |
| VR hands, real Quest 3 recording | — | — | unmeasured (hand samples carry no elbows) | 2.3 (2.9) mm | wrist p95 **3.0 cm**, lag 0, jerk 1.03 | wrist miss (gap 4) |
| VR hands, IWER | — | — | unmeasured | 1.9 (1.9) mm | wrist 0.0 cm | pass (limits unmeasured) |
| Quest passthrough AR | unmeasured (same body solver as VR; to confirm) | | | | | gap |
| Phone AR | unmeasured (avatar placed and driven from the phone; to confirm) | | | | | gap |

Jitter at or under the input floor is the tracker's, not the solver's; the
target there is "no worse than input".
"Base" in the VR body rows is the solver before gap 3 (`0594f565`) graded
by today's instrument, so each pair differs only by the solver.

## Ranked worst gaps (execution order)

1. **Done (2026-11-13): desktop feet and pops.** See the evidence table. Walking moved the root at 3.24 m/s while the
   clip's planted foot still slides 0.5–1 m/s, sinks 5 cm, and pops at 3× human.
   The most-watched path (every desktop and emulated take). Fix per design
   review 5–8: measure each clip's stance-foot speed by FK at load and set
   `timeScale = rootSpeed / clipSpeed`; handle strafe and backward walking
   (lower-body yaw toward travel, negative timeScale, or directional clips);
   pin planted feet in `TerrainLegSolver` (one writer per leg) from
   precomputed stance phases; knees always forward.
   How it closed: the walk speed was lowered to 1.8 m/s (Decision 3). The
   keyboard ramps at 12 m/s². The 5-key walk is smoothed, its hips bob is
   rebuilt from the feet, and its stride is laid down 1.2× longer. Cadence
   comes from the FK stance speed. Feet pin from stance phases where they are.
   The swing never travels back and lifts clear. Soft reach stops the knee
   snapping straight. A backward start takes the reversal at once. The desktop
   crouch key is a spring on a ramped target.
2. **Camera body and jitter (aim settled).** The measured aim clip
   (2026-11-14, branch `feature/camera-avatar-on-motion`) puts one camera's
   aim at 8.6° median at best, against 3.5°; the user accepted rough aim
   (Decision 4). Remaining: sample avatar bones in `bodycam:report` on every
   supported skeleton so the body row stops being unmeasured, the real-time
   rate, and a phone trial. Runs after gap 3.
3. **Done (2026-11-14): VR room-scale feet and pops.** On today's instrument
   the solver missed ramp skate 4.1 cm, ramp penetration 1.2 cm, ramp pops
   37 m/s² and walk float 1.05 cm (`VrBodySolver.ts`, `legIk.ts`).
   How it closed: a rolled foot pivots on its real ball or heel, tilted to the
   ground, and toes stay flat on a heel-up foot. A planted leg reaches at most
   98% before the foot rolls, under the soft end of leg IK, which now starts at
   98.45% (was 95%), so a planted ankle lands where it is placed instead of
   floating; the authoring poser's `plantFeet` shares that IK and now places
   near-straight legs exactly up to the same reach. The pelvis lowers only
   past 98.4% with the foot fully rolled. Pops came from the swing foot's own
   travel (about 1 m in 0.3 s): the swing now takes 85% of the step (was 80%)
   and travels from toe-off, keeping only the 5% settle before landing that
   stops the heel scuffing in; a still start cost a tenth of the swing time
   for no less scuffing, and a sin² lift or a bang-bang travel read worse.
   Instrument fixes, part of the same change: pops read exactly ±50 ms by
   interpolation (the replay's 32/48 ms frames had read ±34 ms), and jitter
   fits a quadratic against timestamps (a crouch settling had been counted as
   noise; the base solver already passes crouch on it, 1.2 mm). The CMU
   anchors are unchanged by construction (even 120 fps frames); desktop-motion
   re-reads 31 m/s². The body replay grades every row strictly against these
   targets on the default avatar; the `avatars` check grades only walk and
   crouch per skeleton by default, and all five rows with the command in the
   test plan (all 7 fixtures pass). Trade-off: walking eye error p95 rose on
   every moving row (walk 2.2 → 3.5 cm, ramp 2.3 → 2.6, small steps and turn
   3.2 → 3.9; Unreal cm small steps 4.2; guard 4.5), because the hips no
   longer stay up on a floating ankle and the longer swing holds each foot
   off the ground longer.
4. **Real-headset wrist error** 3.0 cm against 2 cm (IK lag over long reaches;
   `ArmIkSolver`).
5. **AR sources measured.** Add Quest AR and phone AR rows to the existing AR
   checks; fix only if they miss.

Each gap ends with: its row meeting target, the source's guard turned strict,
and a before/after proof video (ignored `output/`, H.264 MP4, never committed).

## How the existing work folds in

| Item | Action |
|---|---|
| `room-scale-body-motion.md` (Verifying) | Close as Complete; its leftover feet and knee gaps become gap 3 here. Its `body-fidelity.ts` thresholds stay as the per-fixture guard; the VR rows above are graded by this instrument |
| `hand-tracking-fidelity.md` (Verifying) | Close as Complete; the 3.0 cm wrist error becomes gap 4. Fix its stale path `scripts/lib/hand-fidelity.mjs` → `apps/capture/scripts/lib/hand-fidelity.ts` |
| `archive/avatar-locomotion.md`, `archive/locomotion-retarget.md` (Complete) | Stay closed; their unvalidated headset check and missing VR arm tracks go under Physical-device limits here |
| Camera spike (`feature/camera-avatar`, `camera-avatar-spike.md`, slices 1–2 done) | Taken over by this brief (Decision 2); its jitter definition is now the instrument's |
| TODOS "Make all avatar movement look completely natural" | Points here. Its wishlist (full-body IK with comfort costs, arm swing, hip sway, weight shift) is the fix toolbox for the gaps above; "robotic" motion that passes every metric is judged in the proof videos, and a missing metric is added before tuning by eye |

## Consumers

`docs/features/directed-performance.md` imports the solving modules and this
instrument read-only, grading authored takes as source `authored` (body
targets, no input). A house avatar becomes capture's default only after this
report passes on it.

## Acceptance criteria

- [ ] One report grades every source with the same metrics and per-source targets.
- [x] Desktop keyboard row meets target; guard strict in `desktop-motion`.
- [ ] Camera row has measured body numbers that meet target, behind `?input=camera`; aim is measured (8.6° median) and is not held to 3.5° (Decision 4).
- [x] VR body walk/ramp/turn rows meet target; strict in the body replay (2026-11-14, gap 3; crouch and small steps too).
- [ ] Real-headset wrist p95 ≤ 2 cm.
- [ ] Quest AR and phone AR rows measured; any miss fixed.
- [ ] Each gap closes with a before/after proof video sent to the user.
- [ ] Every supported skeleton meets each row's target: the desktop and VR motion checks grade each avatar fixture the `avatars` check loads (`scripts/ci-avatar-formats-playwright.ts`: reoriented axes, A-pose, T-pose, twisted T-pose, VRM 0 facing −Z, Z-up, Unreal centimetres), not only the default avatar (user direction, 2026-11-14). VR part done (2026-11-14): all 5 VR body rows meet target on all 7 fixtures; desktop and camera parts pending.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A metric rewards the wrong thing (walking counted as jitter) | Jitter windows are per-joint stillness, checked against the input floor |
| Fixing one source regresses another (shared solver code) | Every guard runs in `verify:pr`; one instrument, so a regression shows as one number |
| Synthetic fixtures pass while real motion fails | Targets anchored to real recordings; physical checks listed below |
| Ground misread (wrong floor height) | Ground comes from the app's own terrain raycast (`body.ground`), not a hard-coded height |
| Camera driver lands in files the phone session edits | Boundary agreed: phone owns `src/post/`, `ui/`, `camera/`, `RecordingSession.ts`; this brief owns avatar, `bodycam/`, `XrTracking`, `TrackedHandsSystem`, `HandEmbodiment`, `FaceDriver`, `PointResolver` |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | this session | Brief, instrument, integration |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only |
| Implementer | this session, one gap at a time | `src/avatar/`, `src/body/`, `src/xr/` tracking and hands, `src/physics/` locomotion, `scripts/lib/motion-quality.ts`, motion checks |
| Independent verifier | `verifier` subagent + `/code-review high` | Read-only |

## Decisions (user, 2026-11-13)

1. **Public mocap for the feet targets: approved.** CMU walks 02_01 and 07_01
   downloaded to ignored `output/mocap/`; targets above are calibrated on them.
2. **Camera spike: taken over** by this brief; rebased onto `main` after gap 1.
3. **Desktop walk is a brisk walk, ~1.8 m/s (2026-11-13).** The keyboard walks
   one avatar height per second (1.8 m/s at 1.8 m), down from 3.24 m/s (a jog
   the shipped walk clip cannot plant). VR stick speed is unchanged.
4. **Camera aim is rough, not precise (2026-11-14).** One camera aims at
   8.6° median at best (target 3.5°). The camera avatar ships with rough aim
   and does not promise precise pointing; the body, head and fingers are
   still held to target. Execution order is now gap 3, then the camera body.

## Design review (2026-11-13, `design-reviewer`, Opus)

| # | Finding | Resolution |
|---|---|---|
| 1 | Float offset from the take's own p05 hides a take that floats throughout | Rest height from the first 0.5 s (in-app checks start standing); mocap passes `soleOffset: 'take'` |
| 2 | One-frame speed turns tracker noise into skate | ±33 ms central differences |
| 3 | Height-only toe contact counts heel strikes and grazes | Contact also needs speed under half the hips', ≥ 100 ms; slide measured at the stiller end |
| 4 | No pop metric for sources without input | `popP99MS2` added for every body source |
| 5 | Clip rate formula is clip-agnostic (timeScale always 1.4) | Gap 1 plan |
| 6 | Rate sync cannot fix strafe or backward walking; 3.24 m/s needs ~2.3× a walk clip | Gap 1 plan; lowering desktop walk speed is a product decision for the user if it comes to that |
| 7 | Pin in `TerrainLegSolver` from precomputed stance phases, release on over-stretch | Gap 1 plan |
| 8 | `kneesForward` set only when planted or bent | Gap 1 plan |
| 9 | Knee test against hips forward flags turns | Backwards against both hips and foot forward |
| 10 | Guard should grade what export bakes | Pin runs in `BodyPoseSystem` (50) before `RecordingSystem` (90), so live bones equal recorded tracks; grading the exported GLB is a follow-up if they ever diverge |

## Test plan and evidence

| Acceptance criterion | Workflow or command | Result |
|---|---|---|
| Desktop row | `node --import tsx scripts/run-xr-checks.ts desktop-motion` (strict, in `test:xr`) | gap 1 (2026-11-14, with the floor-skin guard): skate 0.72 cm / 4.0%, float 0.87, penetration 0.00, pops p99 31.2 (exact ±50 ms; 27.6 on the k=2 stencil), joint limits 0%, jitter 0.07 mm, walk speed 1.799 m/s, all targets met |
| Human anchor | x | CMU reads above |
| VR body rows | `pnpm --filter @holoim/capture run test:xr:body` (strict motion grading per row; `BODY_REPLAY_FAULTS=1` for the 12-fault matrix) | gap 3 (2026-11-14, exact ±50 ms pops): every row meets target (table above); fault matrix 12/12 caught |
| VR body rows, every skeleton | `XR_AVATAR_ONLY=<fixture> XR_AVATAR_BODY_REPLAYS='crouch,small-steps,turn,walk-forward,walk-ramp' pnpm --filter @holoim/capture run test:xr:avatars`, one fixture per run (all five rows take ~200 s a fixture; the default run replays walk-forward and crouch) | 2026-11-14: all 7 fixtures pass every row, strict |
| Hand rows | hand replay then `scripts/motion-quality-report.ts` | 2026-11-14 re-read with the time-fit quadratic jitter: table above; joint limits read null (no elbows in hand samples) and grade as a miss |
| Camera row | `bodycam:report` on the clip | aim 8.6° median, corrected knuckle ray (2026-11-14, Decision 4); body pending |
| AR rows | existing AR checks with body sampling | pending |

## Physical-device limits

Pending until the user is back from travelling: room-scale walking on a Quest
(feet and knees), hands and controllers on a Quest, Quest passthrough AR, and
phone AR and camera driving on the user's iPhone. Emulation results above are
not physical claims.
