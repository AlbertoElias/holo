# Feature brief: Standard avatar formats

**Lead:** Claude Code (session 2026-10-25)
**Status:** Complete (slice 1, 2026-10-27); slice 2 queued in `TODOS.md`
**Layer:** Event (the recorded body; see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

An author can record with any common humanoid avatar (a Mixamo download, a
VRM 0.x or 1.0 model, an Unreal mannequin export, a Meta Movement SDK or Apple
ARKit body rig, a 3ds Max Biped rig, or a Ready Player Me legacy export) by
loading it with `?avatar=<url>`. Its head, arms, hands, fingers, legs, crouch
and face follow the author as they do on the shipped avatar. The hologram they
upload renders, faces and frames correctly in the feed and in AR. An avatar the
system cannot map says so: it names what is missing and what that disables,
instead of silently losing its arms.

## Slices

| Slice | Delivers | Status |
|---|---|---|
| 1 | Resolver, every capture lookup routed through it, binding report, the four axis-assumption fixes, skeleton-derived facing, `HOLOIM_humanoid` export, viewer-web anchors via the resolver, fixtures and the `avatars` check | Complete (2026-10-27) |
| 2 | Locomotion clips retargeted onto avatars without their own Idle, Walk, Jump or Fall, with the per-bone T-pose correction that needs | Not started |

The design review found that arm IK, finger retargeting and the body solver
already work in avatar space against the measured bind pose
(`toBindAimInParent`, direction-mapping finger chains, `setFromUnitVectors`
on bind hips→head, the knuckle-built `palmInHand`). An A-pose bind therefore
needs no T-pose correction for them. Only clip retargeting does, so it is
slice 2. Until then, an avatar without usable clips shows "locomotion: off"
in its report and walks with the procedural legs, or stands still on desktop.
That is honest degradation and keeps the XR recording outcome intact.

## Scope (slice 1)

**Included:**

- **One canonical resolver** in `@holoim/meaning`, kept free of three.js.
  Both apps already depend on that package, and `HOLOIM_meaning` already
  uses `VrmHumanoidBone`.
  - Input: the candidate nodes `{name, isJoint, nodeIndex}[]` plus any
    humanoid maps from the glTF JSON. Output: canonical bone → node, the
    detected standard, and what did not match.
  - Each app has a thin three adapter. Capture's adapter maps node indices to
    objects with `gltf.parser.associations`, never by name.
  - Priority order:
    1. the file's own declaration: `VRMC_vrm.humanoid.humanBones` (VRM 1.0),
       `VRM.humanoid.humanBones` (VRM 0.x), or `HOLOIM_humanoid` (our
       export);
    2. per-standard name tables;
    3. nothing else (no topology guessing).
  - Names are matched as three.js sanitizes them: `GLTFLoader` runs
    `PropertyBinding.sanitizeNodeName`. So `mixamorig1:Hips` arrives as
    `mixamorig1Hips`, Blender's `Hips.001` as `Hips001`, and
    `Bip01 L UpperArm` as `Bip01_L_UpperArm`. Raw names from the JSON are
    sanitized the same way before matching. Matching is case-insensitive
    after normalization, and the tables are checked for collisions when the
    module loads.
- **Name tables:**
  - Mixamo and Ready Player Me (the same names, with any `mixamorig\d*`
    prefix)
  - VRM 1.0 and Unity `HumanBodyBones` (the same vocabulary)
  - VRoid (`J_Bip_C_Hips`, `J_Bip_L_UpperArm`, …)
  - Character Creator 4 (`CC_Base_*`)
  - 3ds Max Biped (`Bip01 Pelvis`, `Bip001 L UpperArm`, …)
  - the Unreal UE4 and UE5 mannequin (`pelvis`, `spine_01..05`,
    `clavicle_l`, `upperarm_l`, `index_01_l`; twist bones ignored)
  - the Meta Movement SDK and OpenXR `XR_FB_body_tracking` joints
    (`SpineLower`, `LeftArmUpper`, `LeftHandIndexProximal`,
    `XR_BODY_JOINT_LEFT_ARM_UPPER_FB`)
  - the Apple ARKit body skeleton, which RealityKit and USDZ also use
    (`hips_joint`, `left_arm_joint`, `left_handIndex_1_joint`)

  When several source bones can fill one canonical bone (Unreal and ARKit
  spines; a Mixamo finger's end site), each table states which wins. The
  resolver never picks by traversal order.
- **Every capture lookup goes through the resolver.** That is about 32
  sites:
  - `AvatarRig` setup, the arm and finger chains, crouch, and the head and
    eyes
  - `VrBodySolver.measureBindPose` and the `BodyTracking` samples
  - the `HandEmbodiment` joint→bone map and its debug bones
  - the `TerrainLegSolver` leg scan and the `LocomotionAnimator` track
    filter (by canonical bone, not by name suffix)
  - `ObjectInteraction` and `ObjectTray` hands
  - `PointResolver`, `DiagnosticViews`, and the `FaceRig` head and eye bones

  Mesh lookups such as the face rig's eye meshes and head-mesh hiding stay
  as they are.
- **Four axis-assumption fixes**, each computed once at bind:
  - **Crouch** (`AvatarRig.ts:214`, `:783`): each bone pitches about its
    swing axis, the avatar's lateral axis in that bone's bind-local frame,
    instead of local X.
  - **Hand grip offset** (`AvatarRig.ts:422-424`): built from `palmInHand`.
    A rig without fingers falls back to the forearm→hand direction plus
    avatar-down, and the report names the fallback. This is the same
    palm-down assumption as `DesktopPointAction.ts:118-121`, which uses the
    same frame.
  - **Elbow hint** (`AvatarRig.ts:443`): defined in avatar space (lateral,
    down, back) and converted to local space at bind.
  - **Leg IK `BIND_FORWARD`** (`body/legIk.ts:13`): expressed in avatar
    space after facing correction.
- **Skeleton-derived facing:**
  - Lateral comes from left minus right upper arm, falling back to upper
    legs. Up is head minus hips.
  - Forward is cross-checked against hips→toes. Yaw is snapped to the
    nearest 90°. The up axis is snapped too when head→hips is not vertical
    (lying-down or Z-up exports).
  - When toes and left/right disagree (a mirrored or mislabelled rig), the
    report says so and the rotation is not applied.
  - The correction sits on a node inside the subtree `GltfExportComposer`
    clones (it overwrites the cloned root's quaternion at lines 64-73).
  - `avatarForwardOffset` keeps today's meaning, applied after
    normalization, so existing URLs and fixtures are unchanged.
- **Binding report** on the debug surface, like the face rig's report:
  - the source (declaration or table) and the detected standard
  - matched, unmatched and missing-required bones
  - ambiguities, the facing correction applied, and the grip fallback
  - features off: arm IK, fingers, crouch, body solver, locomotion, gaze

  There is one console warning naming the missing bones and disabled
  features.
- **Export:**
  - Exported holograms keep source bone names, so existing GLBs stay
    backward compatible.
  - They add `HOLOIM_humanoid` in the same shape as VRM,
    `{humanBones: {hips: {node}, …}}`, so one parser reads all three. It is
    listed in `extensionsUsed` only, never `extensionsRequired`, and node
    indices come from `writer.nodeMap` as in `GLTFMeaningPlugin`.
  - Tracks are keyed by bone identity, not by name, so a file with
    duplicate bone names no longer drops tracks (`GltfExportComposer.ts:81`
    and the frame store).
- **viewer-web:**
  - Anchors are found by `HOLOIM_humanoid` first, then by the shared
    resolver on node names, then by today's lookup, all within the
    `RecordedAvatar` scope so a prop's `Head` cannot take over.
  - This touches `HologramCardCanvas.tsx` and the scene normalizer. The
    active `feature/viewer-xr-interface` branch moves that normalizer into
    `features/hologram/hologramScene.ts`, so this step lands on top of that
    branch once it merges, never as a parallel edit.
  - The USDZ converter is checked with a non-RPM export.
- **Fixtures**, generated deterministically at test time from the shipped
  `avatar.glb` by a script using `@gltf-transform/core`. They are written to
  ignored `output/`, so no avatar binaries are committed.
  - **Renamed:** Mixamo-prefixed (`mixamorig1:`), Unreal at cm scale with
    generated twist bones and `spine_01..05`, VRoid, CC4, Biped, Meta
    Movement and ARKit.
  - **Declared:** a VRM 1.0 file with arbitrary bone names that only its
    extension maps.
  - **Geometric:**
    - **Re-oriented bone axes:** the exact transform needs no re-skinning.
      For each joint, with correction C, local rotation r' = C_parent⁻¹·r·C
      and translation t' = C_parent⁻¹·t, the inverse bind matrix becomes
      IBM' = C⁻¹·IBM, and the same applies to animation keys and to non-joint
      children of bones. A Node check proves the skinned vertices are
      identical to 1e-5.
    - **A-pose:** the cheap route changes only the arm rest rotations and
      leaves the inverse bind matrices. The mesh renders in A-pose and the
      app measures bind from node transforms. A guard asserts no
      `skeleton.pose()` call exists.
    - **VRM 0.x:** faces −Z.
    - **Z-up:** a root rotation and scale.
  - **Negative:** unmappable names, and duplicate bone names.

**Excluded:**

- Locomotion clip retargeting and the T-pose correction (slice 2).
- Topology or heuristic bone guessing for unrecognisable rigs. They get the
  report and degrade safely.
- `.vrm` features beyond the humanoid map: spring bones, MToon, look-at
  constraints, first-person annotations. VRM morph names already resolve
  through `@holoim/avatar-face`.
- Native USDZ or FBX loading. Apple and Unreal rigs are supported as glTF
  exports carrying their names.
- An in-app avatar picker or upload UI. Selection stays on `?avatar=`.
- Phone-driven avatars (IDEA-078) and solver naturalness work (separate
  TODO items).

## Acceptance criteria (slice 1)

- [x] **Bind:** every fixture except the negative ones resolves every
  required VRM bone and all 30 finger bones. The binding reports are checked
  in Node, without a browser.
- [x] **Shipped avatar unchanged:** its binding report is stable, and its
  existing hand, body, face, object and height checks pass with reports
  within their current thresholds.
- [x] **Hand replay:** the recorded headset hand replay passes
  `lib/hand-fidelity.ts` thresholds unchanged on the geometric fixtures
  (re-oriented, A-pose, −Z, Z-up) and the cm-scale Unreal fixture.
- [x] **Body replay:** the `walk-forward` body replay passes
  `lib/body-fidelity.ts` thresholds unchanged on the same fixtures, including
  crouch. Added in implementation: every non-negative fixture's standing and
  desktop-crouched bones (the crouch pose, which runs without body tracking)
  land within 1.5 cm of the shipped avatar's, because the VR body replay
  never exercises the crouch pose.
- [x] **Face and objects:** face gaze and the object grip work on non-RPM
  rigs (the existing face and object checks run with `?avatar=`). Amended:
  the Unreal fixture has no eye bones, so gaze has nothing to turn there; the
  face check runs on the VRM 0.x −Z fixture instead (non-RPM, with eyes, and
  through the facing correction). The object grip runs on the re-oriented and
  the Unreal fixtures.
- [x] **Export → upload → render:** an export from a non-RPM fixture keeps
  its source names and carries `HOLOIM_humanoid`. Through the real pipeline,
  the feed card and AR viewer find its hips and head, and `HOLOIM_meaning`
  bone anchors still resolve. An upload without the extension renders as
  today. Evidence: `avatar-formats.pipeline.spec.ts` (below). The Unreal
  export without its extension renders and finds the same bones through the
  name tables; old Ready Player Me uploads keep the unchanged
  `capture-to-viewer` spec, and the verifier found their anchors identical
  to the old lookups.
- [x] **Facing:** an exported −Z fixture renders facing the same way as its
  recording in the feed and AR, judged from a numeric yaw in the report.
  Evidence: the same spec; recorded −180.0°, feed and AR −180.0°. With the
  facing correction removed from the export, it fails with
  "feed: faces as recorded (0.0° vs -180.0°)".
- [x] **Duplicate names:** a fixture with duplicate bone names exports
  without losing tracks.
- [x] **Unmappable rig:** the unmappable fixture loads without throwing. Its
  report lists the missing bones and disabled features, and one console
  warning names them.
- [x] **No pose reset:** no `skeleton.pose()` call exists in capture or
  viewer-web.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| three.js sanitizes names (`mixamorig1:Hips` → `mixamorig1Hips`, `Hips.001` → `Hips001`, spaces → `_`) | The resolver normalizes sanitized and raw names the same way; the Mixamo-prefixed and Biped fixtures prove it. |
| Two source bones claim one canonical bone (Mixamo `Index3` and `Index4`; Unreal `spine_03` to `spine_05`) | Declared winner per table, never traversal order. Node check. |
| A mesh or empty node carries a bone name (`Wolf3D_Head`, `EyeLeft`) | Only skin joints and `Bone`s are candidates. |
| Duplicate bone names (a prop with its own `Hips`) | Prefer joints of the avatar's skinned meshes; report the ambiguity; export keys tracks by identity. Duplicate-name fixture. |
| Case-insensitive collisions inside or across tables | Collision check at module load. |
| A declaration points at a non-joint or out-of-range node | Ignore that entry, fall back to names, report it. |
| VRM 0.x faces −Z; a Z-up export; a slightly asymmetric rest pose | Facing from the skeleton, snapped to 90°; −Z and Z-up fixtures. |
| Mirrored or mislabelled left/right | Toe cross-check; reported, not applied. |
| Shoulders missing | Lateral from upper legs. |
| Bone local axes differ (Unreal X-along-bone, Blender Y-along-bone) | The four fixes use avatar-space axes; re-oriented fixture runs hand and body replays. |
| An A-pose bind | Chains work against measured bind; A-pose fixture runs hand and body replays. |
| Twist or extra spine bones between canonical bones | Chains span canonical bones; twist bones stay at rest; Unreal fixture generates them. |
| Missing optional bones (no `upperChest`, toes, eyes; 3-bone thumb) | Optional set per feature; features degrade one at a time with the report. |
| Missing required bones | Feature disables itself; report and one warning; nothing throws. Unmappable fixture. |
| Locomotion clips target names the rig lacks | Slice 1: tracks are filtered by canonical bone; unmatched clips are reported, and locomotion is off. Slice 2 retargets. |
| Exported GLB loses the VRM mapping | `HOLOIM_humanoid`; viewer reads it first. |
| Old uploads without the extension | Viewer keeps today's fallback; existing pipeline spec unchanged. |
| Something starts calling `skeleton.pose()` and snaps an A-pose rig to its inverse bind matrices | Guard check. |
| The facing correction is lost on export | It sits inside the cloned subtree; −Z export yaw check. |
| Centimetre rigs (Unreal 100×) or an armature scale node | Measure in avatar root space; height adaptation sets final scale; cm-scale Unreal fixture. |
| Generated fixtures share the shipped rig's proportions and single skin | Real third-party Mixamo and VRM files are checked by hand in the proof video; their names and hashes are recorded below as a remaining limit. |
| CI cost of per-fixture replays | Renamed fixtures are checked in Node only; replays run only on 5 geometric fixtures in one `avatars` check with a `CHECK_COST` entry. |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code lead session | Brief, integration, `@holoim/meaning` resolver contract, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Done 2026-10-25; read-only |
| Implementer | Lead and scoped subagents, one module each | Resolver; capture rig modules; export; viewer-web anchors (after `feature/viewer-xr-interface` merges); fixture generator and `avatars` check |
| Independent verifier | Separate Claude agent. Codex is not installed in this environment, so the different-vendor rule is not met; recorded as a gap. | Read-only verification; test artifacts only |

## Design decision

The design review on 2026-10-25 by the `design-reviewer` subagent changed
the draft as follows:

- **Sliced.** Clip retargeting and the T-pose correction moved to slice 2,
  because the IK paths already work against the measured bind pose.
- **Resolver location.** It stays in `@holoim/meaning` as a pure,
  three-free module with per-app adapters, rather than going into a new
  package.
- **Name matching.** Names are matched as three.js sanitizes them, and 3ds
  Max Biped was added.
- **Declared bones.** VRM and `HOLOIM_humanoid` entries resolve by node
  index through `parser.associations`.
- **Axes.** The draft's generic per-bone "anatomical axes" framework was
  replaced with fixes at the four known sites.
- **Facing.** It snaps to 90°, cross-checks against the toes, and sits
  inside the exported subtree. `avatarForwardOffset` keeps its meaning.
- **Export extension.** `HOLOIM_humanoid` takes the VRM shape and goes in
  `extensionsUsed` only. Export keys tracks by bone identity.
- **Fixtures.** The fixture construction is specified (exact axis
  re-orientation; the cheap A-pose route with a `skeleton.pose()` guard).
- **CI cost.** Renamed fixtures are checked in Node only. Replays run only on
  the geometric fixtures.
- **Criteria added:** a stable shipped-avatar report, exported facing yaw,
  duplicate names, `HOLOIM_meaning` anchors on a non-RPM export, and no
  `skeleton.pose()`.

The review also asked that slice 1 wait for the other "Verifying" features
that touch `AvatarRig`, `VrBodySolver` and the viewer. Their code is already
on `main`; they are waiting only on device checks, so nothing blocks.

The one live overlap is `feature/viewer-xr-interface`, active on 2026-10-25,
which moves the viewer's anchor lookup. The viewer step is sequenced after it.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Bind (all fixtures) | `pnpm --filter @holoim/capture run test:avatars:bind` (Node) | `output/ci-avatar-bindings/<fixture>-binding.json`; 16/16 pass, fixtures byte-identical across two generations |
| Re-orientation is exact | Same check: skinned vertices before and after | max vertex error ≤ 1.5e-7 m |
| Shipped avatar unchanged | `pnpm --filter @holoim/capture run test:xr` | all 9 checks pass on the final code |
| In-app binding, facing, crouch pose | `pnpm --filter @holoim/capture run test:xr:avatars` | `output/ci-avatars/<fixture>-humanoid.json`, `avatars-report.json`; worst pose difference 0.92 cm (`unreal-cm`), every other fixture 0 cm; −Z fixture corrected by 180° yaw |
| Hand and body replay on geometric fixtures | Same check (re-oriented, A-pose, T-pose, −Z, Z-up, Unreal cm) | `output/ci-avatars/<fixture>/{hands,body}/*-report.json`; all pass unchanged thresholds |
| Face and objects on a non-RPM rig | Same check: face on `vrm0-minus-z` (Quest Pro server), objects on `reoriented-axes` and `unreal-cm` | `output/ci-avatars/<fixture>/{face,object}/`; pass |
| `HOLOIM_humanoid` export; duplicate names | Same check: export from `vrm0-minus-z`, `unreal-cm`, `duplicate-names` | declares every required bone on the fixture's own node names; no node path animated twice; hips animated |
| Unmappable rig | Same check | 15 missing bones; crouch, body solver and arm IK reported off; exactly one `[avatar]` warning |
| No `skeleton.pose()` | Guard in `test:avatars:bind` | pass |
| Export → upload → render, facing, meaning anchors in viewer-web | `apps/viewer-web/e2e/avatar-formats.pipeline.spec.ts` (in `test:smoke:pipeline`): records `unreal-cm` and `vrm0-minus-z` in the capture app, uploads to the real API, reads the feed card and immersive AR; the Unreal export again without `HOLOIM_humanoid`; a desktop pointing take on the Unreal rig | `output/avatar-formats-viewer/<fixture>-report.json`: hips and head from `holoim` under the fixture's own names (`pelvis`/`head`, `Hips`/`Head`) in feed and AR; recorded yaw −180.0°, feed and AR −180.0°; without the extension `names` finds `pelvis`; both pointing links light from `index_03_r_end`. Mutation: export without the facing correction fails at 0.0° vs −180.0° |
| No regression | `pnpm run verify:pr` | 2026-10-25 (capture side): doctor, check:all, every unit suite, build:all, knowledge, smoke pipeline (8/8, with the USD converter installed) pass; `test:portal` fails one spec that fails identically on `main` (B-022); `test:xr:smoke` (run separately after it) passes. 2026-10-27 (after merging `main` and the viewer step): doctor, check:all, unit suites, build:all, knowledge and the smoke pipeline (13/13) pass; `test:portal` fails three phone specs (tilt, B-022, and the freeze and drag swipes) that fail identically on `origin/main` in this container; SMOKE_RESULT |

Independent verification (2026-10-25, a separate Claude agent; the
different-vendor rule is not met, as recorded under Ownership): nothing
blocking. Its findings and their outcomes:

- Fixed: a rig without finger bones fell back to the shipped rig's hand
  axes for the grip. The palm is now estimated from the forearm → hand line
  and the avatar's forward (11.6° from the knuckle-built palm on the
  shipped, re-oriented, A-pose and T-pose rigs). The new `no-fingers`
  fixture (re-oriented axes, finger joints renamed) runs the object grip.
- Fixed: Blender suffixes after a digit (`Spine1.001`), stacked prefixes
  (`Armature|mixamorig:Hips`), Meta's `FullBody_` and HumanIK's
  `Character1_` prefixes; a malformed `HOLOIM_humanoid` now falls through
  to `VRMC_vrm`. Covered in `humanoidRig.test.ts`.
- Fixed in the checks: a bone missing from a pose sample fails; the face
  step fails when it cannot run; the duplicate-names export fails if the
  declared hips or head sits under the prop; `test:avatars:bind` no longer
  deletes the in-app evidence.
- Not changed (notes): declared bones must be skin joints (VRM does not
  require it; no real file seen that needs it); `headTip` can pick a hair
  bone on VRoid-style rigs (only `body-fidelity` reads it); Rigify `DEF-`
  names are not mapped.

Independent verification of the viewer step (2026-10-27, a separate Claude
agent; no other vendor's agent is installed in this environment, so the
different-vendor rule is again not met): nothing blocking. It loaded the
real exports in Node, cloned them as the viewer does and resolved anchors
under bad declarations, missing associations, props with their own
`Hips`/`Head` and plain GLBs. It found no remaining bone-name lookup in
`apps/viewer-web/src` outside the resolver's legacy fallback. Findings and
outcomes:

- Fixed: a malformed declaration with a negative node index could reach a
  synthetic id when the loader keeps no associations. Declarations now take
  only `node >= 0` (`humanoidRig.test.ts`).
- Fixed: the anchor scope check walked the parent chain per candidate; it
  is now one pass (once per load, never per frame).
- Changed behavior, intended: a plain GLB (no `RecordedAvatar`) with an
  Unreal, VRoid, CC4, Biped, ARKit, VRM 1.0 or prefixed Mixamo rig is now
  placed under its hips, as Ready Player Me and Mixamo files always were,
  instead of under its root. A prop with its own `Hips` inside the avatar
  no longer takes over the card's framing.
- Not changed (notes): the AR yaw is read in the hologram's own frame, so it
  re-checks the file as cloned, not the placement turn (the feed reading
  proves the same facing); `avatar-fixtures.ts` imports `@holoim/meaning`'s
  source by relative path, as `pointing-desktop-take.ts` already does,
  because the pipeline job runs Playwright without building workspace
  packages; e2e specs sit outside every tsconfig (unchanged).

Defects the checks found during implementation, all fixed:

- The face and crouch used the `HumanoidFacing` node's frame as the
  avatar's +Z-forward frame. That node's own frame is the file's; its parent
  is the corrected one. On the −Z fixture the eyes turned the wrong way and
  the crouch folded the body 73 cm off (proved by reverting the fix under
  the new pose comparison).
- `FaceRig` measured the eye pivot from skinned vertices without the skin,
  so a rest pose that differs from the inverse binds put it 22 cm off.
- Rigs without eye bones (Unreal, Biped) had no viewpoint anchor and turned
  the body solver off; the anchor is now estimated from the head.
- The object check found the hand in the export by the RPM name; it now
  reads `HOLOIM_humanoid` first.

## Physical-device limits

Mapping and the axis fixes are deterministic and need no headset to prove.
The remaining limit is real third-party assets: generated fixtures prove
names, axes, bind pose and facing, but not every exporter's proportions,
skins or quirks. A real Mixamo download and a real VRM model are checked by
hand in the proof video (not committed). Their names and hashes are recorded
here when run. Hand and body feel on a physical headset stays with the
existing device checks in `HANDOFF.md`.

A rig whose rest pose is a T-pose stands with its arms out on desktop
(seen in the proof video): without tracking, the arms keep the rest pose,
and the clips' arm tracks are slice 2's T-pose correction. In XR the arm IK
drives the arms from the measured bind pose, so recordings are unaffected.

## Handoff state (2026-10-27)

- Slice 1 is complete and merged to `main` with the viewer step: viewer-web
  resolves the author's bones through `features/hologram/humanoidAnchors.ts`
  (`HOLOIM_humanoid` or a VRM declaration by node index, then the
  `@holoim/meaning` name tables, then the legacy Ready Player Me names,
  within `RecordedAvatar`) for the feed card's framing, the R3F AR model and
  the IWSDK viewer.
- Real files checked by hand (2026-10-25) in the capture app: three.js's
  Mixamo `Xbot.glb` binds by names (mixamo) and pixiv's
  `VRM1_Constraint_Twist_Sample.vrm` by its `VRMC_vrm` declaration; both
  bind 54 bones with no required bone missing, no facing correction and no
  feature off. The VRM keeps its T-pose arms on desktop (see the limit
  above).
- Environment notes: the smoke pipeline's USDZ step needs `USDZ_PYTHON`
  pointing at a venv with `apps/viewer-api/tools/requirements.txt`; this
  container had Node 22 and a newer Chromium than the pinned Playwright
  expects (run with `PLAYWRIGHT_BROWSERS_PATH` at symlinks named for the
  pinned builds).
- Next: slice 2 (locomotion clips retargeted onto avatars without their own
  clips, with the T-pose correction), queued in `TODOS.md`.
