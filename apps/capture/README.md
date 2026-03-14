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

3. Open the printed local URL (usually `http://localhost:5173`).

## Default assets

The app now defaults to:

- `/models/scene.glb`
- `/models/avatar.glb`

You can override with URL params:

- `scene`: `http://localhost:5173/?scene=/models/my-scene.glb`
- `avatar`: `http://localhost:5173/?avatar=/models/my-avatar.glb`
- `avatarHeight` (force avatar absolute height): `http://localhost:5173/?avatarHeight=12`
- `avatarScale` (extra avatar scale multiplier): `http://localhost:5173/?avatarScale=2`
- `sceneScale` (force scene scale multiplier): `http://localhost:5173/?sceneScale=0.25`
- `sceneSpanAvatars` (auto scene span target in avatar-heights, default 46): `http://localhost:5173/?sceneSpanAvatars=46`
- `embodyOffset` (vertical offset in VR first-person alignment): `http://localhost:5173/?embodyOffset=0.2`
- `avatarForwardOffset` (radians for model forward fix, default `3.14159`): `http://localhost:5173/?avatarForwardOffset=0`
- `handTrackPitchDeg` (tracked-hand orientation correction pitch, default `0`): `http://localhost:5173/?handTrackPitchDeg=0`
- `handTrackYawDeg` (tracked-hand orientation correction yaw, default `180`): `http://localhost:5173/?handTrackYawDeg=180`
- `handTrackRollDeg` (tracked-hand orientation correction roll, default `0`): `http://localhost:5173/?handTrackRollDeg=0`
- `handTrackInwardYawDeg` (mirrored inward yaw correction for tracked hands, default `30`): `http://localhost:5173/?handTrackInwardYawDeg=30`
- `handFingerCurlGain` (scales tracked axial finger twist, default `1.0` for neutral 1:1 behavior): `http://localhost:5173/?handFingerCurlGain=1.0`
- `handRetargetMode` (finger retarget mode, `hybrid` or `legacy`, default `hybrid`): `http://localhost:5173/?handRetargetMode=legacy`
- `controllerTrackPitchDeg` (controller orientation correction pitch, default `0`): `http://localhost:5173/?controllerTrackPitchDeg=0`
- `controllerTrackYawDeg` (controller orientation correction yaw, default `180`): `http://localhost:5173/?controllerTrackYawDeg=180`
- `controllerTrackRollDeg` (controller orientation correction roll, default `0`): `http://localhost:5173/?controllerTrackRollDeg=0`

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

- WebXR requires HTTPS in most cases, but localhost is typically allowed for development.
- Click the `Enter VR` button to start an immersive session when supported.
- CI / non-headset testing: open with `?mockVr=1` and drive synthetic headset/hand poses via `window.__setMockVrPose(...)`.
- Deterministic test hooks available for automation:
  - `window.advanceTime(ms)`
  - `window.render_game_to_text()`
  - `window.__setMockInput({ forward?, back?, left?, right?, crouch?, jump? })`
  - `window.__setMockVrPose({ head?, hands?: { [side]: { tracked?, position?, quaternion?, joints? } } })`
  - `window.__captureHandCalibrationPose()` (captures known relaxed hand pose calibration)
  - `window.__resetHandCalibrationPose()`

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

This suite runs in `?mockVr=1` mode and validates:
- forward locomotion
- head-yaw-relative locomotion direction
- strafe flow while yawed
- jump takeoff + landing recovery

## Development Workflows

- Local development:
```bash
npm run dev
```

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
- `BASE_URL` (default: `http://127.0.0.1:5174/`)
- `SCREENSHOT_DIR` (legacy screenshot dir override)
- `XR_TEST_ARTIFACT_DIR` (preferred screenshot/timeline dir override)
- `DEV_HOST` (default for `test:xr:mock`: `127.0.0.1`)
- `DEV_PORT` (default for `test:xr:mock`: `5174`)
- `REUSE_DEV_SERVER=1` skips auto start/stop in `test:xr:mock`
- `STARTUP_TIMEOUT_MS` (default: `30000`)
- `XR_TEST_MODE` (`polyfill` | `shim` | `off`, default `polyfill`)
- `XR_SUPPORT_SHIM=0` (legacy alias that maps to `XR_TEST_MODE=off`)
