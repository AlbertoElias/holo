# Feature brief: natural VR arms from recorded motion

**Lead:** Claude Code session (Opus), started by the realistic-motion lead
**Status:** Implementing (design review: approved with changes, all applied)
**Layer:** event (the recorded body motion of a take; see
`docs/product/concepts/what-a-hologram-is.md`)

## User outcome

In VR, with tracked hands or controllers, the avatar's arms move like a
person's arms. A relaxed elbow hangs down and back. A reach bends the elbow
down and out. The shoulder shrugs and moves forward only as far as a human
shoulder can. The avatar's hand stays on the controller on a full reach, and
the arm does not visibly stretch. The recorded take keeps these arms, so a
viewer sees the same natural arms in the hologram.

This closes B-073 (the elbows point out or up), B-074 (the shoulders swing
past a human range) and B-075 (the controllers miss long reaches).

## Scope

**Included:**

- The VR arm solve in `HandEmbodiment` (tracked hands and controllers), in VR
  and AR sessions.
- An elbow direction from recorded human motion (CMU mocap), as a function of
  the wrist position and the palm direction in the torso frame.
- A clavicle (shoulder) pose from recorded human motion and a bounded
  shrug, with a hard limit in a human range.
- One arm length per avatar, fitted to the recorded human ratio of arm length
  to shoulder height (a no-op on avatars with human proportions, such as the
  house avatar). It applies to both input sources in VR and stays through a
  tracking loss. Out of VR the arm is at its bind length.
- A full-reach shoulder push: near full reach the clavicle turns toward the
  target, inside the same 30° limit.
- A committed fit script that reads the mocap dumps and writes the committed
  coefficients. The mocap files stay in the ignored `output/`.
- Gates in the arms check (`test:xr:arms`) for these numbers, and an arm
  measurement (`measureArms`) in the `hands` replay for the Quest take.
- The camera tracker body (`updateCameraBody`) keeps its old arm solve.

**Excluded:**

- The legs and the body solve in `VrBodySolver`.
- The desktop arms (`DesktopPointAction`, `DesktopCarryPose`). They also use
  `ArmIkSolver`; all new behaviour is opt-in through solve options that only
  `HandEmbodiment` passes.
- The forearm twist share (0.5) and the shoulder reset before each solve
  (both from the earlier audit, commit 55f4215).
- The fingers, and the wrist rotation from the tracked hand.
- B-069 (desktop and phone object rows fail on `main`).

## Undo

None. The change alters how the avatar's arms follow the user's real hands. It
adds no authoring action, so nothing joins the capture history.

## Acceptance criteria

The numbers come from `test:xr:arms` (IWER, deterministic; VR and AR give the
same numbers) and the `hands` replay of the real Quest 3 take. "Before" is
`main` at 55f4215.

- [ ] B-073: elbow swivel (0° down, 90° out, ±180° up) is in the human band at
      rest and while walking: median 0°–70° on rest, walk and stand (before
      141°, 138°, 131° on hands). The low side reach has the elbow down (median
      between −90° and 90°; before −175°). The Quest take swivel median is in
      0°–70° (before 92°).
- [ ] B-073: no elbow flips. A flip is a swivel jump over 25° in one 30 Hz
      frame (`arm-quality.ts`); the swivel is not measured at an elbow angle of
      165° or more, where the bend plane is not visible. Flips per minute are
      0.5 or less on the arms check (before 1.0/min) and not above the before
      value on the Quest take.
- [ ] B-074: the clavicle elevation and protraction ranges are 30° or less on
      every segment of the arms check and on the Quest take (before up to 83°).
      Over a whole run the protraction range (retraction to protraction) is 45°
      or less. The largest clavicle step is 8° per frame or less (before about
      21°); the clavicle turns at 150°/s or less.
- [ ] B-075: the forward rows have a wrist p95 of 1.5 cm or less on both
      sources. The forward-far and overhead targets of the arms check lie past
      the avatar's full reach (hand 1.10 × the arm length from the pushed
      shoulder, controller about 1.2 ×), so the arm cannot reach them without
      a visible stretch. Their bars stop a regression: hands 6.5 cm, controllers
      13 cm (before 14.8 cm and 14.5 cm on controllers).
- [ ] No visible stretch: the arm length change over a run
      (`armLengthSpreadPct`) is 2.5% or less on both sources. The dynamic
      reserve is 1.8% (under the 2% collider rebuild threshold of
      `AvatarColliders`); the hands' 8% stretch goes away.
- [ ] The Quest take: wrist p95 1.0 cm or less, arm length spread 2.5% or
      less. Before, the wrist p95 was 0.2 cm only because the arm stretched
      7.9% (over the hip spacing; up to 19% in world size). The user reaches
      1%–3% past the fitted arm several times and 13% at the end of the take;
      without a stretch the wrist stops up to about 1 cm short on the small
      overreaches.
- [ ] Out of VR the arm bones are back at their bind lengths, and the desktop
      arms give the same results as before (`desktop-reach-interruptions`,
      the desktop point and carry checks).
- [ ] No regressions in the body, object (B-069 rows excluded), avatars
      (no-fingers first) and hands checks, and the IWER resize take keeps more
      than 20 compared keys.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| The elbow model gives a direction near the shoulder–wrist line (straight arm, or a pole parallel to the axis), so the bend plane flips. | A small fixed prior (down, back, a little out) is added to the fitted pole before it is rejected off the axis, so the pole is defined everywhere and has no state; last fallbacks: out of the body, then back. Flips/min gate on the arms check and the Quest take. |
| The model is used outside its data (a wrist behind the back, above the head, a far target). | Clamp the normalised wrist position to the sample range before the features; ridge fit; the arms check has behind, overhead and forward-far rows. |
| The palm direction is wrong for controllers (no tracked palm). | The palm frame comes from the solved hand bone (target × grip offset × `palmInHand`), the same for both sources; the controller rows of the arms check measure it. |
| The torso frame is wrong when the avatar root and the chest turn differently (walk, crouch, lean). | The torso frame is the clavicle's parent bone at runtime, relative to its bind pose in the avatar root; walk, crouch and stand rows. |
| The clavicle steps when a target crosses a threshold. | The clavicle angles are smooth functions of the wrist position (no band) with a soft limit (tanh from 22° to 30°); a rate limit of 150°/s from the frame's delta time; clavStep gate. `p` comes from the bind shoulder, so the clavicle pose does not feed back into its own input. |
| A longer arm breaks physics, objects or the collider shapes. | Colliders follow the bones (`AvatarColliders`); the object, avatars (no-fingers first, physics is chaotic) and body checks run after the change. |
| The longer arm changes a recorded take's keys (the IWER resize take once fell to 187 keys from 332 with a controller stretch). | The fit is a constant ratio per chain applied in the solve (the cached lengths do not change); the resize take and `desktop-reach-interruptions` run after the change. |
| The arm stays long after VR ends, so desktop arms change. | The desktop chains share the bones: `restArmLengths` runs out of VR before the desktop point update, and the AR camera author returns early; the desktop checks run after the change. |
| A longer arm churns the collider rebuild. | The dynamic reserve is 1.8%, under the 2% rebuild threshold; the fit is constant while a chain is solved. |
| The height fit (uniform avatar scale) changes the arm-length ratio. | The fit ratio is from bind proportions; uniform scale keeps the ratio. `rescale(ratio)` keeps scaling the cached lengths. |
| A rig with no clavicle bone. | `hasClavicle` is false: the torso frame is the shoulder bone itself and the clavicle model is skipped (no chest rotation). |
| The export or the viewer loses the longer arm. | The export records bone positions; the avatars check renders the exported take. |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | this session | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer | this session | `apps/capture/src/ik/ArmIkSolver.ts`, `apps/capture/src/ik/armPoseModel.ts` (new), `apps/capture/src/xr/HandEmbodiment.ts`, `apps/capture/src/avatar/AvatarRig.ts` (chain fields only), `apps/capture/scripts/mocap/fit-arm-pose.ts` (new), `apps/capture/scripts/ci-arm-reach-playwright.ts`, `apps/capture/scripts/lib/arm-quality.ts` |
| Independent verifier | `verifier` subagent (Opus) and `/code-review high` | Read-only verification; test artifacts only |

## Design decision

### Data

The fit uses 29 CMU mocap takes (free for any use): 18 reach and gesture takes
downloaded for this work (13_07, 13_20, 13_27, 14_20, 15_06, 15_07, 15_11,
18_08, 19_08, 42_01, 62_11, 79_06, 79_23, 79_28, 79_79, 79_82, 80_50, 86_12)
and the 11 dumps the motion work already used. `scripts/mocap/amc-to-dump.ts`
converts them. They give 32,114 arm samples. The files stay in the ignored
`output/mocap-reach`; only the fitted coefficients are committed.

In the recorded motion the elbow swivel is about 25°–45° in nearly every reach
direction. The avatar today has 86° median error to the recorded elbow
direction.

### B-073: elbow direction from recorded motion

The elbow pole (the direction the elbow bends toward) is a ridge regression in
the torso frame (x out of the body, mirrored per side; y up; z forward):

- inputs: `p` = (wrist − shoulder) / arm length, and the palm's across
  direction (pinky to index);
- features: 1, p, the quadratic terms of p, and the across vector (13 terms);
- output: a pole vector, rejected off the shoulder–wrist line and normalised.

Leave-one-take-out error to the recorded elbow direction (median, p90):

| Model | Median | p90 |
|---|---|---|
| Today's fixed hint | 86.3° | 127° |
| Linear in p | 12.1° | — |
| Quadratic in p | 11.2° | — |
| Quadratic in p + palm across (chosen) | 10.0° | 31° |

The palm term helps because a turned palm turns the elbow (a palm-down reach
lifts the elbow out; a palm-up reach tucks it in). The model is smooth in its
inputs, so it does not step. A constant better hint (alternative A) would fix
rest but not reaches; a hand-tuned rule (alternative B) is what the owner does
not want.

### B-074: the clavicle in a human range

Today the clavicle aims at the target near full reach and slerps up to 90%–100%
of the way. This gives swings of 68°–103° and steps of 21°.

The new clavicle pose is two angles about the torso axes, added to the bind
pose:

- protraction (forward and back, about the torso up axis): the quadratic fit
  in `p` from the same data (R² 0.27 held out; across +18°, behind −9.5°,
  forward full reach +4°, ear −9.6°);
- elevation (the shrug, about the torso forward axis): the CMU clavicle
  elevation is not predictable from the wrist (R² about 0, and the CMU
  clavicle is weak), so it follows the published shoulder rhythm: about 0.3°
  of clavicle per degree of arm elevation above 30°, smooth, up to 25°.

The combined clavicle angle has a hard limit of 30° from bind, and a per-frame
change limit. The recorded deviation from a hanging arm is ±21°–24° (p1..p99),
so 30° covers the human range with margin.

### B-075: a full-reach shoulder push and a fitted arm length, not a stretch

The draft said the house avatar's arm is short for its height (0.371 of the
shoulder height). Measured on the IK bones at runtime it is 0.412 (arm 0.565 m,
shoulder 1.37 m above the toes), a little above the CMU median of 0.406
(12 subjects, 0.381–0.422). So the long-reach gap does not come from a short
arm. It comes from targets that lie past the arm's full reach: on the arms
check, the hand target is 1.10 × the arm length from the shoulder on the
forward-far row, and the controller target about 1.2 ×. Before, the clavicle
swung 70°+ to cover that distance (B-074), and the hands stretched 8%.

Options:

1. A dynamic stretch on both sources (the hands had 8%): it broke the IWER
   resize take and `desktop-reach-interruptions` on controllers, and it is a
   visible stretch.
2. A torso lean toward a far target: this is what a person does, but the
   chest belongs to `VrBodySolver`, outside this scope (follow-up).
3. A shoulder push near full reach plus a fitted arm length (chosen).

The shoulder push: from 92% of the arm length the clavicle turns toward the
target, smoothly, up to the 30° limit at 112%. The forward part of the
direction adds protraction and the upward part adds elevation. A human shoulder
blade does this on a full reach; the recorded CMU reaches stay comfortable, so
the fit alone gives only about 6° forward.

The arm length fit is `clamp(0.406 × shoulder height above the lowest foot or
toe joint / arm length, 1, 1.08)` per chain, from the bind pose. It is a ratio
applied in the VR solve (upper arm and forearm alike), for both sources, and it
stays through a tracking loss. On the house avatar it is 1 (the arm already has
human proportions); it lengthens only an avatar whose arms are short.

The tanh reach stretch stays as a 1.8% reserve for both sources. The rest of
the gap on targets past full reach stays; the arms check bars stop it from
growing.

### Runtime shape

- `armPoseCoefficients.ts` is generated by `scripts/mocap/fit-arm-pose.ts`
  (with `--write`). `armPoseModel.ts` holds the feature function, the elbow
  pole and the clavicle angles.
- `ArmIkChain` gains `hasClavicle`, the torso bone and its bind rotation in the
  avatar root, the arm length fit, and the last clavicle angles (for the rate
  limit; cleared on a runtime reset).
- `ArmIkSolver.solve` gains opt-in options: `armModel: { deltaSec }` (the
  modelled pole and clavicle) and `armLengthRatio`. Without them the solve is
  the same as before, so the desktop paths and the camera tracker do not
  change.
- `HandEmbodiment.update(headAnchor, { deltaSec })` passes them for both VR
  sources; `TrackedHandsSystem` gives the frame's delta time.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Elbow swivel, flips, clavicle range and steps, wrist error, both sources | `DEV_PORT=5274 node --import tsx scripts/run-xr-checks.ts arms` (gated) | `output/arm-after2/{hand,controller}-report.json`; before in `output/arm-before/` |
| The Quest take (swivel, clavicle, wrist p95, stretch) | the `hands` replay (`XR_REPLAY_ONLY=headset-open-fist-pinch-point-wave-reach`, gated) | `output/quest-after/…-report.json`; before in `output/quest-before/` |
| Desktop arms unchanged | arms check desktop rows, `desktop-reach-interruptions` | reports (pending) |
| No regressions | avatars (no-fingers first), body, object, hands, the IWER resize take | check reports (pending) |
| Fit is repeatable | `node --import tsx scripts/mocap/fit-arm-pose.ts` writes the same `armPoseModel.ts` | git diff empty after a rerun (pending) |
| The arms look natural | before/after proof video (H.264) in `output/` | sent to the owner (pending) |

Results (IWER arms check, `output/arm-before` and `output/arm-after2`; Quest
take, `output/quest-before` and `output/quest-after`):

| Measure | Hands before | Hands after | Controllers before | Controllers after |
|---|---|---|---|---|
| Swivel median rest / stand / walk | 141° / 131° / 138° | 40° / 34° / 39° | 140° / 132° / 133° | 34° / 33° / 34° |
| Swivel median side-low | −175° | 60° | 175° | 57° |
| Flips per minute | 1.0 | 0 | 1.0 | 0 |
| Clavicle elevation range, whole run | 86° | 23° | 127° | 23° |
| Clavicle protraction range, whole run (worst segment) | 103° (83°) | 37° (27°) | 90° (73°) | 35° (26°) |
| Largest clavicle step | 21° | 7.1° | 22.9° | 7.1° |
| Wrist p95 forward / forward-far / overhead | 0.3 / 3.6 / 3.3 cm | 0.0 / 5.8 / 5.5 cm | 0.3 / 14.8 / 14.5 cm | 0.0 / 12.3 / 12.0 cm |
| Arm length spread | 8% stretch | 1.8% | 0 | 1.8% |

| Quest take | Before | After |
|---|---|---|
| Swivel median | 92.7° | 37.6° |
| Flips per minute | 0 | 0 |
| Clavicle elevation / protraction range | 18.0° / 76.7° | 6.0° / 26.7° |
| Wrist p95 | 0.2 cm | 0.7 cm |
| Arm length spread (over hip spacing) | 7.9% | 1.8% |

The arms check gates fail `main` (22 misses on hands, 25 on controllers) and
pass this change.

## Physical-device limits

All numbers above are IWER emulation and the replay of one real Quest 3 hand
take. A headset check on a Quest 3 with hands and with controllers stays open
after the merge: the owner looks at the elbows at rest and on reaches, and the
hand on a full controller reach.
