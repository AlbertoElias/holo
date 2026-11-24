# Feature brief: VR motion gaps (pelvis at landings, chest lean on far reaches)

**Lead:** Claude (Opus), side session of the avatar-motion lead
**Status:** Complete (2026-11-24); three values pending owner confirmation; the Quest check is open
**Layer:** event (how the recorded body moves; see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

In real VR the avatar's pelvis rises and falls smoothly in a walk. Before, it
dropped about 3 cm in two frames at each foot landing (B-087). When the owner
reaches past the arm's length, the chest leans toward the target, so the wrist
comes closer to the controller or the hand.

## Scope

**Included:**

- B-087: the pelvis reach drop in `VrBodySolver` and the recorded walk's hips
  bob, with a gate in the walk-direction check.
- T-18dd51: a limited chest lean toward a reach past the arm
  (`HandEmbodiment`), the clavicle metric in the chest's own frame, and the
  `ARM_REACH_ONLY` partial-run gates.
- T-3be7a9: a new reading of the stick and head gait; each deviation left
  open is recorded with its reason in `TODOS.md`.

**Excluded:** desktop and phone motion (no change), the arm model's elbow
swivel behind the back, and a new motion-audit harness.

## Undo

Revert the merge commit. No data, take format or export changes: the body
sample gets one more optional debug field (`solver.pelvisReachDrop`).

## Acceptance criteria

- [x] The hips' vertical acceleration in every walk phase stays at or under
      12 m/s² (new walk-direction gate). Before: head 14.0–20.0, stick
      16.3–27.2 m/s²; after: head 5.1–10.7, stick 5.3–9.3 m/s². The gate fails
      all 12 rows on the old solver and passes on the new one.
- [x] The stick-walk bob stays visible (3.3 cm range) and the desktop walk is
      unchanged (the bob table is read only by the VR solver).
- [x] Far reaches come closer: wrist p95 on forward-far, controller 12.4 →
      11.1 cm, hand 5.4 → 4.1 cm; overhead, controller 11.7 → 10.4 cm, hand
      4.7 → 3.3 cm. The Quest hand take reads 0.0–0.1 cm.
- [x] The lean adds no arms-check miss. The misses left (behind-the-back flips,
      the overall clavicle elevation range) are the same as on `main` before.
- [x] Desktop, phone and the other VR checks do not regress (see the test plan).

## Failure cases considered

| Case | Handling |
| --- | --- |
| A target that jumps (a lost and regained hand) snaps the chest | The lean eases (0.15 s); a lost hand adds no lean |
| The chest lean carries the head off the tracked head | The twist keeps the head on its axis; the bend is limited to 12°; the head bone keeps its world rotation |
| The lean builds up frame on frame | Each frame takes back last frame's lean before it measures (the body solver poses the chest from bind) |
| The spring overshoots the drop limits | The wanted drop is in 0..max, so the overshoot is small; only the floor (0) stops the speed, because a stop at max made a knee pop |
| The landing shock moves from the hips to the planted knee | A growing drop follows faster (30 rad/s); the body replay's pooled pops stay at or under 35 m/s² (walk-ramp 34.9, `main` 34.5) |
| A chest twist reads as clavicle push in the arms check | The clavicle is measured in the chest's frame (levelled clavicle joints, chest → neck) |
| The smoothed bob changes the desktop walk | Only `VrBodySolver` reads `walk.bob` |

## Ownership

One writer per transform: `HandEmbodiment` writes the chest (arm torso) bone
after `BodyPoseSystem` and before the arm solve; the body solver poses it
from bind again each frame.

## Design decision

All three values are the agent's choice, pending owner confirmation:

1. The chest lean limits: a twist of up to 25° about the torso's up axis and a
   bend of up to 12°. A larger bend moves the avatar's head farther from the
   tracked head; the remaining far-reach error is mostly a still head with a
   target past the arm.
2. The recorded hips bob, smoothed with a circular Gaussian of σ = 6 samples
   (about 6% of the cycle).
3. The pelvis reach drop on a critically damped spring in place of the 0.06 s
   ease: ω = 30 rad/s while the drop grows, 14 while it shrinks. Both margins
   are small (hips 10.7 against 12, knee pops 34.9 against 35): a landing
   moves the hips or bends the knee, and a slower spring gives the knee more.

## Test plan and evidence

| Check | Result |
| --- | --- |
| `walk-direction` (new hips gate) | pass |
| `arms` | the five misses that `main` has, no new one |
| `hands` (Quest hand take) | pass, wrist p95 0.0–0.1 cm |
| desktop-motion, body, locomotion, loco-states, mock-vr, terrain, held-states, avatars | see the merge report |
| `pnpm run verify:pr` | pass before merge |

Proof videos (ignored, copied to `apps/capture/output/child-proofs/`): the head
and stick walks (side and front) and the controller reach, before and after.

## Physical-device limits

Emulation only. The owner checks the walk and a far controller reach on a
Quest 3.

## Deviations

- T-3be7a9: no item closed. The motion-audit harness that measured these is
  gone. A 9 s forward walk read by `measureGait` (about 37 samples a second)
  gives the head-walk mid-stance knee 42.1° (the audit read 42.2°) and the
  stick stance share 0.62 / 0.54. Shorter push-off hold and lift ease values
  move the stance share by 0.01 only, so its cause is the lift timing, not the
  toe pivot. Each item stays open in `TODOS.md`.
- The behind-the-back swivel: hands 157°, controllers 80°. For a wrist at the
  back pocket, the controller pose (elbow back and out) is the more natural
  one. Both inputs still flip twice there. Open in `TODOS.md`.
