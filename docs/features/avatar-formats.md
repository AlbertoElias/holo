# Feature brief: Standard avatar formats

**Lead:** Claude Code (session 2026-10-25)
**Status:** Draft
**Layer:** Event (the recorded body; see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

An author can record with any common humanoid avatar (a Mixamo download, a
VRM 0.x or 1.0 model, an Unreal mannequin export, a Meta Movement SDK or Apple
ARKit body rig, or a Ready Player Me legacy export) by loading it with
`?avatar=<url>`. Its head, arms, hands, fingers, legs, crouch, walking and face
follow the author as they do on the shipped avatar. The hologram they upload
renders and frames correctly in the feed and in AR. An avatar the system cannot
map says so: it names what is missing and what that disables, instead of
silently losing its arms.

## Scope

**Included:**

- One canonical humanoid bone resolver. It maps any skeleton to the VRM 1.0
  humanoid bone set (`packages/meaning/src/humanoid.ts` today), in priority order:
  1. the file's own humanoid declaration: `VRMC_vrm.humanoid.humanBones`
     (VRM 1.0) or `VRM.humanoid.humanBones` (VRM 0.x), read from the glTF
     JSON by node index;
  2. per-standard name tables, matched case-insensitively after stripping
     namespaces (`mixamorig1:`, `Armature|`, `root/…/` paths) and known
     prefixes or suffixes;
  3. nothing else. There is no topology guessing in this feature (see
     Excluded).
- Name tables for Mixamo and Ready Player Me (the same names), VRM and Unity
  `HumanBodyBones` names (the same vocabulary as VRM 1.0), VRoid (`J_Bip_*`),
  Character Creator 4 (`CC_Base_*`), the Unreal UE4 and UE5 mannequin
  (`pelvis`, `spine_01`, `upperarm_l`, `index_01_l`, …), the Meta Movement SDK
  and OpenXR `XR_FB_body_tracking` joints (`SpineLower`, `LeftArmUpper`,
  `LeftHandIndexProximal`, `XR_BODY_JOINT_LEFT_ARM_UPPER_FB`, …), and the Apple
  ARKit body skeleton, which RealityKit and USDZ also use (`hips_joint`,
  `left_arm_joint`, `left_handIndex_1_joint`, …). The same canonical bone may
  come from several source bones (Unreal and ARKit have more spine bones than
  VRM). Each table states which bone wins.
- Every hardcoded bone lookup in capture goes through the resolver. That
  covers rig setup, arm and finger chains, crouch, the body solver's bind
  measurement, body samples, hand embodiment, the terrain leg solver,
  locomotion track filtering, objects and tray, pointing, debug views, and the
  face rig's head and eye bones. The inventory is in the design review notes
  below.
- Bind-pose normalization. At load, measure each mapped bone's rest
  direction in avatar space and derive:
  - the avatar's facing from its own skeleton (lateral = left minus right
    shoulder or hip, up = head minus hips). It is corrected to the rig's +Z
    convention, so a VRM 0.x model facing −Z stands the right way round
    without `avatarForwardOffset`.
  - anatomical axes per bone (the swing axis for crouch pitch, the palm frame
    for the hand grip offset, the elbow hint), computed from bone positions
    instead of assuming the shipped rig's local axes.
  - a per-bone correction to a canonical T-pose, so an A-pose rig and a
    T-pose rig retarget to the same pose.
- Locomotion clips on any avatar. When the loaded avatar has no usable
  Idle, Walk, Jump or Fall clip, the shipped avatar's clips are retargeted
  onto it through canonical bones and the T-pose correction. This keeps
  desktop 2D walking and jumping working.
- A binding report on the debug surface, like the face rig's report: the
  detected standard, matched and unmatched canonical bones, missing required
  bones, and which features are off (arm IK, fingers, crouch, body solver,
  locomotion, gaze). There is one console warning naming them.
- Export → upload → render. Exported holograms keep the source bone names
  (backward compatible) and add a small `HOLOIM_humanoid` glTF extension
  mapping canonical bones to node indices. viewer-web frames and anchors with
  that extension first, then the shared name resolver, then today's
  `RecordedAvatar`, `Hips` or `Head` lookup, so old uploads render as before.
- Fixture avatars, one per standard, generated deterministically at test
  time from the shipped `avatar.glb` (renamed bones, re-oriented bone axes,
  an A-pose bind, a VRM 0.x −Z variant, a VRM 1.0 file with arbitrary names
  and only the extension to map them, and an unmappable rig). They are
  written under ignored `output/`, so no avatar binaries are committed.

**Excluded:**

- Topology or heuristic bone guessing for rigs with no recognisable names
  and no humanoid declaration. They get the binding report and degrade
  safely.
- Loading `.vrm` features beyond the humanoid map: spring bones, VRM
  expressions as a source (the face standards already resolve VRM morph
  names), MToon materials, VRM look-at constraints, and first-person
  annotations.
- Native USDZ or FBX loading. Apple and Unreal rigs are supported as glTF
  exports carrying their names.
- An in-app avatar picker or upload UI. Selection stays on `?avatar=`.
- Phone-driven avatars (TODO item and IDEA-078). This feature is a
  prerequisite for them.
- Naturalness work on the solver (separate TODO item).

## Acceptance criteria

- [ ] Each generated fixture avatar (Mixamo prefixed, Unreal, VRoid, CC4,
  Meta Movement, ARKit, VRM 1.0 by extension, VRM 0.x facing −Z, A-pose,
  re-oriented bone axes) resolves every required VRM bone and all 30 finger
  bones, and its binding report says so.
- [ ] The recorded headset hand replay passes the hand fidelity thresholds
  (`lib/hand-fidelity.ts`) unchanged on every fixture that has fingers.
- [ ] One body replay fixture (`walk-forward`) passes the body fidelity
  thresholds (`lib/body-fidelity.ts`) unchanged on every fixture, including
  the A-pose, re-oriented and −Z variants.
- [ ] Desktop locomotion on a fixture with no clips of its own plays
  retargeted Idle and Walk. The canonical bones' avatar-space rotations stay
  within a stated tolerance of the shipped avatar's at sampled times.
- [ ] Crouch, face gaze and object grip work on the renamed and re-oriented
  fixtures (the existing `test:xr:face` and object checks run on one
  non-RPM fixture).
- [ ] An exported hologram from a non-RPM fixture keeps its source bone
  names and carries `HOLOIM_humanoid`. Through the real pipeline (capture
  export → API upload → viewer-web), the feed card and AR viewer find its hips
  and head anchor. An existing upload with no extension still renders as it
  does today.
- [ ] The unmappable fixture loads without throwing. The report lists its
  missing bones and disabled features, and one console warning names them.
- [ ] The shipped avatar's existing capture XR checks and the pipeline smoke
  test pass unchanged (no regression on the default rig).

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Two source bones claim one canonical bone (Mixamo `Index3` and `Index4`; Unreal `spine_03` to `spine_05`) | Each table states the winner; the resolver keeps the first by declared priority, never by traversal order. Fixture check. |
| A mesh or empty node carries a bone name (`Wolf3D_Head`, `EyeLeft`) | Only `Bone`s, or skin joints, are candidates; the face rig keeps its mesh lookup separately. |
| Duplicate bone names in one file (two `Hips` from an attached prop) | Prefer joints of the avatar's skinned meshes; report the ambiguity. |
| A case-insensitive match collides (`spine` vs `Spine`) | Tables are normalised once and checked for collisions at module load. |
| A VRM extension points at a node that is not a joint, or is out of range | Ignore that entry, fall back to names, and report it. |
| VRM 0.x axis flip (the model faces −Z) | Facing is derived from the skeleton, not the format; the −Z fixture proves it. |
| An A-pose bind changes arm IK rest, crouch and retargeted clips | T-pose correction per bone; the A-pose fixture runs body, hand and locomotion checks. |
| Bone local axes differ (Unreal X-along-bone, Blender Y-along-bone) | Anatomical axes come from bone positions; the re-oriented fixture runs every check. |
| An extra twist or roll bone sits between arm and forearm (Unreal `upperarm_twist_01_l`, Meta `LeftHandWristTwist`) | Chains use canonical bones and measure lengths between them; twist bones are left at rest. |
| Missing optional bones (no `upperChest`, no toes, no eyes, 3-bone thumb) | Optional set per feature; features degrade one at a time with the report. |
| Missing required bones | Each feature disables itself; the report names it; nothing throws. |
| Locomotion clips that target the shipped rig's names on a renamed rig | Retarget through canonical bones; root motion maps to the canonical hips. |
| Exported GLB loses the mapping, so viewer framing fails on Unreal names | `HOLOIM_humanoid` extension plus the shared resolver in viewer-web; pipeline test on a non-RPM fixture. |
| Old uploads without the extension | The viewer keeps today's name fallback; the existing pipeline spec runs unchanged. |
| The body solver measures bind after an animation already ran | It keeps measuring before clips attach (`createCaptureRuntime.ts` order); the normalization uses the bind skeleton, not the current pose. |
| Scale: centimetre rigs (Unreal 100×) or an armature scale node | Measure in avatar root space after load; the existing height adaptation sets the final scale. The Unreal fixture is exported at cm scale. |
| Generated fixtures differ from real assets | Fixtures exercise names, axes, pose and facing deterministically; a real third-party Mixamo and VRM file is checked by hand in the proof video and recorded as a remaining limit. |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code lead session | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent | Read-only review before implementation |
| Implementer | Lead, with scoped subagents per module | Resolver package, capture rig modules, viewer-web anchors, fixture generator and check |
| Independent verifier | Separate Claude agent (Codex is not installed in this environment; recorded as a gap from the different-vendor rule) | Read-only verification; test artifacts only |

## Design decision

Pending design review.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Fixtures resolve all bones | New `test:xr:avatars` check: generate fixtures, load each in capture, read the binding report | `output/ci-avatars/<fixture>-binding.json` — pending |
| Hand fidelity on each fixture | `test:xr:avatars` runs the recorded hand replay per fixture | `<fixture>-hand-report.json` — pending |
| Body fidelity on each fixture | `test:xr:avatars` runs `walk-forward` per fixture | `<fixture>-body-report.json` — pending |
| Retargeted locomotion | `test:xr:avatars` desktop walk on a clip-less fixture, compared with the shipped avatar | `<fixture>-locomotion-report.json` — pending |
| Crouch, gaze, grip on non-RPM rig | `test:xr:face` and object check with `?avatar=` set to one fixture | face/object reports — pending |
| Export → upload → render | Pipeline spec on a non-RPM fixture plus the unchanged existing spec | Playwright report — pending |
| Unmappable rig degrades safely | `test:xr:avatars` unmappable fixture | binding report and console capture — pending |
| No regression | `pnpm run verify:xr`, `pnpm run test:smoke:pipeline`, `pnpm run verify:pr` | pending |

## Physical-device limits

Mapping and retargeting are deterministic and need no headset to prove. The
remaining limit is real third-party assets: generated fixtures prove names,
axes, bind pose and facing, but not every exporter's quirks. A real Mixamo
download and a real VRM model are checked by hand in the proof video (not
committed). Hand and body feel on a physical headset stays with the existing
device checks in `HANDOFF.md`.
