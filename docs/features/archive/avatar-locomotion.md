# Feature brief: Natural locomotion and terrain response

**Lead:** Codex locomotion chat  
**Status:** Complete

## User outcome

Walking, crouching and jumping look continuous in desktop and XR, respond to actual collision-limited travel, and place inferred legs on nearby traversable geometry.

## Scope

**Included:** lower-body gait/crouch composition, speed-matched clips, airborne transitions, terrain foot placement, existing XR virtual movement input and Rapier wall/slope/step response, excluding proximity sensors from solid obstacles, deterministic browser evidence.  
**Excluded:** height calibration/scaling, new tracked-head/hand retargeting, new controller-input or room-scale root translation systems, shared contracts or export format changes; physical headset claims.

## Acceptance criteria

- [x] Walking cadence follows actual travel in desktop and VR, stops at a wall, and remains animated while crouched.
- [x] Jump transitions through ascent/descent/landing without restarting an airborne clip in midair.
- [x] Feet adapt independently to nearby walkable slopes/steps, with bounded correction; no airborne ground snapping or reaching overhead geometry.
- [x] Desktop and XR retain existing movement/crouch behavior and tracked-hand fidelity; export/upload/render pipeline passes.
- [x] Browser workflow records bone/foot samples, screenshots and deterministic evidence.

## Failure cases considered

| Failure | Prevention/evidence |
| --- | --- |
| Crouch overwrites gait every frame | Blend crouch onto animated bone rotations and assert moving crouched legs vary |
| VR walks at fixed cadence despite collisions | Use corrected motor speed for both profiles |
| Jump repeats takeoff while airborne | One-shot dedicated airborne clips, hold final pose |
| Stopped animation leaves accumulated procedural transforms | Restore previous procedural pose before mixer update |
| Foot IK sees ceiling or wall as floor | Bounded downward ray, upward normal, maximum climb angle, reach bound |
| Terrain IK changes tracked head/hands | Only leg chain bones; no hips/root translation or scale |
| Animation crosses frames with IK feedback | Restore animated local quaternions at start of each frame |
| Full extension/degenerate knee pole creates NaNs | Reach clamp, stable forward knee bend and epsilon guards |
| Wall causes walking in place | Corrected motor velocity with a 0.12 m/s animation deadzone; ramp/wall E2E |
| Tracked hand sensors block XR walking | Exclude sensors in motor movement and recovery queries; hands remain tracked in E2E |
| Height feature changes root metrics | Read avatarHeight/world matrices each frame; no calibration caches or scale writes |

## Ownership and compatible transform boundary

Locomotion owns `animation/LocomotionAnimator.ts`, narrow sensor-query flags in `physics/CharacterMotor.ts`, a new `animation/TerrainLegSolver.ts`, the `AvatarRig.applyCrouchPose` composition (not scaling/calibration), localized orchestration calls, and locomotion E2E coverage. Height adaptation owns avatar scale/calibration, eye metrics, root alignment and tracked pose transforms. Shared-file edits require integration preserving both features.

Frame order: restore last terrain corrections → motor/root alignment → animation mixer → crouch composition → terrain leg solver → existing tracked arm/hand embodiment → recording. Solver consumes avatar/world Object3D and current grounded state; modifies only upper-leg/lower-leg/foot quaternions. It never writes avatarRoot, hips, head/hands, motor dimensions, calibration state or export format. Geometry sampling uses world-space matrices so updated scales are consumed naturally.

| Role | Owner | Responsibility |
| --- | --- | --- |
| Lead / core implementer | Codex locomotion chat | Animation, motor sensor query, rig composition, terrain solver, integration |
| Design reviewer | `locomotion_design` independent agent | Initial plan and read-only source reviews, including XR-exit and sensor-query findings |
| Independent workflow verifier | `locomotion_e2e` agent | Original brief → real GLTF/character browser scenarios and inspectable artifacts, without changing core source |
| Final validation | Lead | Full gate, coordinate-frame correction, deterministic startup and airborne clip timing |

## Design review

Use existing Rapier collision/autostep/slope behavior rather than duplicate collision logic. Keep authored clips and compose crouch; add bounded analytic leg IK as a post-animation layer rather than rewrite the skeleton or add a physics ragdoll. Independent design review confirmed this plan and required restoring both crouch and terrain offsets before the mixer, preserving swing clearance, and applying one-shot behavior only to actual airborne clips (never walk/idle fallbacks).

## Test plan and evidence

Run `verify:agent` during edits, deterministic locomotion workflow on isolated port 5274, then `verify:pr` with reassigned runtime ports. Extend real browser workflow with sampled leg motion/contacts and transitions, not implementation-mirroring unit tests. Preserve hand replay and pipeline checks. Evidence: `verify:agent` passed; capture `verify:fast` passed; existing locomotion flow passed in 14.7 s. New desktop/IWER synthetic-GLTF ramp/wall workflow passed twice cold (17.3 s scenario time). Both profiles walk at ~1.399 playback scale and crouch-walk at ~1.050; crouched leg quaternion variation ~0.047 (not frozen). New test proves independent known-ramp contact heights, bounded finite leg transforms, original standing XR travel with tracked hands, wall idle, ascent/fall/landing, airborne contact release and crouched XR exit recovery within 35 mm. Final airborne non-restart assertions passed. Full pre-merge gate `verify:pr` **PASS** (exit 0): doctor, all lint/type checks/tests, production builds, capture→upload→viewer render pipeline, all capture XR scenarios, and both viewer AR cases. Final capture suite 56.7 s; viewer AR 2/2 in 20.4 s. Runtime ports: capture 5474, viewer 3474, API 3301, pipeline capture 5475. All capture XR checks passed together in 52.8 s. The new terrain evidence and full frame samples are byte-identical across cold starts: evidence `c2e922dfc65b553885d61ec05bdfedc88510b93ef3dcd53c8a55c21c7172adda`, samples `dd8b0b5e77dbad8bfe636f7163e0c61e1912e38ff5f6fcb88f42a0c2045fd425`.

Committed artifacts: [measured evidence](../evidence/avatar-locomotion.json) and [desktop terrain screenshot](../evidence/avatar-locomotion-desktop.png). Full generated samples and screenshots live in `apps/capture/output/ci-terrain-locomotion/` and are recreated by the scenario.

The workflow exposed and fixed two pre-existing defects: bind-pose crouch erased gait, and hand sensor volumes blocked XR virtual movement. It also caught the procedural-layer XR-exit regression before integration. An initial spawn-clearance experiment did not fix the sensor issue and was reverted.

The original cardinal movement check now counts its first real input sample. After sensor collision was corrected, some default-scene paths walk off a ledge before later samples; the original check incorrectly discarded the observed walk and required the falling samples to report walk.

### Tracking check coordinate frame

Excluding sensors exposed that the mock finger-dropout check compared world fingertip positions across 3.8 mm of avatar settling. It now compares wrist-relative fingertip positions with the original 2 mm limit, and independently requires wrist-to-target residual recovery within 2 mm. Measured finger and wrist-residual recovery are both 0.00 mm. Existing pinch, quaternion, sensor and real XRHand replay checks remain in the gate; retargeting source is unchanged.

### Height integration notes

When merging `codex/xr-height-adaptation`, retain its meter-to-parent-local crouch translations and ground-lift conversion while preserving this feature's additive pose capture/restore. Keep its calibration before crouch/motor and camera update before tracked hands; terrain adaptation belongs before camera/hands. This solver consumes current world lengths and never scales the root or tracked targets.

## Physical-device limits

IWER establishes deterministic WebXR behavior and retargeting compatibility, not physical-headset tracking feel, comfort or performance. Physical headset evaluation remains required, including physical-hop interaction with the existing upward head-height crouch baseline. This change animates the existing XR virtual movement inputs; it does not add controller bindings or room-scale root following.
