# Feature brief: VR motion gaps (pelvis at landings, far reaches)

**Lead:** Claude (Opus), side session of the avatar-motion lead
**Status:** Complete (2026-11-27); two values pending owner confirmation; the Quest check is open
**Layer:** event (how the recorded body moves; see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

In real VR the avatar's pelvis rises and falls smoothly in a walk. Before, it
dropped about 3 cm in two frames at each foot landing (B-087). A chest lean
toward a reach past the arm was built and left out: see Deviations.

## Scope

**Included:**

- B-087: the pelvis reach drop in `VrBodySolver` and the recorded walk's hips
  bob, with a gate in the walk-direction check.
- T-18dd51: a limited chest lean toward a reach past the arm (tried, left
  out), the clavicle metric in the chest's own frame, and the
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
- [ ] Far reaches come closer. Not met: the lean that did it moved the
      avatar's eyes off the tracked head (see Deviations).
- [x] The arms check's misses are the five that `main` has (behind-the-back
      flips, the overall clavicle elevation range), no new one.
- [x] Desktop, phone and the other VR checks do not regress (see the test plan).

## Failure cases considered

| Case | Handling |
| --- | --- |
| The chest lean carries the eyes off the tracked head | Found by the hosted height check (3 cm, bar 2 mm); the lean is left out |
| The spring overshoots the drop limits | The wanted drop is in 0..max, so the overshoot is small; only the floor (0) stops the speed, because a stop at max made a knee pop |
| The landing shock moves from the hips to the planted knee | A growing drop follows faster (30 rad/s); the body replay's pooled pops stay at or under 35 m/s² (walk-ramp 34.9, `main` 34.5) |
| A chest turn reads as clavicle push or elevation in the arms check | The clavicle is measured in the chest's frame (levelled clavicle joints, chest → neck) |
| The smoothed bob changes the desktop walk | Only `VrBodySolver` reads `walk.bob` |

## Ownership

`VrBodySolver` alone writes the pelvis; no new writer.

## Design decision

Both values are the agent's choice, pending owner confirmation:

1. The recorded hips bob, smoothed with a circular Gaussian of σ = 6 samples
   (about 6% of the cycle).
2. The pelvis reach drop on a critically damped spring in place of the 0.06 s
   ease: ω = 30 rad/s while the drop grows, 14 while it shrinks. Both margins
   are small (hips 10.7 against 12, knee pops 34.9 against 35): a landing
   moves the hips or bends the knee, and a slower spring gives the knee more.

## Test plan and evidence

| Check | Result |
| --- | --- |
| `walk-direction` (new hips gate) | pass |
| `arms` | the five misses that `main` has, no new one |
| `hands` (Quest hand take) | pass |
| `height` | pass (failed on the hosted gate with the chest lean: eyes 3 cm off the head) |
| desktop-motion, body, locomotion, loco-states, mock-vr, terrain, held-states, avatars | see the merge report |
| `pnpm run verify:hosted` | pass before merge (local `verify:pr` timed out in viewer-api at load average 20–290) |

Proof videos (ignored, in `apps/capture/output/child-proofs/vr-motion-gaps/`):
the head and stick walks (side and front), before and after. The `after-reach`
video shows the chest lean that was left out.

## Physical-device limits

Emulation only. The owner checks the walk on a Quest 3.

## Deviations

- The chest lean (T-18dd51) is left out. Built in `HandEmbodiment` after the
  body solve (a twist of up to 25° and a bend of up to 12°), it brought the
  forward-far wrist closer (controller 12.4 → 11.1 cm, hand 5.4 → 4.1 cm), but
  the hosted gate showed its bend carried the avatar's eyes 3 cm off the
  tracked head (`height`, bar 2 mm) and changed a held prop's throw
  (`object.pipeline`). A twist about the chest → neck axis alone keeps the
  eyes but gains nothing (12.5 / 5.4 cm). A lean must come from the body
  solver, which bends the spine below the neck while the neck stays under the
  tracked head. Open in `TODOS.md`.

- T-3be7a9: no item closed. The motion-audit harness that measured these is
  gone. A 9 s forward walk read by `measureGait` (about 37 samples a second)
  gives the head-walk mid-stance knee 42.1° (the audit read 42.2°) and the
  stick stance share 0.62 / 0.54. Shorter push-off hold and lift ease values
  move the stance share by 0.01 only, so its cause is the lift timing, not the
  toe pivot. Each item stays open in `TODOS.md`.
- The behind-the-back swivel: hands 157°, controllers 80°. For a wrist at the
  back pocket, the controller pose (elbow back and out) is the more natural
  one. Both inputs still flip twice there. Open in `TODOS.md`.
