# WebXR GLTF Viewer (Three.js + TypeScript)

Minimal WebXR project using Three.js that loads a scene GLB and an avatar GLB.

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start dev server with automatic refresh:

```bash
npm run dev
```

3. Open the printed local URL (usually `https://localhost:5173`).

## Default assets

The app now defaults to:

- `/gltf/models/scene.glb`
- `/gltf/models/avatar.glb`

You can override with URL params:

- `scene`: `https://localhost:5173/?scene=/gltf/models/my-scene.glb`
- `avatar`: `https://localhost:5173/?avatar=/gltf/models/my-avatar.glb`
- `avatarHeight` (force avatar absolute height): `https://localhost:5173/?avatarHeight=12`
- `avatarScale` (extra avatar scale multiplier): `https://localhost:5173/?avatarScale=2`
- `sceneScale` (force scene scale multiplier): `https://localhost:5173/?sceneScale=0.25`
- `sceneSpanAvatars` (auto scene span target in avatar-heights, default 46): `https://localhost:5173/?sceneSpanAvatars=46`
- `embodyOffset` (vertical offset in VR first-person alignment): `https://localhost:5173/?embodyOffset=0.2`
- `avatarForwardOffset` (radians for model forward fix, default `3.14159`): `https://localhost:5173/?avatarForwardOffset=0`
- `handTrackPitchDeg` (tracked-hand orientation correction pitch, default `0`): `https://localhost:5173/?handTrackPitchDeg=0`
- `handTrackYawDeg` (tracked-hand orientation correction yaw, default `180`): `https://localhost:5173/?handTrackYawDeg=180`
- `handTrackRollDeg` (tracked-hand orientation correction roll, default `0`): `https://localhost:5173/?handTrackRollDeg=0`
- `handTrackInwardYawDeg` (mirrored inward yaw correction for tracked hands, default `30`): `https://localhost:5173/?handTrackInwardYawDeg=30`
- `handFingerCurlGain` (scales tracked axial finger twist, default `1.0` for neutral 1:1 behavior): `https://localhost:5173/?handFingerCurlGain=1.0`
- `handRetargetMode` (finger retarget mode, `hybrid` or `legacy`, default `hybrid`): `https://localhost:5173/?handRetargetMode=legacy`
- `controllerTrackPitchDeg` (controller orientation correction pitch, default `0`): `https://localhost:5173/?controllerTrackPitchDeg=0`
- `controllerTrackYawDeg` (controller orientation correction yaw, default `180`): `https://localhost:5173/?controllerTrackYawDeg=180`
- `controllerTrackRollDeg` (controller orientation correction roll, default `0`): `https://localhost:5173/?controllerTrackRollDeg=0`

## Controls

- Click the canvas to lock the mouse, then move mouse to rotate look direction
- `W A S D`: move with physics locomotion (desktop and VR parity mode)
- `Space`: single jump while grounded (desktop and VR parity mode)
- `Hold C`: crouch (desktop)
- `V` (desktop only): toggle between 3rd-person and 1st-person view
- `Enter VR`: start immersive session when supported

Mode behavior:

- Desktop 3rd-person: follow camera with collision-safe camera placement.
- Desktop 1st-person: eye-level camera for easy non-VR testing.
- VR: first-person body embodiment with controller-driven hands (grip-space tracking + 2-bone arm IK), headset-height crouch pose, and the same Rapier locomotion/jump/collision path as desktop.
- In first-person modes, head meshes are hidden so you can look down and see body without seeing face from inside while torso/arms/legs remain visible.
- Full crouch reduces movement speed to 75% while keeping jump enabled.
- VR hand sensors are Rapier ghost triggers (no physical pushing), positioned at the solved hand locations each frame.
- Scene is auto-scaled relative to avatar by default.
- Exported recordings now include nearby scene geometry clipped to a recording-path bubble (radius `2` world units) sampled from the active camera and avatar root while recording.

## Notes

- Local development now runs over HTTPS so the IWSDK/IWER toolchain behaves like a real secure WebXR origin.
- Use `https://localhost:*` on desktop when you want IWER emulation; use the machine IP/network URL on a headset so the plugin's localhost-only activation does not override native WebXR.
- Click the `Enter VR` button to start an immersive session when supported.
- Local desktop XR emulation uses IWSDK's IWER runtime on `https://localhost:*`.
- CI installs `ktx` so production builds use the full IWSDK KTX2 compression path. Local `ktx` is optional but recommended if you want build parity with CI.
- CI / non-headset testing now enters a real IWER-backed XR session and then drives deterministic poses via `window.__setMockVrPose(...)`.
- Deterministic test hooks available for automation:
  - `window.advanceTime(ms)`
  - `window.render_game_to_text()`
  - `window.__setMockInput({ forward?, back?, left?, right?, crouch?, jump? })`
  - `window.__setMockVrPose({ head?, hands?: { [side]: { tracked?, position?, quaternion?, joints? } } })`
  - `window.__captureHandCalibrationPose()` (captures known relaxed hand pose calibration)
  - `window.__resetHandCalibrationPose()`
- `mockVr=1` remains as a legacy compatibility flag for the old in-app mock mode, but it is no longer the supported primary workflow.

Mock VR per-joint payload (optional) for finger articulation tests:
- `hands[side].joints[jointName].tracked`
- `hands[side].joints[jointName].position` (head-local)
- `hands[side].joints[jointName].quaternion` (head-local)

## Mock VR CI

1. Run the end-to-end mock VR check (starts and stops local dev server automatically):
```bash
npm run test:xr:mock
```

This suite now validates:
- hand tracking validity and solved hand movement
- hand sensor alignment
- tracked finger-joint coverage
- explicit relaxed/pinch/pointing gesture fidelity
- per-finger dropout hold and recovery behavior

2. If you already have a dev server running, run only the Playwright assertion script:
```bash
npm run ci:vr:mock
```

## Mock VR Locomotion Flows

1. Run the full VR locomotion flow suite (auto starts/stops local dev server):
```bash
npm run test:xr:flows
```

2. If a dev server is already running, run only the Playwright flow assertions:
```bash
npm run ci:vr:flows
```

This suite runs inside an IWER-backed VR session and validates:
- forward locomotion
- head-yaw-relative locomotion direction
- strafe flow while yawed
- jump takeoff + landing recovery

## Development Workflows

- Local development:
```bash
npm run dev
```

- IWSDK collaborative browser and agent session:
```bash
pnpm run dev:ai
```

- IWSDK headless agent session:
```bash
pnpm run dev:agent
```

- Inspect or stop the managed session:
```bash
pnpm run dev:status
pnpm run dev:down
```

See [`../../docs/IWSDK_AI_WORKFLOW.md`](../../docs/IWSDK_AI_WORKFLOW.md) for the
agent loop, CLI fallbacks, and the custom-runtime boundary.

- Deterministic local mock VR test loop:
```bash
npm run test:xr:mock
```

- Fast unit tests for gameplay/config helpers:
```bash
npm run test:unit
```

- Preflight checks:
```bash
npm run doctor
```

- Static checks:
```bash
npm run check
```

- Fast verification:
```bash
npm run verify:fast
```

- PR verification gate:
```bash
npm run verify:pr
```

- Full verification:
```bash
npm run verify:full
```

- Changed-scope verification:
```bash
npm run verify:changed
```

- Lint only:
```bash
npm run lint
```

Optional env vars for mock VR scripts:
- `BASE_URL` (default: `https://127.0.0.1:5174/`)
- `SCREENSHOT_DIR` (legacy screenshot dir override)
- `XR_TEST_ARTIFACT_DIR` (preferred screenshot/timeline dir override)
- `DEV_HOST` (default for `test:xr:mock`: `127.0.0.1`)
- `DEV_PORT` (default for `test:xr:mock`: `5174`)
- `REUSE_DEV_SERVER=1` skips auto start/stop in `test:xr:mock`
- `STARTUP_TIMEOUT_MS` (default: `30000`)
- `XR_TEST_MODE` (`iwer` | `off`, default `iwer` for capture scripts; legacy aliases map to `iwer`)
- `XR_SUPPORT_SHIM=0` (legacy alias that maps to `XR_TEST_MODE=off`)
