# Feature brief: realistic avatar motion (mocap clips + IK)

**Lead:** Claude (Opus), session local_86351c34 family, worktree `.worktrees/desktop-gait`
**Status:** Shipped (slice 1 and the follow-up fix 1b, 2026-11-18); physical Quest check pending with the owner
**Layer:** event (the recorded body)

## User outcome

Wherever the body is not directly tracked, the avatar moves like a person.
On desktop that means the whole body. In VR and Quest passthrough it means the
legs, pelvis and spine (hands and head are tracked, elbows are IK). It looks
natural on the shipped avatar and on every supported skeleton, and it costs
little enough per frame for WebXR on a Quest.

The owner's report (2026-11-18, desktop): "the arms have no natural movement
and the legs frequently get stuck in the terrain and it moves as if it has
injured legs." The owner chose (2026-11-18) **mocap clips + IK** over a fully
procedural gait.

## Root causes found

1. Every locomotion clip is hand-written keyframes from
   `apps/capture/scripts/inject-avatar-locomotion-clips.mjs`: a 1 s, 6-key walk
   that moves only the hips and legs. Arms, spine and head have no tracks, so
   on desktop they hold the rest pose. Measured on the default scene: wrist
   fore-aft travel 2 mm over a 5 s walk. `locomotion.glb` (the retarget library)
   copies the same clips, so every avatar inherits them.
2. The 6-key stride is stiff and the leg solver only stops it sliding, so the
   gait reads as a limp.
3. `TerrainLegSolver` lifts the toe against the ground height under the
   *ankle*. On an uphill slope the toe goes up to 20 cm into the terrain
   (36 of 330 walking frames more than 3 cm under).
4. The desktop motion check walks a flat floor and measures no arm swing,
   knee flexion or symmetry, so the grade passed all three defects.
5. Found while building the mocap loops: the `gbionics/cmu-fbx` conversion
   bakes a bent-knee rest pose and a crossed-leg rest turn into the legs, so
   its walk read as limping even after retargeting. The original ASF/AMC
   takes (straight rest legs) are used instead.
6. Found while grading: the foot-contact detector flickered at toe-off and
   counted half-steps (cadence 200), and the per-frame hips bob (a ±2-sample
   average) put 19 m/s² pops into hips and head against 8–9 in the source.
7. Found on terrain: every foot probe was a three.js raycast over the whole
   landscape, 1.8 ms per frame for the leg solver alone.

Reported by the owner after slice 1 ("the arms go through the body, it still
jitters"), fixed in 1b:

8. The mocap arms are the performer's, whose hips are narrower than most
   avatars': on the default avatar the hanging wrists sat 38% inside the hip
   surface. `ArmClearance` measures each avatar's hip and torso cross-section
   (an ellipse, from its skinned vertices, once per avatar) and opens the
   upper arm just enough that the wrist and elbow clear it, desktop only.
   It undoes its own opening when the clip did not rewrite the arm, so a held
   idle key never accumulates.
9. Walking into a rock flickered walk ↔ idle at about 5 Hz (hips ±4 cm): the
   motor reports the attempted speed while the body rattles back and forth.
   While a step has reversed in the last 0.3 s, the animator chooses the walk
   on the eased net travel speed instead, and it enters walk at 0.2 m/s and
   leaves it at 0.12 m/s. (Holding each switch for 0.1 s also stopped the
   flicker but slid the feet at every start and stop: the gate's held jitter
   went 0.43 → 4.2 mm.)
10. A held-back walk (sliding along a rock) played the clip at 15–20% speed
    with a full stride, so one leg hung stretched across the body for over a
    second. Once a walk has run 0.25 s below 60% of its intended speed, it
    keeps at least 55% of its cadence and shortens the stride instead, the
    way people walk when held back. A free walk keeps the clip's own rate:
    a floor there quickened the first and last steps (pops 44.9 → 46.3).
11. Strafing (A or D) played the forward walk with its stride laid sideways,
    so the legs scissored across each other (owner report, 2026-11-18). The
    desktop body now turns toward its travel, within about 0.1 s, and walks
    forward that way. Past 120° from the look (back, back-left, back-right)
    it faces the look and walks backward. Standing still, it turns back to
    the look within 0.25 s, the feet stepping round. First person and a
    reach keep the look's facing. This also ends the diagonal cross that
    10 left.
12. Standing over ground the leg could not reach (beside a rock), one foot
    re-stepped onto the same spot every 0.33 s for as long as the avatar
    stood (owner report: "the right leg doing weird movements"). An
    unreachable foot now steps only when the step would move it.
13. With 11, the terrain diagonal walked a foot into the side of a rock, its
    toe 26–31 cm inside the face. A foot whose toe would stand in a face
    taller than the toe can pitch over is drawn back off it, and a planted
    foot keeps the new spot. Under the ground 26.4 → 0.00 cm.
14. The arm clearance took a pointing arm for the clip's pose: the mixer
    skips a value that has not changed (the desktop idle holds its arm
    key), so the point's last write stood on the bone, was opened again,
    and the point then kept it as its rest. The arm stayed 0.67 m off after
    release (`pointing`, desktop take). The clearance now notes the arm as
    the last frame left it, before the animation runs, and starts from its
    own saved pose when nothing rewrote it.

## Scope

**Included (this slice):**
- Full-body Idle and Walk from real motion capture: the CMU Graphics Lab
  motion capture database (free for any use, raw data not resold), from the
  original ASF/AMC takes. Walk: subject 07 take 12, frames 8–35, one step
  mirrored onto the other leg so both legs walk the same step. Idle: 113_21,
  frames 165–315, its sway scaled to 0.4 and re-faced (the take stands ~100°
  off its walk heading). Loops are cut at left heel strikes, in place, seams
  closed. On desktop the Idle only holds the arms, still, at its first frame
  (down on any rest pose, so a T-pose avatar does not swing them down when it
  starts walking): its sway, torso and head lean moved the hand, shoulders and
  eyes the desktop reach, carry, set-down and aim are tuned from (holding the
  carry pose over it, or blending the arms or the whole upper body back to
  bind, still broke those checks). VR plays no idle: the legs stand at rest
  while the headset stands still.
- `scripts/mocap/amc-to-dump.ts` (ASF/AMC → JSON) and
  `scripts/build-mocap-clips.ts` (JSON → the shipped avatar's clips, then
  `build-locomotion-library.ts` rebuilds `locomotion.glb`). Sources and dumps
  stay out of git.
- `LocomotionAnimator`: the walk plays at 1.1× stride (the take was recorded
  faster than the desktop's 1.8 m/s, so on its own stride it read as ~130
  steps/min shuffling), and the hips bob is a Gaussian-smoothed (σ 40 ms)
  circular average.
- Terrain: `TerrainHeightIndex`, an XZ grid of the world's triangles for
  vertical ground queries (allocation-free, built lazily, rebuilt when the
  world moves; instanced meshes are indexed at every instance). The leg solver, the character's ground probe and object
  interaction use it; the toe is lifted against the ground under the toe.
- Grading: `scripts/lib/gait-metrics.ts` measures cadence, arm swing and its
  leg correlation, knee swing/mid-stance flexion, stance share and step
  asymmetry; the desktop motion check runs it on every avatar, adds a
  terrain row, and reads the per-frame pose cost in page
  (`__samplePoseCost`).

**Deferred to a follow-up slice** (recorded in `TODOS.md`): directional
(back/strafe) and crouch mocap clips with phase-synced blending; foot
pitch/roll to the terrain normal and heel sampling; pelvis drop to the lower
foot; the desktop Idle's upper-body sway (needs the desktop reach, carry,
set-down and prop placement retuned to read a moving hand and eye); the remaining knee-swing excess (walk p99 77° against the source's
57–66°); an allocation-free leg solver (slice 1 removed its per-probe raycasts,
but `TerrainLegSolver` still makes Vector3/Quaternion temporaries each frame).

**Excluded:** run/sprint; physical Quest validation (owner, in New York);
facial animation; the directed-performance cast (it imports these modules
unchanged and keeps working); phone AR (no avatar, by design).

## Undo

None: no authoring action is added; the change is how the avatar's body is
posed.

## Acceptance criteria

All on the shipped avatar and the 7 fixture skeletons, desktop keyboard, on
both the flat floor and the default terrain, at the brisk 1.8 m/s walk:

Targets are anchored on the CMU source walks (02_01, 07_01, 08_01, 07_12 at
1.3–2.2 m/s) measured with the same metrics, not on textbook slow-walk values:

- [ ] Arms swing in antiphase with the same-side leg (correlation ≤ −0.5),
      with the stride the gait targets in `gait-metrics.ts` set.
- [ ] Knees flex in swing (gait targets) and are never locked straight
      through stance (mid-stance flexion ≤ 40°).
- [ ] Gait: cadence 100–140 steps/min, stance share and step asymmetry within
      the gait targets; pops p99 ≤ 46 m/s² (CMU 08_01 at 1.86 m/s measures
      46.3) and held jitter p95 ≤ 3 mm (a real person standing, 113_21,
      measures 4.1).
- [ ] Terrain: on the default scene, toe and ankle never more than 1.5 cm
      below the ground straight under each of them, and planted feet within
      2 cm above it, while the body stands on the ground (frames falling off
      a ledge are counted, not judged: the leg solver lets the feet go).
- [ ] Existing motion-quality targets for desktop, VR body, hands, Quest AR
      and camera still pass (feet slide/float/sink, pops, eye error).
- [ ] Cost: animation + IK per avatar per frame ≤ 0.25 ms median on the
      desktop test machine (measured in-page), no per-frame allocation in the
      IK path. *Slice 1 meets the cost; the leg solver still allocates
      temporaries per frame (deferred to slice 2), while the ground query it
      calls is allocation-free.*
- [ ] Strafe, back and crouch keep their existing clips and still pass the
      foot-slide target (new clips deferred).
- [ ] Proof video: real-time desktop walk on terrain, before and after, and
      the VR emulator lower body.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Mocap loop pops at the seam | Cycle cut at matching heel strikes, ends cross-faded; the pop target runs on the loop |
| Root drift / heading drift in the mocap | Root translation removed in build, hips heading zeroed per cycle |
| Directional blend feet cross or slide | Phase-synced normalized time; foot slide and stance metrics on strafe/back |
| Retarget breaks on unusual rest poses (A/T, twisted, z-up, cm) | Existing retarget fixtures, now with arm tracks |
| Arm clip fights VR tracked hands / ArmIkSolver | VR profile masks arms; desktop only plays arms |
| Toe sinks on slopes, foot floats on downslope | Ground sampled under toe and heel, foot aligned to normal, pelvis drop |
| Directed-performance imports break | Same module names and exports; its checks run in verify:pr |
| CPU cost on Quest | Analytic IK, scratch vectors, measured per frame |
| Library size balloons | 30 fps, quantized; budget ≤ 400 KB |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead / implementer | Claude Opus (this session) | `apps/capture/src/animation/*`, `apps/capture/scripts/build-mocap-clips.ts`, `scripts/mocap/`, `public/gltf/animations/locomotion.glb`, `public/gltf/models/avatar.glb`, motion checks |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only |
| Independent verifier | `verifier` subagent (Opus) + `/code-review` | Read-only |

## Design decision

Mocap clips + analytic IK (owner, 2026-11-18). Rejected: a procedural gait
(robotic without heavy tuning); keeping the hand-made clips and adding
procedural arm swing (still a limp); the `gbionics/cmu-fbx` FBX conversion
(bent-knee rest pose); `three-mesh-bvh` for the ground queries (a new
dependency for what a 150-line vertical-only grid does).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Arms, knees, gait, terrain, cost | `node --import tsx scripts/run-xr-checks.ts desktop-motion` (from `apps/capture`) | `output/ci-desktop-motion/summary.json`: PASS on all 9 rows (2026-11-18). Shipped, flat floor: cadence 116 steps/min, arm swing 42.8 cm at correlation −0.955, knee swing 77.4°, mid-stance 38.8°, stance 0.45/0.45, asymmetry 0.065, pops 45.7 m/s², skate max 1.78 cm, jitter 0.59 mm. Terrain: deepest foot joint under the ground 0.00 cm (was 20 cm), planted float p95 0.81 cm. Pose cost median 0.1–0.2 ms, p95 0.2–0.3 ms on every row (0.2–0.5 ms median under CI emulation) (the terrain probes were 1.8 ms before the height index) |
| All sources still pass | `test:xr:avatars`, `test:xr:body`, `test:xr:hands`, `test:xr:ar-record`, `pnpm run verify:pr` | All pass (2026-11-18). In `verify:pr`, two pipeline specs timed out under load on shared ports and passed when rerun alone. The desktop and phone object checks outside `verify:pr` fail on `main` as well (B-069) |
| Looks right | proof video (ignored `output/`, not linked) | A 14 s desktop keyboard walk over the default terrain: arms hang and swing opposite the legs, knees bend through the stride, and the feet stay on the slopes |

## Physical-device limits

Emulator and desktop only. The owner checks a physical Quest in New York.
