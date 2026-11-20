# Feature brief: the recorded walk in real VR

**Lead:** Claude (Opus), session `local_…` started by the avatar-motion audit
**Status:** Delivered 2026-11-20 with the deviations listed under "Deviations" (approved by the owner, 2026-11-20: decision 3 = A, decision 4 = B); the Quest check is open
**Layer:** event (how the recorded body moves; see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

The owner walks in real VR (controllers, hand tracking, or headset AR), with
the thumbstick or by walking around the room. The avatar's legs walk like the
desktop walk: the same recorded stride, knee swing and footfalls, with planted
feet that do not slide. Today, desktop plays the recorded CMU walk, and real VR
uses a procedural stepper (`VrBodySolver`), so VR walking looks "weird" next to
desktop.

## Scope

**Included:**

- Real VR (`frame.bodyTracking`): every walking step of `VrBodySolver` takes
  its timing and shape from the recorded desktop walk (CMU 07_12, the same
  clip, hips bob and measured gait). The solver keeps where each foot lands,
  the tracked head, the pelvis and spine, the short steps that are not walk
  cycles, jumps and landings.
- One path for head and stick. The step clock and rate come from the body's
  real travel (the solver's own gait velocity), which the head (room scale)
  and the stick both move.
- Crouch-walk: the recorded steps under a lower pelvis.
- Terrain: the solver's own ground queries place the recorded steps.
- The ignored audit harness gets a room-scale head walk and a longer stick walk.

**Excluded:**

- The 1.8 m/s walk speed (unchanged), run and sprint.
- The arms (`ArmIkSolver`, `HandEmbodiment`): a parallel session audits them.
- Mock VR (`?mockVr=1`): it stays on the `vr-lower-body` clip profile in this
  slice. It is not real VR, and its legs do not use the solver. Follow-up item
  in `TODOS.md`.
- Desktop: no change to its walk or its rate rule.
- Directional (strafe, backward) and crouch mocap clips: still deferred in
  `realistic-avatar-motion.md`. See decision 4.
- New mocap sources (they stay out of git in all cases).
- Physical Quest validation (the owner does it; see the limits below).

## Undo

None. The change is in how the live body is posed. It adds no authoring action.
Recorded takes carry the posed bones as before, so the GLTF export, upload and
render path and the API do not change.

## Design decision

### The approach: the recorded walk shapes the solver's own walk

This is the approved hybrid (the recorded walk drives steady travel, the solver
keeps the rest), in the form the design review recommended. There is no second
gait and so no handover between two gaits. The solver's gait state
(`gaitActive`, on at 0.25 m/s, off at 0.15 m/s) stays the only walk state, and
its step planner (`stepTargetFor`: the lateral gap, the stride limit, the
landing re-aim, the stranded-foot rule of B-041, the ground at the landing)
still decides where each foot lands. What changes is the step itself. Today
the solver walks on hand-made curves: a cadence formula (`1.6 + 0.5 × speed`
steps/s), a swing of 85% of a step, a set swing curve and lift, and a flat
foot. These are replaced by the recording:

| Today (procedural) | Now (from the recorded walk) |
|---|---|
| Cadence `1.6 + 0.5 v`, swing 85% of a step | A gait clock: each foot lifts and lands at the clip's measured lift and land phases, at the clip rate |
| `swingProgress`, `swingHeight` curves | The clip's swing: fore-aft progress from lift to landing, and the sole's height, per phase |
| Flat foot (a roll only when the ankle is out of reach) | The clip's foot pitch (heel strike, push-off) and toe bend, in swing and in stance |
| No hips bob | The clip's hips height per phase (decision 3) |

The other steps (turn on the spot, settle, lean, shuffle, urgent catch-up)
keep the procedural shape. They are not walk cycles.

Alternative rejected: a separate clip gait that takes over for steady travel
(the first draft of this brief). It lays each swing around the hips, so it
skips the planner's clamps; it needs entry-phase matching, a stop rule and
thresholds, and each of those is a new seam. The review also showed that the
desktop route (play the clip, then `TerrainLegSolver`) would put two owners on
the leg bones in one step.

### The recorded walk as a table

When the animator attaches the walk clip, it already plays the bobbed clip by
forward kinematics to measure its gait (`LocomotionAnimator.measureGait`, the
second call). It will also keep, at each of its 96 samples and per leg:

- the swing's fore-aft progress, measured in the world as the clip would move
  at its stance speed (the ankle's offset along the stride axis plus the
  travel since lift-off), normalised from lift-off (0) to landing (1);
- the sole's height above the rest sole;
- the foot's pitch about its own right axis, and the toe bend;
- the hips height above the rest sole.

All of it is relative to the ground-projected root in the root's own frame
(not the swaying clip hips), in root units, scaled at use as `stanceSpeed` is.
A new accessor `getWalkTrajectory()` returns it for any profile (today the
gait is hidden outside `desktop-full`). `BodyPoseSystem` hands it to the
solver when the avatar attaches; an avatar swap or `solver.reset()` takes the
new one. Without a table (no humanoid, no walk clip) the solver walks as
today.

### 1. Clock and rate from the body's travel

- The gait clock advances by `rate / cycle` each second, where the travel speed
  `v` is the solver's own gait velocity (`targetVelocity` while the head
  translates, `rootVelocity` otherwise), eased at 12/s as on desktop. The
  stick input is never read.
- `s` is the clip's stance speed (about 1.7 m/s at 1.8 m avatar height). At
  and above `s` the rate is `v / s`, the desktop rule, so a 1.8 m/s stick walk
  has the desktop cadence. Below `s` the rate is `(v / s)^0.5`. Step length
  and cadence each rise with about the square root of speed in human walking.
  This exponent is that rule of thumb, not fitted to data here. Examples:
  1.2 m/s about 102 steps/min, 0.7 m/s about 78. The rate is clamped at the
  desktop's `WALK_TIME_SCALE_MAX`.
- Desktop only walks at 1.8 m/s (the keyboard has no slow walk), so this
  matches desktop where both can walk. Sharing one rule with desktop is a
  follow-up.
- The planner leads each landing by `velocity × lead`, as today, so the stride
  is what the travel asks for. The stance foot is pinned, so a rate that does
  not match the travel shows as a slightly long or short step, never a sliding
  foot. The swing height and the foot pitch are not scaled with the stride.
- Urgent steps (a foot left behind, a strained foot) still start at once, out
  of the clock, as today. The next step after one waits for the clock.

### 2. The seams

There is no clip-to-solver handover. The seams that stay are the existing ones,
now with recorded steps on the walking side:

- **Walk start.** The gait turns on. The clock starts at the lift-off phase of
  the foot the planner picks (the one furthest behind, as today), so the first
  step lifts at once. The first two steps from standing keep their quicker
  start (the existing `starting` factor).
- **Walk stop.** The gait turns off. A foot in its swing finishes the swing on
  the clock and lands where the planner aims it; then the standing logic does
  any settle step, as today.
- **Gait step ↔ static step** (turn into walk, a shuffle that becomes a walk):
  a static step finishes on its own curve; the next gait step starts on the
  clock.

The audit measures each of these on the stick and head walks: the worst joint
acceleration in the 0.4 s after the change, the largest one-frame foot jump
beyond the recorded swing, and skate across the change.

### 3. Head, pelvis and crouch

- The tracked head stays the authority for the head's rotation and for where
  the body goes. The pelvis today stands at the bind height less the knee
  flex, capped by the head's reach.
- The desktop walk bobs the hips by about 10 cm top to bottom (measured,
  baseline below). A walking person's head bobs too, so on a **head walk** the
  user's real bob already moves the head and the pelvis follows it: no clip
  bob is added there.
- On a **stick walk** the real head does not bob. With no bob the stance knee
  bends at mid-stance and straightens at the ends, the reverse of a real walk.
  **For the owner (decision 3):** on a stick walk, may the avatar's head bob
  below the tracked head with the recorded bob, as the desktop avatar's does?
  - (A, recommended) yes: the pelvis takes the clip's hips height in a stick
    walk, so the avatar's head bobs up to the measured amplitude below the
    tracked head (the camera does not move). Head-error budget in a stick
    walk: the measured bob amplitude.
  - (B) no: the head stays exact; the stance knee reads bent at mid-stance.
- Stick or head is measured, not guessed: the clip bob's weight is the share
  of the root's travel that does not come from the head moving in its
  reference space (stick and snap moves move the rig; a room-scale walk moves
  the head), eased.
- Crouch-walk: a lower pelvis bends the knees more over the same recorded
  steps. The planner's stride limit and the planted-reach share
  (`PELVIS_REACH_SHARE`) shorten the stride when the legs cannot reach; the
  swing height stays. A head drop above 6 cm releases `translating`, so a
  crouched walk uses the root's velocity; the eased clock rate keeps that
  velocity's jerks out of the cadence.

### 4. Sideways and backward

Desktop has only the forward walk and turns that stride toward travel
(`TerrainLegSolver.remap`). In VR people strafe with the stick while looking
forward far more often, and the turned forward stride crosses the feet in a
pure strafe (a 0.42 m half-stride across a 0.1 m half-stance). **For the owner
(decision 4):**

- (B, recommended) the recorded step shape only when the travel is within 45°
  of the body's facing; sideways and backward gait steps keep today's
  procedural shape, until directional clips exist. The planner still keeps the
  feet apart in every direction.
- (A) the recorded shape in every direction, like desktop, with the planner's
  lateral-gap clamp keeping the feet apart.

### 5. Terrain

The landing ground is the planner's (`footGroundAt` at the aimed landing:
heel and ball, so a foot across a slope change does not sink or float). The
swing's height is the line from the lift-off ground to the landing ground plus
the recorded clearance, never below the ground under the foot. Nothing changes
in `TerrainLegSolver`, which stays desktop-only.

## Acceptance criteria

Measured with the ignored audit harness (`apps/capture/output/motion-audit`),
frozen 30 Hz clock, 1.8 m avatar, on the body-floor scene; desktop numbers are
the reference run in the same harness.

- [ ] Stick walk (1.8 m/s, VR and headset AR) — partial: cadence 133.3 (desktop
      128.6, 4%), knee swing 71.1° (desktop 79.0°, 8°), mid-stance 39.8°; stance
      share 0.55 / 0.52 against 0.46 fails the 0.05 limit (see Deviations).: cadence within 10% of desktop,
      knee swing flex within 10° of desktop, stance share within 0.05 of
      desktop, mid-stance knee flex in the desktop range; `judgeGait` passes
      on the legs (the arm rows belong to the arm session).
- [ ] Room-scale head walk — partial: cadence 105.9, knee swing 76.6°, stance
      0.50 / 0.50; mid-stance knee 42.2° is 2° over the `judgeGait` limit (the
      baseline also failed, at 40.8°).
      Room-scale head walk (1.2 m/s with bob): cadence 92–115 steps/min, knee
      swing flex ≥ 60°, stance share 0.40–0.52 on each foot; the leg rows of
      `judgeGait` pass.
- [x] Foot pitch (left −41..3° against desktop −39..0°): the heel-strike and push-off pitch on the stick walk within
      10° of desktop.
- [x] No skate regression (stick 1.46 cm / 5.6%, head 2.29 cm / 2.9%,
      stick-more 2.02 cm): skate max ≤ 3 cm and share ≤ 10% on the stick and
      head walks, including the slow stick walk and the stops.
- [ ] The seams — partial: walk stop, turn-walk stop and walk → turn-walk are
      lower; walk start (stick 91 against 76, head 66 against 35), back → stop
      (109 against 80) and crouch → crouch-walk (91 against 39) are higher, all
      below the steady-walk p95 (stick 105, head 64 for the head start). Worst
      one-frame foot jerk in the walk: stick 14.9 cm (17.9 before), head 9.0 cm
      (10.8). The seams: each transition peak (walk start, walk stop, turn into walk,
      a walk with a smooth stick turn) ≤ its baseline value; no one-frame foot
      jump > 2 cm beyond the recorded swing, on flat ground and on the terrain
      check.
- [x] Pops p99 (stick 61.5 → 54.4, head 34.9 → 31.9, house 62.3 → 55.8) and penetration not worse than the baseline on every VR path.
- [x] Turn on the spot, lean and shuffle (also side, back and strafe; only
      walk, slow, turn-walk and crouch-walk steps are recorded-shape) keep the procedural steps (the audit
      records which steps were recorded-shape).
- [x] Head error (head walk p95 4.4 → 3.7 cm; stick 6.0 cm, inside the 6.5 cm bob): unchanged on the head walk; within the bob budget on the
      stick walk if decision 3 is A, unchanged if B.
- [x] Crouch-walk (head path and stick-more path: penetration 0, recorded steps 3 of 4 and 5 of 5): penetration 0, skate within the targets above.
- [ ] A second avatar — partial: cadence 150 (desktop 150), stance 0.54 / 0.53
      (desktop 0.51 / 0.52), mid-stance 34.7°, skate 0.93 cm; knee swing 54.4°
      is 16° under its desktop 70.0°. A second avatar (the house avatar's proportions) passes the stick-walk
      gait rows.
- [x] The XR checks pass: body, locomotion, loco-states, mock-vr, terrain,
      hands, held-states, desktop-motion; `pnpm run verify:pr` passes.
- [x] A proof video (H.264 MP4, ignored `output/`): the desktop walk, the VR
      stick walk and the VR head walk side by side, in real time.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A swing skims a rising floor (the clip's toe clearance dips at mid-swing; the ball is higher than the heel on an upslope) | The swing floor is the ground under the heel and under the ball plus `SWING_MIN_CLEARANCE`; the `iwer-walk-ramp` body replay (it failed with 22 cm drift before the fix) |
| Recorded mode turns back on while a recorded foot is in the air (a diagonal mid-swing) | The clock does not jump to the next lift while a recorded swing is in flight, or that foot lands in one frame (code review) |
| Toes held at bind on the procedural swings | Only a recorded swing holds the toes at bind; the procedural swings keep today's toe bend (verifier) |
| Recorded swing skips the planner's clamps (feet cross, over-long stride) | The planner still picks every landing; only the shape and timing change |
| Clip swing longer than a step period (two feet in the air) | The clock lifts each foot at its recorded phase; overlap is allowed only as far as the clip has it; stance share in the audit |
| Planted foot slides on slow head walks with stops | Stance pinned at the contact point; skate on the slow stick and head walk |
| Foot pitch slides a pinned ankle | Stance pins the contact point (heel, then ball) through the roll pivot, not the ankle |
| Lateral wobble from the clip hips' sway | The table is measured from the ground-projected root, not the hips |
| Double bob on a head walk | Clip bob weighted by the stick's share of travel |
| Pelvis passes push a bob back to the head | The bob is applied with the head-reach cap, after the passes, inside the head-error budget |
| Stance knee buckles on a head walk (head bob out of phase) | No clip bob on head travel; mid-stance knee flex on the head walk |
| Stop mid-swing lunges | The planner aims the landing with the decaying velocity, as today |
| Snap turn or curving walk sweeps a foot | No turn gate; the planner re-aims at its speed limit; audit row for a turning walk |
| Avatar without a measured walk | No table: today's procedural walk |
| Avatar rescale (height fit) | The table is in root units, scaled at use |
| Avatar swap or reset | The table is handed over on attach; `reset()` clears the clock |
| A jump mid-walk | The existing airborne path, unchanged |
| Conflict with `default-house-avatar` (small edits in the same three files) | Keep away from those lines; rebase before the merge |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead and implementer | This session | `apps/capture/src/body/VrBodySolver.ts`, `apps/capture/src/animation/LocomotionAnimator.ts` (the table), `apps/capture/src/systems/BodyPoseSystem.ts` (hands it over), this brief |
| Design reviewer | `design-reviewer` subagent (Opus), done 2026-11-20 | Read-only |
| Independent verifier | Codex `-p standard` if it has quota, else the `verifier` subagent and `/code-review high` | Read-only; test artifacts only |

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Gait, skate, seam, pops | `output/motion-audit/rebuild-audit.sh <tag> desktop-third vr-stick ar-stick vr-head mock-vr` | `output/motion-audit/<tag>/*-report.json`; before → after in this table |
| Checks | `DEV_PORT=5181 node --import tsx scripts/run-xr-checks.ts desktop-motion body hands locomotion loco-states mock-vr terrain held-states` | all pass, again after the review fixes |
| Recorded walk in use | the body replay fails a walk fixture with 0 recorded steps (`scripts/ci-body-replay-playwright.ts`) | `iwer-walk-forward-back-side`, `iwer-walk-ramp` |
| Pre-merge | `pnpm run verify:pr` | passed (1787 s) |
| Looks right | proof video in ignored `output/` | desktop, VR stick and VR head side by side; sent to the owner |
| Independent review | `verifier` and code-review subagents (Opus) on the diff | no blocker; two fixes below; the audit reports did not change |

### Baseline (before), 2026-11-20

Gait on the first walk phase, after its first second. Head walk: 1.2 m/s
with a 2 cm bob; the stick walk is 1.8 m/s. `headset AR` reads the same as VR
on the stick (same solver).

| Path | Cadence (steps/min) | Knee swing flex | Knee mid-stance | Stance share L / R | Skate max / share | Pops p99 |
|---|---|---|---|---|---|---|
| Desktop (reference) | 128.6 | 79.0° | 39.6° | 0.46 / 0.46 | 0.85 cm / 5.8% | 61.9 |
| VR stick | 144.0 | 59.9° | 43.8° | 0.53 / 0.58 | 1.11 cm / 6.3% | 61.5 |
| VR head walk | 133.3 | 54.7° | 40.8° | 0.47 / 0.61 | 1.59 cm / 2.7% | 34.9 |

Transition peaks (m/s², worst joint in the 0.4 s after the change). VR stick:
walk start 76, walk stop 18, strafe-right stop 165. VR head: walk start 35,
walk stop 64, turn into walk 26, turn-walk stop 42, crouch-walk start 33.

So the VR walk steps too fast (most at the head walk's 1.2 m/s, where people
take about 105 steps/min), swings the knee about 20° less, and stands longer
on the right foot.

### After (2026-11-20)

| Path | Cadence (steps/min) | Knee swing flex | Knee mid-stance | Stance share L / R | Skate max / share | Pops p99 |
|---|---|---|---|---|---|---|
| Desktop (reference) | 128.6 | 79.0° | 39.6° | 0.46 / 0.46 | 0.85 cm / 5.8% | 61.9 |
| VR stick | 133.3 | 71.1° | 39.8° | 0.55 / 0.52 | 1.46 cm / 5.6% | 54.4 |
| VR head walk | 105.9 | 76.6° | 42.2° | 0.50 / 0.50 | 2.29 cm / 2.9% | 31.9 |
| House avatar, desktop | 150.0 | 70.0° | 33.6° | 0.51 / 0.52 | | |
| House avatar, VR stick | 150.0 (156.5) | 54.4° (62.1°) | 34.7° | 0.54 / 0.53 | 0.93 cm (1.57) | 55.8 (62.3) |

Every walk, slow-walk, turn-walk and crouch-walk step is recorded-shape (stick
9 of 9, head 7 of 7). Desktop, touch and mock-vr read the same as the baseline.

### Deviations

- Stance share on the stick walk is 0.55 / 0.52 against the desktop 0.46. The
  toe pivots at push-off for longer than on desktop; the clip has only 0.01
  phase of double support.
- Walk start, back → stop and crouch → crouch-walk peaks are above the
  baseline (they stay below the steady-walk p95).
- The house avatar swings the knee 16° less than its desktop walk.
- The turn-walk knee is 48° (62° before); one stride only in the window.
- The head-walk mid-stance knee is 42.2° (limit 40; baseline 40.8°).
- The crouch-walk gait is not measured: the window holds no full stride.
- The table holds the clip's foot pitch but not its toe bend. The toes bend
  from the ground contact (heel up at the ball) in stance and stay at bind in
  a recorded swing; the procedural swings keep today's toes.
- The walk stops on a frame with both feet down. The clip has little double
  support, so the stop could miss that frame; on the audit stops the clock
  lifts no foot in place (0 recorded steps in every stop phase).

These go to `TODOS.md` as one follow-up.

## Physical-device limits

IWER proves the emulated head and stick paths. It does not prove how a real
head walk feels: real head bob, stop-and-go, and turning while walking on a
Quest. The owner checks a room-scale walk and a stick walk on the headset
after the merge.
