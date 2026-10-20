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
  - `window.advanceTime(ms)` (fixed 1/60 s steps; draws the final frame unless the manual clock is on)
  - `window.__setManualClock(enabled)` (pauses wall-clock simulation so only `advanceTime` moves it; frames keep drawing)
  - `window.__respawnCharacter()` (returns the character to the scene spawn point)
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

`npm run test:xr` runs every check against one dev server, several at a time
(`XR_CHECK_CONCURRENCY`, logs in `output/xr-checks/`). While iterating, run one
check (`test:xr:body`, `test:xr:hands`, ...) and one fixture
(`XR_REPLAY_ONLY=walk-forward`); see "Fast Agent Loop" in `AGENT_CONTRACT.md`.

This suite runs inside an IWER-backed VR session and validates:
- forward, back, left, and right travel at four head yaws, each landing nearest
  its expected world direction (spawn terrain deflects travel by up to ~0.5 rad)
- jump takeoff + landing recovery
- VR crouch amount, source, recovery, and crouched speed reduction
- desktop keyboard mapping, crouch, crouch-jump, and crouch-walk release

Both suites are deterministic: they take the manual clock before XR entry, then
freeze page timers so IWER stops compositing frames nobody asserts on. Results
are identical on any host; a failure writes a state timeline JSON next to its
screenshot.

## Hand-Tracking Fidelity From Headset Input

`npm run test:xr:hands` replays every recording in `fixtures/input-recordings/`
through the real WebXR input path (IWER `ActionPlayer` → XRHand joints →
retargeter → avatar) and compares the avatar's hands with the tracked hands:
finger curl error, correlation, and lag; pinch contact; wrist position and
rotation; and added jitter. Each run writes `output/ci-hand-replay/<name>-report.json`
and per-frame samples. `HAND_REPLAY_VIDEO=1` also renders a spectator video with
the tracked joints drawn as dots (cyan left, magenta right).

Record new input on a headset:

1. Run `pnpm --filter @holoim/capture dev` on a machine on the same network as the
   headset, and open the printed network `https://` URL in the headset browser
   (accept the development certificate). IWER stays off on non-localhost origins,
   so the session uses the headset's native WebXR.
2. Enter VR, put the controllers down so hand tracking takes over, and start a
   recording from the floating panel (pinch while pointing at it).
3. Perform the motions to cover (open hand, fist, pinch, point, wave, reach),
   then stop the recording.
4. The dev server writes the raw input to
   `fixtures/input-recordings/avatar-recording-<timestamp>.json` (`meta.source`
   is `headset`). Rename it after the motions it covers and commit it.

`iwer-poses-relaxed-point-pinch.json` moves both hands through IWER's captured
relaxed, point, and pinch poses; regenerate it with `npm run fixtures:hands`. It
is emulator data, so add headset recordings alongside it when available.

## Room-Scale Body Motion

In VR, `src/body/VrBodySolver.ts` drives the whole avatar from the tracked head
while the user physically moves: the body follows the head through the physics
controller, turns after the head with a neck allowance, plants and steps its
feet, and bends the spine, hips, and knees so the avatar's eyes stay on the
user's. The camera rig is world-locked: it moves only with keyboard movement and
ground height, never because the avatar moved.

`npm run test:xr:body` replays every recording in `fixtures/body-recordings/`
through the real WebXR path, ticking the simulation inside each XR frame as a
headset does, and measures the body against the recording's own head poses:
world lock, eye position and lag, head orientation, pelvis lag and overshoot,
body yaw and turn lag, foot sliding, skating, ground contact, cadence and step
length, crouch depth, lean, and pops. Reports and samples go to
`output/ci-body-replay/`. `BODY_REPLAY_VIDEO=1` renders a third-person video with
the tracked head path in cyan and the avatar's eyes in pink, and
`BODY_REPLAY_FAULTS=1` breaks each behavior in turn and requires its metric to
fail.

The IWER fixtures walk the flat-floor-and-ramp test scene
(`fixtures/scenes/body-floor.gltf`, from `scripts/generate-body-test-scene.mjs`);
regenerate them with `npm run fixtures:body`. Each recording stores the page's
query (`meta.query`), so a replay loads the scene it was recorded in.

Record room-scale motion on a headset:

1. Clear a space of at least 3 × 2 m. Run `pnpm --filter @holoim/capture dev`
   on a machine on the headset's network and open the network `https://` URL in
   the headset browser. Add `?scene=/fixtures/scenes/body-floor.gltf&sceneScale=1`
   to record on the test floor, or leave it off for the default scene.
2. Enter VR standing upright (the first frame sets your standing height), and
   start a recording from the floating panel.
3. Cover, with pauses between: walk forward 3 m and back, step sideways both
   ways, turn 90° and 180° in place, walk a curve, crouch and stand, lean
   forward and to the side, take single small steps, and stand still looking
   around. Keep each recording under about 20 s.
4. Stop the recording. The dev server writes it to
   `fixtures/input-recordings/avatar-recording-<timestamp>.json` (`meta.source`
   is `headset`). Move it to `fixtures/body-recordings/`, rename it after what
   it covers, and commit it.

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
- `DEV_HOST` (default for `test:xr*`: `127.0.0.1`)
- `DEV_PORT` (default for `test:xr*`: `5174`)
- `REUSE_DEV_SERVER=1` skips auto start/stop in `test:xr*`
- `XR_CHECK_TIMEOUT_MS` (default: `120000` per check)
- `XR_TEST_VIEWPORT` (default: `320x180`; set `1280x720` to watch a run)
- `XR_CAPTURE_SUCCESS_SCREENSHOTS=1` also saves screenshots for passing steps
- `STARTUP_TIMEOUT_MS` (default: `30000`)
- `XR_TEST_MODE` (`iwer` | `off`, default `iwer` for capture scripts; legacy aliases map to `iwer`)
- `XR_SUPPORT_SHIM=0` (legacy alias that maps to `XR_TEST_MODE=off`)
