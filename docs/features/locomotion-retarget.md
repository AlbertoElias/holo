# Feature brief: Locomotion clips on every avatar

**Lead:** Claude Code (session 2026-10-29)
**Status:** Implementing
**Layer:** Event (the recorded body; see `docs/product/concepts/what-a-hologram-is.md`)

Slice 2 of [`archive/avatar-formats.md`](archive/avatar-formats.md).

## User outcome

An author who loads an avatar without its own locomotion clips (every VRM, a
Mixamo character download, an Unreal or VRoid export) with `?avatar=<url>`
sees it idle, walk, jump and fall like the shipped avatar on desktop, and in
XR whenever the animation path drives the legs. A rig whose rest pose is a
T-pose or an A-pose stands with its arms down on desktop, as the shipped
avatar does, instead of holding them out. The recorded take carries that
motion through export → upload → render.

Today such an avatar keeps its rest pose on desktop (arms out on a T-pose
rig, no stride) and, in XR when the body solver is off (mock VR, or a rig the
solver cannot drive), walks only with the terrain legs.

## Scope

**Included:**

- **A clip library.** `public/gltf/animations/locomotion.glb`: the shipped
  avatar's skeleton and its Idle, Walk, Jump and Fall clips, with each mesh cut
  to one skinned triangle and no textures (so GLTFLoader still makes the joints
  `Bone`s and the resolver binds it like any avatar). Generated from
  `avatar.glb` by `scripts/build-locomotion-library.mjs`; `test:avatars:bind`
  fails when the library's rest pose or clips drift from `avatar.glb`'s.
- **A retargeter** (`src/animation/retargetClips.ts`): source rig + clips +
  target rig → target clips. Both rigs are bound with `HumanoidSkeleton`, so
  every format slice 1 resolves works, and both are measured in their avatar
  root frame after the facing correction (+Z forward, +Y up, any armature
  scale or axis node included). Per canonical bone `b`:
  - Source world rotation `S_b(t)` by forward kinematics through the source
    hierarchy; source rest `Rs_b`.
  - **Rest-pose correction** `A_b`, arms only, applied parent-first (a
    corrected upper arm carries the forearm, hand and fingers): the upper arm
    swings its direction (to the forearm) onto the source's; the forearm and
    hand also roll so their knuckle line (index → little proximal) matches,
    which undoes a palms-forward rest. Legs, feet, spine and head keep their
    own rest shape: the desktop idle leaves the legs at rest, so a leg
    correction would change the stance at every stop. This is what puts a
    T-pose rig's arms down.
  - Target world rotation `T_b(t) = S_b(t) · Rs_b⁻¹ · A_b · Rt_b` (the source's
    world-space motion applied to the target's corrected rest), and the local
    rotation from the target's own parent chain. Target nodes that are not
    canonical bones, or canonical bones the source lacks, keep their rest
    local rotation.
  - Sampled at the union of each source clip's key times, so a rig identical
    to the source gets exactly the source's keys back.
  - A track is emitted for a target bone only when its local rotation differs
    from its rest by more than 0.05° at some key. Arms on a T-pose rig get a
    constant track (the correction); a rig identical to the source gets only
    the source's animated bones.
  - Tracks bind by the target bone's `uuid`, so duplicate names (a prop with
    its own `Hips`) cannot steal them. The avatar's own clips are rebound the
    same way.
  - A mirrored or unevenly scaled node between the root and a bone (rotations
    alone no longer describe it) throws, and locomotion is reported off.
- **Per-avatar choice** in `LocomotionAnimator.attachClips`: the avatar plays
  its own clips when it has a usable Idle and Walk (a clip of that name with a
  rotation track on one of this rig's canonical bones), with today's fallback
  order for jump and fall; otherwise every state plays the library's. Never a
  mix: the library's clips carry the arm correction, so mixing would make the
  arms pop between states and during crossfades. The existing profile filters
  (desktop idle without lower-body tracks, the VR lower-body profile with legs
  only, no root motion) apply to both.
- **Report.** `HumanoidBindingReport.locomotion`: per state `own`,
  `retargeted` or `none`, plus the rest-pose correction applied per limb in
  degrees. When the library fails to load or retarget, or the rig lacks hips or legs,
  `locomotion` is reported off through `disableFeature` (one warning, as
  today).
- **Loading.** For an avatar other than the shipped one the library is fetched
  in parallel with it; it is never added to the scene, and its binding never
  warns.
- **Fixtures.** The generated fixtures drop the shipped clips (real
  third-party files do not carry Ready Player Me's clips), except
  `mixamo-prefixed` (own clips still win under renamed bones) and
  `duplicate-names` (own clips drive the avatar, not the prop named `Hips`).
  New `t-pose-twisted`: arms 15° forward of the side and forearms rolled 90°
  (palms forward), which a swing-only correction cannot fix. That gives a clip-less fixture for every format slice 1
  supports: VRM 1.0 (`vrm1-declared`), VRM 0.x (`vrm0-minus-z`), Mixamo names
  (`reoriented-axes`, `a-pose`, `t-pose`, `z-up`), Unreal (`unreal-cm`), VRoid,
  3ds Max Biped, Meta, ARKit, plus `no-fingers` and `duplicate-names`.

**Excluded:**

- New or better clips (run, turn, crouch-walk); the clips stay the shipped
  lower-body set. Arm swing while walking is therefore not added.
- Retargeting an author's own clips onto another rig, or loading third-party
  animation files. The retargeter takes any bound source, so this is a later
  change, not part of this one.
- Finger rest-pose correction (fingers have no clip tracks; desktop hands keep
  their rest curl).
- The XR body solver, arm IK and hand tracking: they already work from the
  measured bind pose (slice 1) and own those bones in real XR. Retargeted
  clips must not change them.
- Viewer-web: it plays recorded tracks and never reads locomotion clips.

## Acceptance criteria

- [ ] **Library and identity (Node):** the committed library equals what the
  generator makes from `avatar.glb`. Retargeting it onto a rig identical to
  the shipped one (renamed, declared and duplicate-name fixtures) gives the
  library's keys back to 1e-5 and no other tracks.
- [ ] **Retargeted pose (Node):** on every mappable fixture, each retargeted
  clip at eleven times puts every canonical bone and the middle and thumb
  fingertips within 1.5 cm of the library's pose (hips-relative), including
  `t-pose`, `a-pose` and `t-pose-twisted`. A retargeter without the roll
  fails `t-pose-twisted` (fingertip 9.6 cm off); one without the correction
  fails `t-pose` by 58 cm.
- [ ] **Clips in the app, desktop and VR profiles:** each state's clip posed
  at fixed clip times in the running app (`__poseLocomotion`) puts every
  canonical bone and fingertip within 1.5 cm of the shipped avatar's on the
  desktop profile, and the leg bones on the VR lower-body profile.
- [ ] **Desktop take:** a physics-driven walk, stop, jump and landing, sampled
  every 100 ms, passes through the same states as the shipped avatar with every
  bone within 1.5 cm of it.
- [ ] **Mock VR (the animation path in XR):** a walk under mock VR plays the
  VR profile's walk with the leg bones within 1.5 cm of the shipped avatar's.
- [ ] **XR body and hand replay:** the `walk-forward` and `crouch` body
  replays and the hand replay pass unchanged thresholds on the clip-less
  geometric fixtures, so retargeted clips do not disturb the solver or arm IK.
- [ ] **Other arm writers:** after pointing and releasing, and after a round
  trip through mock VR, the forearm, hand and fingertips return to the clip's
  pose within 1.5 cm.
- [ ] **Own clips win:** the shipped avatar, `mixamo-prefixed` and
  `duplicate-names` report `own` for all four states and pose like the shipped
  avatar; the shipped avatar's existing XR checks pass unchanged.
- [ ] **Report:** clip-less fixtures report `retargeted` for all four states;
  `t-pose` reports 54.7° on each upper arm, `a-pose` 9.7°, `t-pose-twisted`
  56.4° plus the forearm roll. The unmappable fixture, and a fixture loaded
  with a missing library, report locomotion off with exactly one `[avatar]`
  warning and no page error.
- [ ] **Export → upload → render:** a desktop walking take on a clip-less
  fixture (VRM) exports with animated leg tracks on its own bone names and
  `HOLOIM_humanoid`, uploads and renders in the feed and AR
  (`avatar-formats.pipeline.spec.ts` extended); the existing pipeline specs
  pass.
- [ ] **Real files:** a real VRM and a real Mixamo character without clips are
  checked by hand in the proof video; names and hashes recorded here.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Different local bone axes (reoriented, Z-up, VRM 0.x) turn a knee bend into a twist | Motion is transferred as a world-frame rotation in the facing-corrected root frame, never as local Euler; `reoriented-axes` and `z-up` pose checks. |
| T-pose or A-pose rest leaves arms out or too low | Limb swing correction to the source's rest direction; `t-pose`/`a-pose` wrist positions. |
| A rest with twisted forearms (palms forward) or arms off the side | Forearm and hand roll matched by the knuckle line; `t-pose-twisted` fingertips (mutation without the roll: 9.6 cm). |
| Leg correction changes the stance between idle (no leg tracks) and walk | Legs, feet, spine and head are never corrected. |
| Own clips for some states, library for others: arms pop between states and in crossfades | Per-avatar choice, never a mix. |
| A loose name match (`air` in "Hair") picks a clip that is not locomotion | Own clips must also have a rotation track on a canonical bone of this rig, and Idle and Walk must both exist. |
| Mirrored or non-uniformly scaled armature node | The retargeter throws; locomotion reported off. |
| Facing correction or armature scale (cm rigs) skews the frame | Rotations taken relative to the avatar root after `normalizeFacing`; `vrm0-minus-z`, `unreal-cm`, `z-up` fixtures. |
| Extra or missing intermediate bones (no `upperChest`, Unreal twist bones) | Non-canonical or source-less bones keep their rest local; FK through the real target parents. |
| Duplicate bone names bind tracks to a prop | Tracks bind by `uuid`; `duplicate-names` pose check. |
| Own clips present but named for another rig (RPM clips on a VRM) | Not usable: no track reaches a canonical bone of this rig; the library plays. |
| Duplicate names let a prop take the avatar's own clips | Own tracks are rebound to the canonical bone's uuid; `duplicate-names` keeps its clips and is compared with the shipped avatar. |
| Retargeted arm tracks fight arm IK or desktop pointing; the mixer writes a constant track only when its value changes | VR profile keeps only leg tracks; the point and mock-VR round-trip checks return the arm to the clip's pose. |
| Crouch, terrain legs or body solver read a pose the clip wrote | Same order as the shipped avatar (`BodyPoseSystem`); crouch comparison already in the `avatars` check. |
| Library missing, 404 or fails to bind | Locomotion reported off, one warning, avatar still loads; covered by loading with a bad library URL in the check. |
| Library drifts from `avatar.glb` (clips re-authored) | `test:avatars:bind` compares them. |
| Extra network fetch, or a slower load | Never fetched for the shipped avatar; fetched in parallel with any other avatar (28 KB). |
| Recorded take differs between desktop and export | Export samples node transforms per frame as today; the pipeline spec reads the animated legs. |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer | Lead (retargeting is Deep tier per `AGENTS.md`) | `apps/capture/src/animation/*`, `src/avatar/HumanoidSkeleton.ts` (report field), `src/runtime/createCaptureRuntime.ts` (library load, automation hook), `scripts/build-locomotion-library.mjs`, `public/gltf/animations/locomotion.glb`, `scripts/lib/avatar-fixtures.ts`, `scripts/check-avatar-bindings.ts`, `scripts/ci-avatar-formats-playwright.ts`, `apps/viewer-web/e2e/avatar-formats.pipeline.spec.ts` |
| Independent verifier | Codex (`-p standard`), a different vendor | Read-only verification; test artifacts only |

## Design decision

Design review (2026-10-29, `design-reviewer` subagent, Opus) found the
formula and frame correct and changed the plan as follows:

- **Per avatar, not per state.** The arm correction lives in the library's
  clips, so mixing an own Walk with a library Idle (or an own Idle the desktop
  filter empties) makes the arms pop, and crossfades blend toward the rest.
- **Arms only.** A leg correction would apply while walking but not at idle
  (whose leg tracks the desktop filter drops), so the stance would change at
  every stop.
- **Roll as well as swing.** The fixtures only rotated arms about one axis,
  which a swing undoes by construction. Fingertips join the comparison and
  `t-pose-twisted` adds an off-axis, palms-forward rest; the forearm and hand
  now match the knuckle line too.
- **Deterministic pose hook.** `__poseLocomotion` poses a state's clip at a
  clip time with nothing blended, so every fixture × state is compared without
  depending on physics timing; one physics-driven take per fixture still
  checks the state sequence.
- **Bone identity, not names,** for own clips (uuid rebinding) and the
  usable test; a guard for mirrored or uneven scale; a pointing-release and a
  VR round-trip check; the library prefetched in parallel.
- Not changed: the skeleton-only library GLB (kept over `avatar.glb` or a
  bespoke JSON format).

Alternatives considered:

- **Use `avatar.glb` itself as the source.** No generated asset, but a 1.8 MB
  fetch (textures and meshes) for every non-shipped avatar. The library is the
  same skeleton and clips at a few kilobytes, guarded against drift.
- **A canonical-bone JSON clip format.** Smaller still, but a bespoke format;
  a GLB source keeps the retargeter general (any bound rig with clips).
- **Local-space delta transfer** (`local = rest · Δlocal`). Breaks on any rig
  whose bone axes differ from the source's (half of slice 1's fixtures).
- **Change the target's rest pose at load** to put the arms down. Would move
  the measured bind pose the arm IK, hand fidelity and body solver rely on.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Identity, library sync | `pnpm --filter @holoim/capture run test:avatars:bind` (Node) | pending |
| Desktop poses, mock VR, report, own clips | `pnpm --filter @holoim/capture run test:xr:avatars` (`XR_AVATAR_BIND_ONLY=1` for the loop) | `output/ci-avatars/<fixture>-locomotion.json`; pending |
| XR body and hand replay | Same check (replays) | `output/ci-avatars/<fixture>/{hands,body}/*-report.json`; pending |
| Export → upload → render | `apps/viewer-web/e2e/avatar-formats.pipeline.spec.ts` in `test:smoke:pipeline` | `output/avatar-formats-viewer/*-report.json`; pending |
| No regression | `pnpm run verify:pr` | pending |
| Real files, proof video | Capture app with a real VRM and Mixamo character | proof video under `output/` (not committed); pending |

## Physical-device limits

Retargeting is deterministic and proven in emulation. In real XR the body
solver owns the legs on every rig it can drive, so the clips show on a headset
only through the animation path (mock VR here, or a rig the solver cannot
drive); how a retargeted walk looks on a headset is not separately
device-checked. In XR the VR profile carries no arm tracks, so a T-pose rig
whose hand is untracked keeps its arm at rest, as today (a relaxed-pose
fallback for `HandEmbodiment` is a possible later change). Real third-party rigs beyond the two checked by
hand remain a limit, as in slice 1.
