# Feature brief: IWSDK runtime prototype

**Lead:** Codex  
**Status:** Complete

## User outcome

Evaluate IWSDK as capture's runtime foundation with a runnable, isolated prototype
and inspectable compatibility evidence. The production refactor waits until the
locomotion and height-calibration sessions finish.

## Scope

**Included:** IWSDK 1.0.1 in this worktree, a separate capture entry point using
`World` for scene, renderer, player origin, frame scheduling and XR lifecycle;
reuse existing avatar/physics/recording algorithms; expose avatar state through
native ECS tools; exercise deterministic hand replay and GLB compatibility.

**Excluded:** production migration, rewriting the animator/motor/retargeter,
merging other sessions' unfinished changes, replacing Rapier with Havok, viewer
runtime migration, claiming performance improvements from desktop emulation.

## Acceptance criteria

- [x] Default capture still runs without selecting the prototype.
- [x] Prototype uses one IWSDK World/renderer/animation loop and enters/exits XR.
- [x] Existing desktop movement, hand replay, and recording work in the prototype.
- [x] Native ECS tools find avatar state, pause/step it and diff snapshots.
- [x] A recorded GLB loads with animation and can pass the viewer pipeline.
- [x] Repeatable commands produce JSON and screenshot evidence and list limits.

## Failure cases considered

| Failure case | Prevention or evidence |
| --- | --- |
| Two render loops or two simulation clocks | World owns scheduling; explicit manual stepping path |
| SDK origin double-applied to head/hands | Keep one camera parent; run existing hand replay fidelity checks |
| ECS pause does not pause avatar simulation | Run avatar update as a native system and verify step/snapshot deltas |
| SDK and custom locomotion both move player | SDK locomotion and physics disabled; existing motor remains owner |
| Prototype masquerades as completed refactor | Document retained compatibility layer and deferred deletion work |
| SDK version/module identity breaks GLTF rigs | Shared Three build; structural rig checks; build/typecheck/replay |
| Recording samples before avatar update or export loses animation | Existing sampling order and capture-to-viewer workflow |
| Other sessions' runtime disrupted | Dedicated worktree and reassigned ports; no production merge |
| Measurements mistaken for device performance | Label desktop diagnostics; physical Quest comparison deferred |

## Ownership

| Role | Owner | Files or modules |
| --- | --- | --- |
| Lead / implementer | Codex | Prototype entry/adapter, minimal injection seams, dependency changes, brief |
| Design reviewer | Separate read-only reviewer | Plan and boundary review |
| Independent verifier | Separate read-only verifier | Acceptance checks and output artifacts only |

## Design decision

Design review required a single render owner, native ECS simulation ownership,
fixed-delta recording timestamps, and independent pause/step counters.

Start by giving World lifecycle ownership while retaining the existing
orchestrator as an explicit temporary compatibility layer. Do not count that
layer as code simplification. Native components expose meaningful avatar state;
this spike establishes feasibility and debugging value before the later refactor
splits product systems and deletes duplicated infrastructure.

## Test plan and evidence

| Criterion | Workflow | Evidence |
| --- | --- | --- |
| Compatibility and ECS | `test:iwsdk:prototype` | PASS after audio fix: actual simulation and recording pause; one frame and 1/60 second per step; VR exit/re-entry; one app canvas |
| Input fidelity | Existing IWER hand replay against prototype entry | PASS: 244 frames, 100% XRHand, max mean curl error 8.59 degrees, zero-frame lag, 99.59% pinch agreement |
| Export / playback | Existing capture-to-viewer pipeline against prototype entry | PASS: real microphone/GLB export, API upload, animated viewer, independent USDZ validation and six source-derived challenges |
| Static checks | `pnpm run verify:agent`, `doctor`, capture build | PASS; TypeScript 7 native compiler, lint and existing workspace tests |
| Default runtime regressions | `pnpm run verify:xr` with isolated ports | PASS: capture mock-VR, locomotion and hands; viewer AR placement/recenter/exit and hit-test fallback |

## Result and retained limitations

The isolated spike is complete; no production migration or merge is authorized
by that completion. The production refactor is queued after locomotion and height
work, with details in [the prototype guide](../../IWSDK_RUNTIME_PROTOTYPE.md).
Durable evidence: [independent verification](../../evidence/iwsdk-runtime-prototype/verification.md),
[native runtime](../../evidence/iwsdk-runtime-prototype/native-runtime.json),
and [hand replay](../../evidence/iwsdk-runtime-prototype/hand-replay.json).

The new replay exposed an unused SDK AudioListener whose wall clock produces
negative WebAudio ramp times after the test clock resets. Unregistering SDK
spatial playback and detaching its listener fixes replay; capture microphone
recording remains unchanged and passed the real pipeline. UIKit was also aligned
and deduplicated after Vite selected an older build without the required schema
exports. No fidelity thresholds or production algorithms were changed.

The adapter retains the orchestrator and does not establish smaller architecture
or better performance. SDK spatial playback, AR spectator/recenter, optional
hand-replay spectator video, full outer MCP/editor transport, and production
bundling of the prototype entry were not evaluated. World still draws released
frames while legacy replay skips capture's own drawing. Existing pipeline audio
and animation durations differ because its microphone uses wall time while its
animation clock is stepped; this result does not prove audiovisual sync.

## Physical-device limits

This spike uses IWER. Height-calibration integration must be retested after the
separate height/locomotion branches land. Quest CPU/GPU frame times, input latency,
memory, tracking feel and device lifecycle remain unmeasured; none are inferred
from desktop screenshots or frame timings.
