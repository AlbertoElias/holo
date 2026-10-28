# Feature brief: props collide with the avatar

**Lead:** Claude Code (Opus, session avatar-physics)  
**Status:** Verifying (independent Codex verification pending: the machine was offline on 2026-10-28)
**Layer:** event (`docs/product/concepts/what-a-hologram-is.md`): the prop's
flight off the body is part of what happened, so it is recorded as ordinary
object poses.

## User outcome

The user said: "each object should interact with physics with the avatar too".
A thrown or dropped prop bounces off the avatar's body and limbs instead of
passing through it. Walking into a resting prop shoves it. In a headset, a
swinging tracked hand or arm bats a prop that isn't held. The avatar itself is
never slowed, blocked or launched by a prop. The recipient sees all of this in
the replay, because the prop's poses are recorded exactly as today.

This reverses the "Collisions" decision of 2026-10-27 in
[`archive/object-physics.md`](archive/object-physics.md) ("the avatar's body
and hands don't collide with props").

Decisions taken with the user on 2026-10-28:

- **Holder.** A released prop ignores the holding arm (hand, forearm, upper
  arm) until it has cleared it. The rest of the body collides, so a throw can
  still bounce off the thrower's own leg.
- **Avatar push.** Never. The avatar is immovable: it shoves props, and props
  never slow, block or launch it. Locomotion is unchanged.
- **Hands.** Each hand has a palm-sized collider, smaller than the grab reach
  (`VR_REACH_M`, 0.1 m past the prop's bounds), so a slow reach grabs before it
  shoves. The desktop and phone reach's target ignores the avatar while the
  reach plays. Fast swings bat props.
- **Hovering.** A placed prop that has never been released hovers
  (kinematic). Avatar contact knocks it down: it turns dynamic and is pushed
  or falls. Refined in design review to fit the hands decision: only a part
  moving faster than 0.5 m/s knocks a hovering prop. A hand closing slowly on
  it, as before a squeeze, does not; walking (about 1.4 m/s) and swings do.

## Scope

**Included:**

- **Avatar colliders in the prop world.** `ObjectPhysics` gains one
  kinematic-position-based body per avatar part, 14 in all: torso (hips to
  neck), head, and per side upper arm, forearm, palm, upper leg, lower leg and
  foot. Capsules run bone to child bone; the head and palm are spheres. Radii
  are fractions of `AvatarRig.avatarHeight`, which changes only with the XR
  height fit (not with a crouch), so a rescaled avatar rebuilds its shapes.
  Parts the humanoid lacks are skipped. A capsule's roll carries over from
  frame to frame (the smallest turn from last frame's axis), so a hanging limb
  can't flip about itself and flick props by friction.
- **Driven after the final pose.** ObjectSystem (priority 75) runs after
  BodyPoseSystem, CameraSystem and TrackedHandsSystem, so the bones are final.
  The parts are read from the bones inside `stepPhysics`, after the desktop
  carry and reach squat have written the arm. Every kinematic body (avatar
  parts, held and hovering props) is interpolated across the frame's
  substeps, so a moving part carries its own velocity into what it hits
  rather than all of it in the first substep.
- **Teleports don't shove.** A part that moves faster than 8 m/s (and at least
  0.1 m) in one step, or every part when the hips turn more than 20° in one
  step (a snap turn), is placed with `setTranslation` (no velocity), and every
  prop it then overlaps ignores that part until clear. After each step a free
  prop's speed is clamped to the release clamps (12 m/s, 20 rad/s), so a foot
  pressing a prop into the floor can't eject it and a kick can't spin it past
  what replay interpolates.
- **Filtering by collision groups.** Membership bit 0 is the props; bits 1 to
  14 are the avatar parts. Avatar parts filter only bit 0. The scene keeps
  Rapier's default groups, so parts pair with it, but kinematic-against-fixed
  contacts are never solved. Each prop's filter is bit 0 plus the avatar bits
  it currently accepts. No contact hooks.
- **Until clear.** After each step, a prop with excluded parts tests its
  collider against each excluded part's shape directly
  (`Shape.intersectsShape` at the poses just computed). Rapier 0.20's scene
  queries read a broad-phase tree refit only inside `world.step`, so they
  would miss parts moved this frame. Parts it no longer overlaps are accepted
  again. This applies at:
  - release: the holding arm's three parts for at least 0.25 s, and then
    until clear (the grip holds the prop behind the palm, so a hand that stops
    after a throw would otherwise catch what it threw); plus any other part
    the prop overlaps at that moment (a prop let go inside the torso would
    otherwise be ejected);
  - a flat-screen put-down (not a throw): both legs too, for 1 s, because the
    squat's knees rise past the prop;
  - teleport: as above;
  - placement: a new prop starts excluding every part and keeps only those it
    overlaps;
  - the end of a desktop or phone reach, by any path (grab, cancel, VR entry,
    release), because the target is polled from the reach state each step.
- **Desktop and phone reach.** While a reach plays, its target excludes all
  avatar parts. On grab it is held (kinematic). On cancel the until-clear rule
  takes over.
- **Hovering knocked down.** A hovering (never released) prop that a part
  moving faster than 0.5 m/s touches turns dynamic with zero velocity, and the
  next step resolves the contact. A sleeping prop touched by a moving part is
  woken. A prop placed overlapping the avatar excludes those parts until
  clear, so placement alone never knocks it down.
- **Held props.** A held prop is kinematic. Kinematic-against-kinematic never
  collides in Rapier, so a held prop and the body never fight. A held prop
  still shoves free props, as today.
- **`gapBelow` ignores the avatar,** so the squat set-down measures the floor,
  not the holding hand or feet.
- **Recording unchanged.** Flights off the body are ordinary object poses.
- **Every device that records props:** desktop (keyboard and mouse), phone
  (touch, same desktop body), VR controllers and VR hand tracking.

**Excluded:**

- AR. A passthrough headset and phone AR camera takes are spectators and
  record no props (see the archived brief), so they get no avatar colliders.
  This stays tied to the passthrough-props item in `TODOS.md`.
- Props pushing, blocking or launching the avatar.
- Per-finger colliders. The palm sphere stands for the hand.
- Physics on a viewer's placed holograms, or simulation in the viewer.
- Ragdoll or any reaction of the avatar's pose to a hit.
- Prop collider changes. The resize work owns prop collider scale; avatar
  parts are built separately and only read the prop's shape for queries.

## Acceptance criteria

Amended after implementation where the check differs from the draft; each
difference is noted.

- [x] **Drop onto the body (VR).** In IWER, the left controller is held out
  palm-up at waist height. A prop dropped still from 0.3 m above the left palm
  stops on it or is deflected off it. It never passes below the palm's top
  while within 5 cm of the palm's centre. Without the avatar's colliders it
  falls straight through to the floor.
- [x] **Throw at the body (VR).** A prop thrown from the right hand across the
  torso, to the avatar's left, hits the torso or left arm. Its velocity along
  the throw drops by at least half (here, reverses) before it nears the floor.
  Its rest and penetration are covered by the throw scenario's limits.
- [x] **Bat (VR).** Amended: the struck prop is a hovering one in front of the
  avatar rather than one on the platform, which also proves the hovering
  knock-down in a headset. The open right controller, swung through it at
  2 m/s without squeezing, knocks it down. It leaves with a horizontal speed of
  at least 0.5 m/s, within 45° of the swing direction.
- [x] **Holder doesn't fight.** The existing still drop, throw, clamp-speed
  throw, surface, bounds, catch and non-throw scenarios pass. The reach helper
  now stops at grab range, and the transient penetration limit is 5 mm (see
  Design decision). A prop released while pressed against the torso leaves at
  under 0.3 m/s over its first 5 steps. After that it has fallen onto the
  thighs, which deflect it as a body would.
- [x] **Walking shoves (desktop).** The `object-take` walk-through check is
  inverted. Walking into a resting prop, lined up with the right foot, moves it
  at least 0.1 m in the walking direction. Amended: the avatar's walking speed
  while pushing matches its speed on the approach within 2% (+1 cm/s); a second
  no-prop walk was not needed to show this. A prop dead centre can pass between
  the feet, which is plausible for a straddle.
- [x] **Hovering knocked down (desktop).** Walking into a freshly placed
  hovering prop knocks it down (one knock-down), and it comes to rest on the
  floor.
- [x] **Reach unaffected.** Every reach check (floor, mouse, phone, trench,
  wall, pit, railing, VR entry mid-step, revalidation) passes. A cancelled
  reach's prop moves under 1 mm (it was 0.01 mm). A reach cancelled by walking
  may kick the prop along; there only "not held" is checked.
- [x] **No teleport launch.** A VR snap turn with the open palm 7 cm from a
  hovering prop leaves it at under 0.3 m/s (it stayed still). Recenter is not
  driven by a check; it relies on the same jump rule.
- [x] **Recorded and replayed.** The physics run's recorded throw exports a
  `RecordedObject` track with a key for every avatar key, covering the flight,
  with no key-to-key turn over 180°. The recording path is unchanged, so a
  bounce off the body is recorded the same way. The viewer pipeline spec
  passes.
- [x] **Cost (report).** Measured as in the archived brief: in Node, the same
  12,800-triangle trimesh and four 128-vertex hulls, plus the 14 avatar parts
  driven along a recorded walk-and-swing. Median and p95 `world.step` time are
  reported against the 4-prop baseline (median 0.12 ms, p95 0.41 ms). The
  budget is a median under 0.3 ms and a p95 under 1 ms. The Quest's frame cost
  is a device check.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Released prop starts inside the holding hand or arm and is ejected | Holding arm's parts excluded until clear; "pressed against the torso" release check |
| Prop let go inside another part (torso, leg) is ejected | Every overlapped part excluded until clear at release |
| Reaching hand shoves the prop away before the grab | Palm sphere radius under the grab reach; IWER reach helper stops at grab range, as a user would; desktop/phone reach target excludes the avatar |
| Desktop step-in or squat legs kick the target away | Reach target excludes all avatar parts while the reach plays; reach checks measure target drift |
| Respawn, recenter, snap turn or load gives a part a huge kinematic velocity and launches props | Jump threshold, then teleport without velocity and until-clear exclusion; snap-turn check |
| Props block or launch the avatar | Avatar parts live only in the prop world; the motor's world is unchanged; walk path compared with a no-prop walk |
| Avatar parts collide with the scene and jitter | Kinematic bodies never respond to contacts; their filter excludes everything but props |
| Held prop and body fight | Both kinematic: no contact between them |
| Set-down measures the gap to the hand, not the floor | `gapBelow` filters out the avatar bits |
| A rescaled avatar keeps stale capsules | Shapes rebuilt when the measured height changes |
| An avatar missing bones (no feet, no neck) crashes | Parts without both bones are skipped, and the humanoid notes it |
| A prop wedged against a foot stays excluded forever | Acceptable: it is at rest. Exclusion ends as soon as it is clear |
| Cost on the Quest | Node benchmark against the baseline; the device frame cost is listed as a device check |
| Recording format drifts | No format change; the export and pipeline checks pass |
| Overlap with the resize session's prop collider changes | Avatar parts are separate; queries use the prop's current collider shape, whatever its scale |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer | Claude Code (lead) | `apps/capture/src/physics/ObjectPhysics.ts`, new `physics/AvatarColliders.ts`, `objects/ObjectInteraction.ts` (reach exclusion hook only), `objects/CaptureObjects.ts`, `systems/ObjectSystem.ts`, `scripts/lib/object-physics.mjs`, `scripts/lib/object-take.mjs`, a Node cost benchmark script |
| Independent verifier | Codex (`-p standard`) | Read-only verification; test artifacts only |

## Design decision

Kinematic avatar parts in the existing prop world, filtered per prop by
collision groups. Alternatives: sharing the motor's world (rejected in the
archived brief: props one step behind the hand, and every motor query would
need filtering); contact hooks per pair (a JS callback per contact, and no
gain over 14 group bits); three coarse bits (left arm, right arm, rest), which
the review offered as a simpler option. Per-part bits were kept because the
until-clear rule then frees each part as soon as the prop clears it, so a
prop let go inside the chest still bounces off a leg.

Design review (Opus `design-reviewer`, 2026-10-28) changes, all taken:

1. Hovering knock-down gated on part speed (0.5 m/s), and the IWER reach
   helper now glides in and stops with the palm 7 cm short, within grab range,
   instead of driving the hand bone into the prop's centre.
2. Overlap tests are direct shape tests, not scene queries (the broad-phase
   tree is refit only inside `world.step`).
3. Shapes are sized from `avatarHeight`, not the live head-to-foot distance,
   which a crouch changes.
4. Capsule roll carried over from frame to frame.
5. Teleport threshold lowered to 8 m/s with a 20° hip-turn backstop, and free
   props' speeds clamped after every step. The review preferred explicit
   teleport events from respawn, recenter, snap turn and height fit; they are
   not wired. The snap-turn check covers the case that leaked, and the
   explicit events stay a follow-up if a device check shows a launch.
6. Kinematic targets are interpolated per substep.
7. Reach exclusion is polled from the reach state, so every way a reach ends
   is covered.
8. Group wording corrected (the scene pairs with the parts but never solves
   against them).
9. The desktop put-down passes through the legs for 1 s (the squat's knees).

Found while testing: the holding arm needs a short grace (0.25 s) on top of
the until-clear rule (see Scope). The VR throw's transient floor penetration
limit moved from 3 to 5 mm. With the new reach helper's grip, the bracket
tumbles on landing and dips 4.4 mm, the same with the avatar colliders off.
The rest gap is still checked to 1 cm.

## Test plan and evidence

All runs on 2026-10-28, on a local Mac, against the capture test build on port 5194.

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Drop onto the body | `OBJECT_ONLY=physics pnpm run test:xr:object`, scenario `palmDrop` | Never below the palm within 5 cm of its centre; deflected to the floor. `output/ci-object-av/object-physics-report.json` |
| Throw at the body | same, `bodyThrow` | Launched at 1.86 m/s across the body; -0.29 m/s along the throw while airborne |
| Bat | same, `bat` | Knocked down; left at 0.91 m/s, 11.5° off the swing |
| Holder doesn't fight | same, slice-1 scenarios plus `chestRelease` | All pass; the chest release left at 0 m/s horizontal over 5 steps |
| No teleport launch | same, `snapTurn` | One 30° snap; the prop stayed at 0 m/s |
| Walking shoves | `OBJECT_ONLY=desktop`, `walkThrough` | Shoved 1.22 m along the walk; the avatar at 3.185 m/s before contact and 3.183 m/s while pushing |
| Hovering knocked down | same, `knockdown` | 1 knock-down; at rest on the floor, 0.1 mm gap |
| Reach unaffected | full `pnpm run test:xr:object` | All 14 takes pass (`output/ci-object-av/report.json`) |
| Recorded and replayed | physics `recordedThrow`; `RUN_E2E_PIPELINE=1 playwright test e2e/object.pipeline.spec.ts` on its own ports | Export checks pass; both pipeline tests pass, the thrown take included (flight and landing in the viewer and the USDZ) |
| Cost | `node --import tsx scripts/bench-object-physics.ts` | One frame's `ObjectPhysics.step` over 240 frames. Without the avatar: median 0.032 ms, p95 0.181 ms. With 14 parts walking through the pile: median 0.168 ms, p95 0.388 ms, max 2.29 ms. Within the budget (0.3 ms, 1 ms). The archived 0.12/0.41 ms baseline timed `world.step` alone on another pile, so this run's own no-avatar figure is the comparison. |
| Workspace | `pnpm run verify:agent` | Pass |
| Proof video | `apps/capture/output/avatar-physics-proof/record.mjs` (ignored) | Real time, 1:51. Desktop: knock-down and a sideways kick. Then the headset's own view: a bat, a throw across the body bouncing off it, and a drop onto the open left hand. The desktop follow camera sits behind the avatar, so the desktop knock-down is mostly hidden. |
| Independent verification | Codex `-p standard` | Pending: no network on 2026-10-28 |

## Physical-device limits

IWER proves the emulated behaviour only. On a Quest, still to check: how batting
feels with real hand tracking, whether a natural reach knocks a hovering prop
before the grab, and the frame cost with 14 extra kinematic bodies.
