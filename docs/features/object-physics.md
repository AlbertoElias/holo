# Feature brief: Grab, place and throw objects with physics

**Lead:** Claude Code (Opus)  
**Status:** Reviewed (design review 2026-10-27); slice 1 implementing
**Layer:** Event (see `docs/product/concepts/what-a-hologram-is.md`)  
**Builds on:** [Explain with an object](explain-with-an-object.md) (PRD-043) and
[Summon and place](summon-and-place.md) (PRD-045), which excluded physics.

## User outcome

While recording, an author handles a prop the way they would a real thing, on
every capture device that records: Quest (controllers and hands), desktop and
phone. They pick it up, carry it, set it down on a table or the floor, drop it,
or toss it. Once let go, it falls, bounces, tumbles and comes to rest on the
scene's surfaces. The recipient sees the same throw, fall and landing replayed
in the feed, portal, headset and Quick Look, because the flight is part of the
recorded event.

Decisions taken with the user on 2026-10-27:

- **Where:** capture props only. A viewer's placed holograms keep today's
  grounded two-hand grab and AR placement.
- **Release:** every release hands the object to physics. A gentle release
  drops it, and a flick throws it. Nothing floats in mid-air after being let go.
- **Collisions:** the floor and the scene model's surfaces. The avatar's body
  and hands don't collide with props.

The design review cut passthrough AR. A headset in passthrough is a spectator
and never records (`createCaptureRuntime.ts`, "a headset in passthrough
watches"), and phone AR camera takes are spectators too. So there is no AR prop
to throw. Real-floor and plane-detection colliders move to `TODOS.md` for when
AR recording carries objects.

## Scope

**Slice 1: physics and VR/desktop release**

- **A prop world of its own.** A new `physics/ObjectPhysics.ts` owns a
  separate Rapier world. Sharing the motor's world would put props one step
  behind the hand (the motor steps in MovementSystem, before the arms are
  final). It would also make the capsule and the spawn, recovery and terrain
  raycasts collide with props unless every query were filtered. The prop world
  holds:
  - a copy of the scene trimesh (from `CharacterMotor.buildWorldTrimeshData`);
  - a ground plane at the floor;
  - one body per `layer: 'event'` object, never for tray miniatures.

  It is stepped inside ObjectSystem after the hold update, with `frame.deltaSec`
  substepped to at most 1/60 s, so RecordingSystem samples the result in the
  same step. The motor world is built once and never rebuilt, so the trimesh
  copy can't go stale.
- **Held and released.** A held object is a kinematic body that follows today's
  `anchor × offset` (the hand bone with scale removed). On release it turns
  dynamic.
- **Release velocity from the object's own pose.** A ring buffer of the
  wrapper's world poses, weighted by time over about 100 ms, gives linear and
  angular velocity. It includes ω×r from the offset, the desktop pickup glide
  and the turn keys. The fit uses at least 3 samples, because at the 1/20 s dt
  clamp 80 ms holds only 1–2. Clamps: linear 12 m/s, angular 20 rad/s. The
  angular clamp keeps the turn between 60 Hz keys under 180°, so the viewer's
  and USDZ's per-key interpolation can't spin the wrong way.
- **Throws and non-throws.** Only a deliberate release (squeeze or pinch let
  go, or `G` put-down) throws with the fitted velocity. These drop with zero
  velocity:
  - the controller/hand mode switch;
  - the end of the 0.5 s tracking-loss freeze;
  - the removal path.
- **Colliders.** Each prop gets a convex hull from its meshes, with the vertex
  count capped. It falls back to its bounding box. Mass comes from volume at a
  single density. Friction, restitution and damping are moderate, so the prop
  settles in about a second, then sleeps. CCD is on for prop bodies. Props
  collide with each other.
- **Catch and re-grab.** A moving or resting object can be grabbed again under
  the same reach rule, mid-air included. Grabbing turns it kinematic at once.
  The tray summon (it writes a pose, then grabs) works unchanged.
- **Bounds.** `place()` stores the placement pose. A prop that falls below the
  floor or leaves the scene bounds returns there, at rest.
- **Lifecycle.** `SceneObjectRegistry.remove` and its clears destroy the body.
- **Recording and replay.** `ObjectSampleStore` samples every placed object
  each step, held or not. So a flight is recorded as poses at full rate with
  no change to the GLB, the `HOLOIM_objects` extension or the viewer. Hold
  spans still mark only the held time. When the recorder skips frames (its
  pause paths), physics keeps running, so the flight jumps in the take. That
  matches how the body behaves there and is accepted.
- **No scene model.** Physics can't run here: `motor.init` returns false and
  `ObjectSystem` skips objects until spawn resolves. So this case keeps
  today's no-object behaviour, and the ground plane only backs the trimesh.

**Slice 1 values and decisions taken while implementing:**

- **Collider and material.** A convex hull of at most 128 vertices, taken as
  the extreme vertex along 128 directions. Density 500 kg/m³. Friction 0.8,
  max-combined with the scene's default 0.5, so a drop grips instead of
  skating. Restitution 0.12. Linear damping 0.15, angular damping 1.5.
- **Before the first grab.** A freshly placed or summoned prop stays
  kinematic and waits at its placement pose until its first release.
  Dropping it on placement would put it out of reach.
- **Bounds.** The scene's bounding box plus 0.5 m, with the floor limit 1 m
  below its lowest surface.
- **Desktop `G`.** It drops the prop from carry height. A bracket landing on
  an edge skitters about 25 cm, which is physically plausible but isn't
  "placing". Slice 2 adds a set-down.

**Slice 2: mouse and touch grab**

- **Desktop set-down.** The `G` put-down, and a still mouse release, first
  lower the carry hand toward the surface under the prop, then let go a few
  centimetres above it, so it settles where it is put. A release while the
  hand is moving still throws.

- **Desktop mouse.** Under pointer lock, a left-button press casts a ray from
  the view centre and grabs a reachable prop into the carry pose. Letting go
  of the button releases it with the fitted velocity. The click that acquires
  pointer lock never grabs, and the right button stays the point action.
  `G` and `Q`/`E`/`Z`/`X` are unchanged. Swinging the carry hand with the
  mouse (new carry IK) stays out unless slice 1's proof video shows desktop
  throws feel dead without it.
- **Phone capture (touch).** Phone capture is the non-XR runtime, with the
  third-person avatar and the carry pose. A touch on the look side that starts
  on a reachable prop (`desktopReachable`) grabs it into the carry pose. The
  hit test runs in `TouchInput` before the look and hold handling. Dragging
  still looks, and lifting releases with the fitted velocity. Touches that
  start elsewhere, and the stick side, behave as today.

**Excluded:**

- passthrough AR props and real-surface colliders (follow-up in `TODOS.md`);
- physics on a viewer's placed holograms;
- collisions with the avatar's body or hands;
- two-handed holds, scaling, breakable or articulated objects, and authoring
  mass or materials per object;
- simulating physics in the viewer. The viewer replays recorded poses.

## Acceptance criteria

Slice 1:

- [ ] **VR throw.** In IWER with controllers, grab, swing and release
  mid-swing. The object leaves along the swing direction, with launch speed
  within 20% of the object's fitted speed over the last 100 ms held. It comes
  to rest on the floor or a scene surface within 3 s, with its lowest point
  within 1 cm of the surface and never below it.
- [ ] **Drop and place.** Releasing a still hand drops the object onto what's
  below, with under 5 cm of horizontal drift. Releasing an object resting on a
  surface leaves it there.
- [ ] **Catch.** Grabbing a falling object stops it, and it then follows the
  hand rigidly.
- [ ] **Desktop `G`.** The `G` put-down drops onto the surface. Turning with
  `Q`/`E` while holding and then putting it down doesn't fling it.
- [ ] **Non-throw releases.** A mode switch, the end of the tracking-loss
  freeze and removal all drop with zero initial velocity.
- [ ] **Bounds.** An object forced out of bounds returns to its placement pose.
- [ ] **No self-collision.** Walking through a resting prop moves neither the
  prop nor the avatar.
- [ ] **Recorded and replayed.** A take with a throw exports a
  `RecordedObject` track with as many keys as the avatar's, covering the flight
  and the landing. Hold spans end at the release. Through the real API, the
  viewer's object transform matches the GLB at key times (≤ 1 cm, ≤ 1°), and
  the USDZ has time samples across the flight. No key-to-key rotation exceeds
  180°.
- [ ] **No regression.** The release check in `scripts/lib/object-take.mjs`
  ("leaves it in place") is rewritten to expect a fall to rest. The object,
  summon and pipeline checks pass, and takes without objects and existing GLBs
  behave as today.
- [ ] **Cost (report only).** The report logs the median prop `world.step`
  time over the run with four props.

Slice 2:

- [ ] **Mouse.** Under pointer lock, a left press on a reachable prop grabs
  it, and a press out of reach or the lock-acquiring click does nothing.
  Releasing drops or throws it.
- [ ] **Touch.** At phone size with touch emulation, a touch on a reachable
  prop grabs it and lifting releases it. A touch elsewhere still looks,
  touch-and-hold still points, and the stick still moves.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A jittery tracking frame at release flings the object | Pose fit over ≥3 samples across ~100 ms, plus the clamps; the VR throw check |
| Props one step behind the hand | Separate world stepped in ObjectSystem after the hold update |
| Props block the capsule or catch the motor's raycasts | Separate world; the walk-through check |
| Object tunnels through a thin surface at throw speed | CCD; a throw at clamp speed onto a thin surface |
| Never settles | Damping, restitution, friction and sleep; rest within 3 s |
| Fast spin interpolates backwards between keys | 20 rad/s clamp; the ≤180° key-delta assertion |
| Mode switch, freeze end or removal throws with a garbage velocity | Zero-velocity drop on those paths; the non-throw check |
| A removed object leaves an orphan body | Destroyed in `SceneObjectRegistry.remove` and its clears |
| Tray miniatures get bodies | Only `layer: 'event'` objects get bodies |
| Lost below the floor or outside bounds | Reset to the placement pose; the bounds check |
| Recorder pause makes the flight jump | Accepted and stated; body frames behave the same |
| Hull build fails on odd meshes | Vertex cap and box fallback; PRD-043 fixtures |
| Lock-acquiring click or look drag grabs by mistake (slice 2) | Ray only while locked; the click that takes the lock is ignored; mouse check |
| Touch grab steals look, point or stick (slice 2) | Look-side, prop-hit-only grab; touch check covers each path |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Done 2026-10-27; changes folded in above |
| Implementer | Claude Code (Sonnet subagent) | `apps/capture/src/physics/ObjectPhysics.ts` (new), `physics/CharacterMotor.ts` (expose trimesh data only), `objects/**`, `systems/ObjectSystem.ts`, `input/InputController.ts` and `input/TouchInput.ts` (slice 2), `scripts/ci-object-playwright.mjs`, `scripts/lib/object-take.mjs`, summon check expectations |
| Independent verifier | Codex (`-p standard`) | Read-only verification, test artifacts and proof video under `output/` |

## Design decision

Use Rapier, which capture already loads, in a **separate prop world**, not the
motor's world and not IWSDK physics (Havok). It carries a copy of the same
trimesh the avatar walks on, so props land on the same surfaces, without
coupling to the motor's step order or its queries. Capture's grab code stays
custom: grabs are anchored to the avatar's hand bones, and physics slots in at
release.

Physics runs only in capture, and its result is recorded as poses. The
recording stays the event, and every viewer, Quick Look included, replays the
same flight deterministically.

Review changes adopted: AR cut; separate world stepped after the hold update;
velocity fitted from the object's own pose, with an angular clamp; zero-velocity
drop on non-throw releases; body lifecycle tied to the registry; phone grab
into the carry pose, not finger-depth dragging; mouse grab as a centre ray under
pointer lock; work split into two slices; the cost check made report-only; the
viewer matched at key times.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| VR throw, drop, catch, non-throw, bounds, walk-through, `G` | `pnpm --filter @holoim/capture run test:xr:object` (extended, IWER controllers) | `object-physics-report.json` with trajectories, rest heights, launch speeds, step times; contact sheet |
| Summon still works | `pnpm --filter @holoim/capture run test:xr:summon` | Pending |
| Recorded and replayed | `pnpm --filter @holoim/web run test:e2e:pipeline` (object spec with a thrown take) | GLB vs viewer report at key times; USDZ time samples |
| Mouse, touch (slice 2) | Playwright desktop and touch-emulated scenarios | Report rows per mode |
| No regression | `pnpm run verify:pr` | Pending |
| Proof video | Real-time recording: throw, drop onto a table, replay in the feed | Under `output/`, not committed |

## Physical-device limits

IWER proves deterministic emulated throws, not their feel. On a device, check:

- **Quest 3 controllers and hands.** Throws go where they are aimed and feel
  weighty but not sluggish. A pinch release doesn't add a spurious flick.
- **Android phone (slice 2).** Touch grab and release feel natural.
- **Quest frame rate.** Several props in motion.
