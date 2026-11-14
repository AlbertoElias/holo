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
| Float p95 · penetration | Sole height above its rest height while still in contact · deepest sole below it. Rest height comes from the take's first 0.5 s (every in-app check starts standing), so a take that floats throughout still reads as floating |
| Pops p99 | p99 joint acceleration over a ±50 ms stencil, every joint and frame: pin and release snaps and solver flips, with or without input |
| Joint limits | Share of frames with a knee bent backwards (against both the hips' and that foot's forward), an elbow bent the wrong way, a knee or elbow folded tighter than 25°/30°, or the spine twisted > 45° |
| Jitter p95 | The camera spike's definition: p95 deviation from the joint's own centred 1 s moving mean, inside held-still windows (≥ 1 s, trimmed 0.3 s each end); rays the same, in degrees |
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
| Desktop keyboard (walk, strafe, back, crouch-walk, flat floor) | **8.6 cm / 16%** · 0.3 · **5.3 cm** | **116** | 0% | 0.7 mm | n/a | **worst** |
| Camera (spike, `bodycam:report`) | unmeasured | unmeasured | unmeasured | ray **5.7–20°** (best variant 2.6°) | aim median **26/41/46°** (rough marks), head yaw p95 8.2° | bad |
| VR body, walk ramp | **4.1 cm** / 3.8% · 1.0 · **1.2 cm** | **43** | 0% | 2.7 mm | — | miss |
| VR body, walk | 2.9 cm / 3.8% · 1.1 · 0.3 | **37** | 0% | 1.6 (1.3) mm | — | near |
| VR body, turn | 2.5 cm / 2.5% · 0.6 · 0.3 | 31 | 0% | 2.1 (2.7) mm | — | pass (jitter at input) |
| VR body, small steps and sway | 0.7 cm / 1.9% · 0.8 · 0.2 | 13 | 0% | 1.2 mm | — | pass |
| VR body, crouch and lean | 0.1 cm / 0% · 0.7 · 0.3 | 10 | 0% | 2.4 mm (input 0.6) | — | jitter miss |
| VR hands, real Quest 3 recording | — | — | 0% | 3.6 (3.4) mm | wrist p95 **3.0 cm**, lag 0, jerk 1.03 | miss |
| VR hands, IWER | — | — | 0% | 4.0 (4.0) mm | wrist 0.0 cm | input-bound |
| Quest passthrough AR | unmeasured (same body solver as VR; to confirm) | | | | | gap |
| Phone AR | unmeasured (avatar placed and driven from the phone; to confirm) | | | | | gap |

Jitter at or under the input floor is the tracker's, not the solver's; the
target there is "no worse than input".

## Ranked worst gaps (execution order)

1. **Desktop feet and pops.** Walking moves the root at 3.24 m/s while the
   clip's planted foot still slides 0.5–1 m/s, sinks 5 cm, and pops at 3× human.
   The most-watched path (every desktop and emulated take). Fix per design
   review 5–8: measure each clip's stance-foot speed by FK at load and set
   `timeScale = rootSpeed / clipSpeed`; handle strafe and backward walking
   (lower-body yaw toward travel, negative timeScale, or directional clips);
   pin planted feet in `TerrainLegSolver` (one writer per leg) from
   precomputed stance phases; knees always forward.
2. **Camera aim and jitter.** Fold in the camera spike (Decision 2): adopt the
   wrist→tip 0.25 s ray (2.6°), record a measured aim clip, and sample avatar
   bones in `bodycam:report` so the body rows above stop being unmeasured.
3. **VR room-scale feet and pops.** Ramp skate 4.1 cm and 1.2 cm
   penetration; walk and ramp pops 37–43 m/s²; crouch jitter 2.4 mm against a
   0.6 mm input (`VrBodySolver.ts`, `legIk.ts`).
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
- [ ] Desktop keyboard row meets target; guard strict in `desktop-motion`.
- [ ] Camera row has measured body and aim numbers and meets target, behind `?input=camera`.
- [ ] VR body walk/ramp/turn rows meet target; strict in the body replay.
- [ ] Real-headset wrist p95 ≤ 2 cm.
- [ ] Quest AR and phone AR rows measured; any miss fixed.
- [ ] Each gap closes with a before/after proof video sent to the user.

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
| Desktop row | `node --import tsx scripts/run-xr-checks.ts desktop-motion` | baseline above |
| Human anchor | x | CMU reads above |
| VR body rows | `pnpm --filter @holoim/capture run test:xr:body` then `scripts/motion-quality-report.ts` | baseline above |
| Hand rows | hand replay then `scripts/motion-quality-report.ts` | baseline above |
| Camera row | `bodycam:report` on the clip | pending |
| AR rows | existing AR checks with body sampling | pending |

## Physical-device limits

Pending until the user is back from travelling: room-scale walking on a Quest
(feet and knees), hands and controllers on a Quest, Quest passthrough AR, and
phone AR and camera driving on the user's iPhone. Emulation results above are
not physical claims.
