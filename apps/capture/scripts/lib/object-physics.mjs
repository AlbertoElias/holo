import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as THREE from 'three';

import {
  enterIwerSessionFromButton,
  freezePageClock,
  waitForIwerRuntime,
  waitForXrRenderLoop
} from '@holoim/tooling-testing/xr-env';

import { angleDeg, findNode, loadTake, objectNodes } from './object-glb.mjs';
import { OBJECT_URL, checkObjectExport, clickButton, openCapture, poseOf, readState, saveDownload, setupPage } from './object-take.mjs';

// Grab, place and throw with physics (slice 1): scripted IWER-controller
// scenarios against capture's real input paths. Each re-arms a fresh object
// (loading the bracket again replaces the prepared one, which also exercises
// removal), reaches it with the avatar's hand, and checks what physics did:
//   still drop, throw with a swing (launch speed against the object's own
//   speed over the last 100 ms held), clamp-speed throw, catch mid-air,
//   release onto a raised surface, non-throw drops (controller/hand switch,
//   tracking loss), bounds reset, and a recorded throw whose export has
//   an object key for every avatar key and no key-to-key turn over 180°.
// Writes object-physics-report.json with trajectories, rest heights, launch
// speeds and the median prop world.step time.

const STEP_MS = 1000 / 60;
const FLOOR_TOLERANCE_M = 0.01;
// How far below the floor a prop may sink while it lands.
const PENETRATION_TOLERANCE_M = 0.003;
const REST_TIMEOUT_SEC = 3;
const SPEED_TOLERANCE = 0.2;
const MAX_LINEAR_MPS = 12;
// The fixture's walkable surfaces in world space: the scene sits 0.01 m above its authored floor.
const FLOOR_Y = 0.01;
const PLATFORM_TOP_M = FLOOR_Y + 0.28;
// How far each scenario reports, in samples of the trajectory (every step is kept in memory, a subset is written).
const TRAJECTORY_STRIDE = 3;

const round = (value, digits = 4) => Number(value.toFixed(digits));
const horizontal = (v) => Math.hypot(v[0], v[2]);

/** One IWER session in a take-less page, with helpers to drive the controllers and read the object. */
async function openSession({ browser, baseUrl, consoleErrors }) {
  const label = 'iwer-object-physics';
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  await openCapture(page, baseUrl, { object: OBJECT_URL });
  await page.evaluate(() => {
    window.__setManualClock(true, false);
    window.IWER_DEVICE.primaryInputMode = 'controller';
  });
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  await page.evaluate(() => {
    window.IWER_DEVICE.controlMode = 'programmatic';
  });
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  await page.evaluate(() => window.__setFrameStepping(true, false));

  const s = { label, context, page, steps: 0, grip: [0.3, 0.9, -0.1], rigYaw: 0, origin: [0, 0, 0] };
  s.restGrip = () => [0.3 + s.origin[0], 0.9 + s.origin[1], -0.1 + s.origin[2]];
  s.step = async (count = 1) => {
    for (let i = 0; i < count; i += 1) await page.clock.runFor(STEP_MS);
    s.steps += count;
  };
  s.controller = (side, position, quaternion) => page.evaluate(({ side: sd, p, q }) => {
    const c = window.IWER_DEVICE.controllers[sd];
    c.position.set(...p);
    if (q) c.quaternion.set(...q);
  }, { side, p: position, q: quaternion });
  s.button = (side, id, value) => page.evaluate(({ side: sd, i, v }) => window.IWER_DEVICE.controllers[sd].updateButtonValue(i, v), { side, i: id, v: value });
  s.item = async () => (await readState(page)).objects.items[0];
  s.state = () => readState(page);
  /** Moves the whole rig (head and both controllers) by `delta` in tracking space. */
  s.shiftRig = (delta) => {
    s.origin = s.origin.map((v, k) => v + delta[k]);
    return s.shiftRigRaw(delta);
  };
  s.shiftRigRaw = (delta) => page.evaluate((d) => {
    const device = window.IWER_DEVICE;
    device.position.set(device.position.x + d[0], device.position.y + d[1], device.position.z + d[2]);
    for (const c of Object.values(device.controllers)) c.position.set(c.position.x + d[0], c.position.y + d[1], c.position.z + d[2]);
  }, delta);
  s.toTracking = (delta) => {
    const c = Math.cos(-s.rigYaw);
    const sn = Math.sin(-s.rigYaw);
    return [delta[0] * c + delta[2] * sn, delta[1], -delta[0] * sn + delta[2] * c];
  };
  s.toWorld = (delta) => {
    const c = Math.cos(s.rigYaw);
    const sn = Math.sin(s.rigYaw);
    return [delta[0] * c + delta[2] * sn, delta[1], -delta[0] * sn + delta[2] * c];
  };

  const rest = { left: [-0.3, 0.9, -0.1], right: [0.3, 0.9, -0.1] };
  await s.controller('left', rest.left, [0, 0, 0, 1]);
  await s.controller('right', rest.right, [0, 0, 0, 1]);
  await s.step(20);
  s.grip = [...rest.right];
  s.rigYaw = (await s.state()).thumbstick.rigYaw;
  return s;
}

/** Closes the loop on the avatar's hand bone until it is at the object. Returns the final distance. */
async function reach(s) {
  let error = Infinity;
  for (let i = 0; i < 20 && error > 0.02; i += 1) {
    const state = await s.state();
    const delta = s.toTracking(state.objects.items[0].position.map((v, k) => v - state.objects.hands.right.position[k]));
    error = Math.hypot(...delta);
    s.grip = s.grip.map((v, k) => v + delta[k] * 0.8);
    await s.controller('right', s.grip);
    await s.step(6);
  }
  const state = await s.state();
  return Math.hypot(...state.objects.items[0].position.map((v, k) => v - state.objects.hands.right.position[k]));
}

/** A fresh prepared object placed in front of the avatar, hovering. */
async function rearm(s) {
  const ok = await s.page.evaluate((url) => window.__loadObjectUrl(url), OBJECT_URL);
  if (!ok) throw new Error('re-arming the object failed');
  await s.button('right', 'squeeze', 0);
  s.grip = s.restGrip();
  await s.controller('right', s.grip);
  await s.step(8);
  const item = await s.item();
  if (!item?.placed) throw new Error('the re-armed object was not placed');
  return item;
}

async function grab(s) {
  await s.button('right', 'squeeze', 1);
  await s.step(2);
  const item = await s.item();
  return item.heldBy === 'right';
}

/** Steps until the object's body sleeps (or `timeoutSec`), keeping the whole trajectory. */
async function fall(s, trajectory, timeoutSec = REST_TIMEOUT_SEC) {
  let item = await s.item();
  for (let i = 0; i < Math.round(timeoutSec * 60) && item.body !== 'asleep'; i += 1) {
    await s.step(1);
    item = await s.item();
    trajectory.push(sampleOf(s, item));
  }
  return item;
}

const sampleOf = (s, item) => ({
  step: s.steps,
  position: item.position.map((v) => round(v)),
  floorGapM: round(item.boundsMin[1] - FLOOR_Y),
  speedMps: round(Math.hypot(...item.linvel), 3),
  linvel: item.linvel,
  body: item.body
});

const writeTrajectory = (trajectory) => trajectory.filter((_, i) => i % TRAJECTORY_STRIDE === 0 || i === trajectory.length - 1).map((sample) => ({ ...sample, linvel: undefined }));

/** Swings the right controller along `dir` (tracking space) at `speed` m/s, releasing on step `releaseAt`; returns the held samples. */
async function swing(s, dir, speed, { steps = 14, releaseAt = 10 } = {}) {
  const per = (speed * STEP_MS) / 1000;
  const held = [];
  const trajectory = [];
  for (let i = 1; i <= steps; i += 1) {
    s.grip = s.grip.map((v, k) => v + dir[k] * per);
    await s.controller('right', s.grip);
    if (i === releaseAt) await s.button('right', 'squeeze', 0);
    await s.step(1);
    const item = await s.item();
    if (item.heldBy) held.push(item);
    else trajectory.push(sampleOf(s, item));
    if (i === releaseAt) held.releaseState = item;
  }
  return { held, releaseState: held.releaseState, trajectory };
}

/** The object's speed over the last ~100 ms it was held (its own poses, not the controller's). */
function heldSpeed(held) {
  const last = held.at(-1);
  const first = held.at(-7) ?? held[0];
  const n = held.indexOf(last) - held.indexOf(first);
  if (!last || !first || n <= 0) return { speed: 0, direction: [0, 0, 0] };
  const d = last.position.map((v, k) => v - first.position[k]);
  const dt = (n * STEP_MS) / 1000;
  return { speed: Math.hypot(...d) / dt, direction: d };
}

const angleBetween = (a, b) => (Math.hypot(...a) < 1e-6 || Math.hypot(...b) < 1e-6 ? 0 : THREE.MathUtils.radToDeg(new THREE.Vector3(...a).angleTo(new THREE.Vector3(...b))));

export async function runIwerObjectPhysics({ browser, baseUrl, artifactDir, consoleErrors }) {
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const s = await openSession({ browser, baseUrl, consoleErrors });
  const report = { label: s.label, scenarios: {} };
  try {
    // 1. Still drop: a still hand lets go; the object falls to the floor under it.
    {
      const item = await rearm(s);
      const home = item.position;
      const reachM = await reach(s);
      if (reachM > 0.06) fail(`still drop: the hand never reached the object (${round(reachM, 3)} m)`);
      if (!(await grab(s))) fail('still drop: a squeeze on the object did not grab it');
      await s.step(20);
      const before = await s.item();
      await s.button('right', 'squeeze', 0);
      await s.step(1);
      const trajectory = [];
      const launch = await s.item();
      const end = await fall(s, trajectory);
      const drift = Math.hypot(end.position[0] - before.position[0], end.position[2] - before.position[2]);
      const lowest = Math.min(...trajectory.map((p) => p.floorGapM));
      report.scenarios.stillDrop = { homeM: home.map((v) => round(v)), fromHeightM: round(before.boundsMin[1] - FLOOR_Y, 3), launchSpeedMps: round(Math.hypot(...launch.linvel), 3), horizontalDriftM: round(drift, 4), restBody: end.body, restFloorGapM: round(end.boundsMin[1] - FLOOR_Y), lowestFloorGapM: lowest, trajectory: writeTrajectory(trajectory) };
      if (end.body !== 'asleep') fail(`still drop: the object had not come to rest after ${REST_TIMEOUT_SEC} s (${end.body})`);
      if (horizontal(launch.linvel) > 0.05) fail(`still drop: a still hand launched it sideways at ${round(horizontal(launch.linvel), 3)} m/s`);
      // The bracket tips as it lands, so its centre may shift a little; a still drop stays under the hand.
      if (drift > 0.05) fail(`still drop: it drifted ${round(drift, 3)} m sideways (limit 0.05 m)`);
      if (Math.abs(end.boundsMin[1] - FLOOR_Y) > FLOOR_TOLERANCE_M) fail(`still drop: it rests ${round(end.boundsMin[1] - FLOOR_Y, 4)} m from the floor`);
      if (lowest < -PENETRATION_TOLERANCE_M) fail(`still drop: it went ${round(lowest, 4)} m below the floor`);
    }

    // 2. Throw: swing along +x and let go mid-swing.
    for (const [name, speed, dir] of [['throw', 4, [1, 0.3, 0]], ['clampThrow', 40, [1, 0.5, 0]]]) {
      await s.button('right', 'squeeze', 0);
      await s.shiftRig(s.toTracking([0, 0, 0]));
      const item = await rearm(s);
      s.grip = s.restGrip();
      await s.controller('right', s.grip);
      await s.step(6);
      const reachM = await reach(s);
      if (reachM > 0.06) fail(`${name}: the hand never reached the object (${round(reachM, 3)} m)`);
      if (!(await grab(s))) fail(`${name}: a squeeze on the object did not grab it`);
      const { held, trajectory } = await swing(s, dir.map((v) => v / Math.hypot(...dir)), speed);
      const fitted = heldSpeed(held);
      const launch = trajectory[0];
      const launchSpeed = launch ? Math.hypot(...launch.linvel) : 0;
      const end = await fall(s, trajectory);
      const lowest = Math.min(...trajectory.map((p) => p.floorGapM));
      const scenario = {
        swingMps: speed,
        fittedHeldSpeedMps: round(fitted.speed, 3),
        launchSpeedMps: round(launchSpeed, 3),
        launchHeadingErrorDeg: launch ? round(angleBetween(fitted.direction, launch.linvel), 2) : null,
        restBody: end.body,
        restFloorGapM: round(end.boundsMin[1] - FLOOR_Y),
        lowestFloorGapM: lowest,
        travelledM: round(Math.hypot(end.position[0] - item.position[0], end.position[2] - item.position[2]), 3),
        trajectory: writeTrajectory(trajectory)
      };
      report.scenarios[name] = scenario;
      if (end.body !== 'asleep') fail(`${name}: it had not come to rest after ${REST_TIMEOUT_SEC} s (${end.body})`);
      if (lowest < -PENETRATION_TOLERANCE_M) fail(`${name}: it went ${round(lowest, 4)} m below the floor`);
      if (Math.abs(end.boundsMin[1] - FLOOR_Y) > FLOOR_TOLERANCE_M) fail(`${name}: it rests ${round(end.boundsMin[1] - FLOOR_Y, 4)} m from the floor`);
      if (name === 'throw') {
        // Launch speed within 20% of the object's own speed over the last 100 ms held.
        const launchLinear = launchSpeed;
        if (fitted.speed < 1) fail(`${name}: the swing only moved the held object at ${round(fitted.speed, 2)} m/s`);
        else if (Math.abs(launchLinear - fitted.speed) > SPEED_TOLERANCE * fitted.speed) fail(`${name}: launched at ${round(launchLinear, 2)} m/s, the held object's own speed was ${round(fitted.speed, 2)} m/s (limit ±20%)`);
        if (scenario.travelledM < 0.5) fail(`${name}: it travelled only ${scenario.travelledM} m`);
      } else if (scenario.launchSpeedMps > MAX_LINEAR_MPS + 0.5) {
        fail(`${name}: launched at ${scenario.launchSpeedMps} m/s, above the ${MAX_LINEAR_MPS} m/s clamp`);
      }
    }

    // 3. Catch: grab the object again just after letting go.
    {
      await rearm(s);
      await reach(s);
      await grab(s);
      await s.step(10);
      await s.button('right', 'squeeze', 0);
      await s.step(3);
      const falling = await s.item();
      await s.button('right', 'squeeze', 1);
      await s.step(2);
      const caught = await s.item();
      const relations = [];
      for (let i = 1; i <= 30; i += 1) {
        const t = i / 30;
        await s.controller('right', [s.grip[0] + 0.2 * t, s.grip[1] + 0.1 * t, s.grip[2]]);
        await s.step(1);
        const state = await s.state();
        const hand = poseOf(state.objects.hands.right);
        const obj = poseOf(state.objects.items[0]);
        relations.push(obj.position.clone().sub(hand.position).applyQuaternion(hand.quaternion.clone().invert()));
      }
      const spread = Math.max(...relations.map((r) => r.distanceTo(relations[0])));
      const after = await s.item();
      report.scenarios.catch = { fallingBody: falling.body, fallingSpeedMps: round(Math.hypot(...falling.linvel), 3), caughtBody: caught.body, caughtSpeedMps: round(Math.hypot(...caught.linvel), 3), heldBy: caught.heldBy, rigidSpreadM: round(spread, 5), movedWithHandM: round(Math.hypot(after.position[0] - caught.position[0], after.position[1] - caught.position[1], after.position[2] - caught.position[2]), 3) };
      if (falling.body !== 'dynamic' || Math.hypot(...falling.linvel) < 0.2) fail(`catch: the object was not falling when caught (${falling.body}, ${round(Math.hypot(...falling.linvel), 3)} m/s)`);
      if (caught.heldBy !== 'right' || caught.body !== 'kinematic') fail(`catch: the grab did not stop it (heldBy ${caught.heldBy}, ${caught.body})`);
      if (Math.hypot(...caught.linvel) > 0.05) fail('catch: a caught object kept its velocity');
      if (spread > 0.002) fail(`catch: the caught object slid in the hand (${round(spread, 4)} m)`);
      if (report.scenarios.catch.movedWithHandM < 0.05) fail('catch: the caught object did not follow the hand');
      await s.button('right', 'squeeze', 0);
      await s.step(1);
    }

    // 4. Non-throw releases drop with zero velocity: a controller-to-hand switch and the tracking-loss freeze.
    for (const mode of ['switch', 'switchToPinching', 'switchAfterGap', 'switchJointsUnavailable', 'trackingLoss']) {
      await rearm(s);
      s.grip = s.restGrip();
      await s.controller('right', s.grip);
      await s.step(6);
      const reachM = await reach(s);
      if (!(await grab(s))) fail(`non-throw ${mode}: could not grab the object (reach ${round(reachM, 3)} m)`);
      // Moving fast at the moment of the non-throw release.
      const startedAt = await s.item();
      const per = 0.06;
      for (let i = 1; i <= 8; i += 1) {
        s.grip = [s.grip[0] + per, s.grip[1], s.grip[2]];
        await s.controller('right', s.grip);
        await s.step(1);
      }
      const moving = await s.item();
      const movedM = Math.hypot(moving.position[0] - startedAt.position[0], moving.position[1] - startedAt.position[1], moving.position[2] - startedAt.position[2]);
      if (movedM < 0.1) fail(`non-throw ${mode}: the held object barely moved before the release (${round(movedM, 3)} m)`);
      let released;
      const velocities = [];
      if (mode !== 'trackingLoss') {
        // switchToPinching: the hand is already pinching (about 5 mm) when it becomes the input source.
        // switchAfterGap: one frame with no input source sits between the controller and the already-pinching hand.
        // switchJointsUnavailable: the hand's joints are unavailable on the switch frame and closed the frame after.
        if (mode !== 'switch') await s.page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(1));
        if (mode === 'switchAfterGap') {
          await s.page.evaluate(() => { window.IWER_DEVICE.controllers.right.connected = false; });
          await s.step(1);
          if ((await s.item()).heldBy !== 'right') fail(`non-throw ${mode}: one frame without an input source dropped the object`);
        }
        if (mode === 'switchJointsUnavailable') {
          await s.page.evaluate(() => {
            const proto = window.XRFrame.prototype;
            window.__getJointPose = proto.getJointPose;
            proto.getJointPose = () => null;
          });
        }
        await s.page.evaluate(() => { window.IWER_DEVICE.primaryInputMode = 'hand'; });
        for (let i = 0; i < 6; i += 1) {
          s.grip = [s.grip[0] + per, s.grip[1], s.grip[2]];
          await s.controller('right', s.grip);
          await s.step(1);
          if (mode === 'switchJointsUnavailable' && i === 0) await s.page.evaluate(() => { window.XRFrame.prototype.getJointPose = window.__getJointPose; });
          const item = await s.item();
          if (!item.heldBy) {
            released = item;
            break;
          }
        }
      } else {
        await s.page.evaluate(() => { window.IWER_DEVICE.controllers.right.connected = false; });
        for (let i = 0; i < 45; i += 1) {
          await s.step(1);
          const item = await s.item();
          if (!item.heldBy) {
            released = item;
            break;
          }
        }
      }
      if (released) velocities.push(horizontal(released.linvel), Math.hypot(...released.angvel));
      report.scenarios[`nonThrow_${mode}`] = { movedBeforeM: round(movedM, 3), heldSpeedBeforeMps: round(horizontal(moving.linvel), 3), released: Boolean(released), launchHorizontalMps: released ? round(horizontal(released.linvel), 3) : null, launchSpinRadps: released ? round(Math.hypot(...released.angvel), 3) : null };
      if (!released) fail(`non-throw ${mode}: the object was never released`);
      else if (velocities[0] > 0.05 || velocities[1] > 0.05) fail(`non-throw ${mode}: it was launched at ${round(velocities[0], 3)} m/s, ${round(velocities[1], 3)} rad/s`);
      if (mode !== 'switch' && mode !== 'trackingLoss' && released) {
        // The pinch that was already closed is not a fresh press: no regrab until it opens and closes again.
        const pinching = (await readState(s.page)).objects.grab.right;
        let regrabbed = false;
        for (let i = 0; i < 12; i += 1) {
          s.grip = [s.grip[0] + per, s.grip[1], s.grip[2]];
          await s.controller('right', s.grip);
          await s.step(1);
          if ((await s.item()).heldBy) regrabbed = true;
        }
        report.scenarios[`nonThrow_${mode}`].pinchDistanceM = pinching?.value ?? null;
        report.scenarios[`nonThrow_${mode}`].regrabbedWhilePinching = regrabbed;
        const closedPressed = (await readState(s.page)).objects.grab.right.pressed;
        // Only a later open, then close, is a press.
        await s.page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(0));
        await s.step(4);
        const openPressed = (await readState(s.page)).objects.grab.right.pressed;
        await s.page.evaluate(() => window.IWER_DEVICE.hands.right.updatePinchValue(1));
        await s.step(4);
        const reclosedPressed = (await readState(s.page)).objects.grab.right.pressed;
        report.scenarios[`nonThrow_${mode}`].pressedWhileClosed = closedPressed;
        report.scenarios[`nonThrow_${mode}`].pressedAfterOpenClose = reclosedPressed;
        if (closedPressed || openPressed) fail(`non-throw ${mode}: the pinch counted as pressed before it opened and closed again`);
        if (!reclosedPressed) fail(`non-throw ${mode}: opening and closing the pinch did not count as a press`);
        if (mode !== 'switchJointsUnavailable' && (pinching?.source !== 'pinch' || !(pinching.value < 0.01))) fail(`non-throw ${mode}: the hand was not pinching at about 5 mm (${JSON.stringify(pinching)})`);
        if (regrabbed) fail(`non-throw ${mode}: the already-pinching hand regrabbed in the same press`);
      }
      await s.page.evaluate(() => {
        window.IWER_DEVICE.hands.right.updatePinchValue(0);
        window.IWER_DEVICE.primaryInputMode = 'controller';
        window.IWER_DEVICE.controllers.right.connected = true;
      });
      await s.button('right', 'squeeze', 0);
      await s.step(10);
    }

    // 5. A raised surface: let go above the platform and it comes to rest on it, then lift it off and put it back.
    {
      await rearm(s);
      s.grip = s.restGrip();
      await s.controller('right', s.grip);
      await s.step(6);
      await reach(s);
      await grab(s);
      // Walk the whole rig to stand over the platform (flat top at z 3.6..6, x ±1.5) with the object in hand.
      const walk = s.toTracking([0, 0, 5]);
      for (let i = 0; i < 100; i += 1) {
        await s.shiftRig(walk.map((v) => v / 100));
        await s.step(1);
      }
      await s.step(20);
      const held = await s.item();
      await s.button('right', 'squeeze', 0);
      await s.step(1);
      const trajectory = [];
      const end = await fall(s, trajectory);
      const surfaceGap = end.boundsMin[1] - PLATFORM_TOP_M;
      report.scenarios.surface = { heldAtM: held.position.map((v) => round(v)), restPositionM: end.position.map((v) => round(v)), restBody: end.body, restHeightAboveSurfaceM: round(surfaceGap), trajectory: writeTrajectory(trajectory) };
      const onPlatform = end.position[2] > 3.6 && end.position[2] < 6 && Math.abs(end.position[0]) < 1.5;
      if (!onPlatform) fail(`surface: the object did not land on the platform (${end.position.map((v) => round(v, 2)).join(', ')})`);
      else if (Math.abs(surfaceGap) > FLOOR_TOLERANCE_M) fail(`surface: it rests ${round(surfaceGap, 4)} m from the platform top`);
      if (end.body !== 'asleep') fail(`surface: it had not come to rest (${end.body})`);
      // Squat to reach it
      await s.shiftRig([0, -0.6, 0]);
      await s.step(30);
      // Re-grab it where it rests and let go without moving: it stays.
      const reachBack = await reach(s);
      if (reachBack > 0.08) {
        report.scenarios.surface.regrab = { skipped: `the hand could not reach the resting object (${round(reachBack, 3)} m)` };
      } else {
        const before = await s.item();
        await grab(s);
        await s.step(10);
        await s.button('right', 'squeeze', 0);
        const after = await fall(s, []);
        const moved = Math.hypot(after.position[0] - before.position[0], after.position[1] - before.position[1], after.position[2] - before.position[2]);
        report.scenarios.surface.regrab = { movedM: round(moved, 4), restBody: after.body };
        if (moved > FLOOR_TOLERANCE_M * 2) fail(`surface: releasing it where it rested moved it ${round(moved, 4)} m`);
      }
    }

    // Stand back up.
    await s.shiftRig([0, 0.6, 0]);
    await s.step(30);

    // 6. Bounds: thrown past the edge of the scene, it returns to its placement pose, at rest.
    {
      await s.button('right', 'squeeze', 0);
      await s.step(2);
      const item = await rearm(s);
      s.grip = [...s.grip];
      const home = item.position;
      const reachM = await reach(s);
      const grabbed = await grab(s);
      if (reachM > 0.06 || !grabbed) fail(`bounds: could not grab the object (reach ${round(reachM, 3)} m, grabbed ${grabbed})`);
      // Carry it to the +x edge (the floor ends at x = 7).
      const walk = s.toTracking([6.8, 0, 0]);
      const moveSteps = 70;
      for (let i = 0; i < moveSteps; i += 1) {
        await s.shiftRig(walk.map((v) => v / moveSteps));
        await s.step(1);
      }
      await s.step(10);
      s.grip = (await s.page.evaluate(() => { const p = window.IWER_DEVICE.controllers.right.position; return [p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]]; }));
      const { held: heldSwing, trajectory } = await swing(s, s.toTracking([1, 0.3, 0]).map((v) => v / Math.hypot(1, 0.3)), 14);
      let reset = null;
      for (let i = 0; i < 4 * 60 && !reset; i += 1) {
        await s.step(1);
        const now = await s.item();
        trajectory.push(sampleOf(s, now));
        if (now.body === 'kinematic' && !now.heldBy) reset = now;
      }
      await s.step(5);
      const final = await s.item();
      const stats = (await s.state()).objects.physics;
      const error = Math.hypot(final.position[0] - home[0], final.position[1] - home[1], final.position[2] - home[2]);
      report.scenarios.bounds = { swingHeldSpeedMps: round(heldSpeed(heldSwing).speed, 3), heldSamples: heldSwing.length, avatarX: round((await s.state()).avatar.x, 2), homeM: home.map((v) => round(v)), reset: Boolean(reset), finalM: final.position.map((v) => round(v)), distanceFromHomeM: round(error, 4), body: final.body, speedMps: round(Math.hypot(...final.linvel), 3), resets: stats?.resets ?? null, trajectory: writeTrajectory(trajectory) };
      if (!reset) fail('bounds: an object thrown out of the scene never returned');
      if (error > 0.01) fail(`bounds: it returned ${round(error, 3)} m from its placement pose`);
      if (final.body !== 'kinematic' || Math.hypot(...final.linvel) > 1e-6) fail(`bounds: it did not return at rest (${final.body})`);
    }

    // 7. A recorded throw: the export has an object key for every avatar key, holds end at the release, and no key turns over 180°.
    {
      await s.button('right', 'squeeze', 0);
      await s.step(2);
      await rearm(s);
      // Back at a clear spot: the rig has walked away from where the object spawns, which is fine, it spawns in front.
      s.grip = (await s.page.evaluate(() => { const p = window.IWER_DEVICE.controllers.right.position; return [p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]]; }));
      const reachBefore = await reach(s);
      if (reachBefore > 0.06) fail(`recorded throw: the hand never reached the object (${round(reachBefore, 3)} m)`);
      await clickButton(s.page, 'Start Recording');
      await s.page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
      await s.step(18);
      if (!(await grab(s))) fail('recorded throw: a squeeze on the object did not grab it');
      const grabbedStep = s.steps;
      const { held, trajectory } = await swing(s, [-0.7, 0.3, -0.64], 5, { steps: 14, releaseAt: 10 });
      const releasedStep = s.steps - (14 - 10);
      const end = await fall(s, trajectory);
      await s.step(30);
      const glb = path.join(artifactDir, `${s.label}-throw.glb`);
      const problems = [];
      await saveDownload(s.page, async () => {
        await clickButton(s.page, 'Stop Recording');
        for (let i = 0; i < 20; i += 1) await s.step(1);
      }, glb);
      const buffer = await readFile(glb);
      const exportReport = checkObjectExport(buffer, { expectHolds: [{ hand: 'right', duration: ((releasedStep - grabbedStep) * STEP_MS) / 1000 }], captureRelation: null, fail: (m) => problems.push(m) });
      for (const problem of problems) fail(`recorded throw: ${problem}`);
      const take = loadTake(buffer);
      const [node] = objectNodes(take);
      const rotations = node === undefined ? null : take.channels.get(node)?.rotation;
      const turns = rotationKeyDeltas(take, node);
      const flightKeys = movingKeysAfter(take, node, exportReport.extension?.holds?.[0]?.end ?? 0);
      const avatarKeys = take.times.length;
      report.scenarios.recordedThrow = { heldSteps: held.length, keys: avatarKeys, objectKeys: exportReport.objectKeys, maxKeyTurnDeg: round(turns.max, 2), keysWithMotionAfterRelease: flightKeys, restBody: end.body, restFloorGapM: round(end.boundsMin[1] - FLOOR_Y), holds: exportReport.extension?.holds ?? null, rotationTrack: Boolean(rotations) };
      if (turns.max > 180) fail(`recorded throw: an object key turns ${round(turns.max, 1)}° from the previous key (limit 180°)`);
      if (flightKeys < 5) fail(`recorded throw: only ${flightKeys} object keys move after the release; the flight is not in the take`);
      if (end.body !== 'asleep') fail(`recorded throw: it had not come to rest (${end.body})`);
      if (findNode(take, 'RecordedAvatar') < 0) fail('recorded throw: no RecordedAvatar node');
      report.scenarios.recordedThrow.glb = glb;
    }

    const finalState = await s.state();
    report.physics = finalState.objects.physics;
    // The harness freezes the page clock, so performance.now cannot time a step here; the number is real on a device.
    report.medianStepMs = finalState.objects.physics?.stepMedianMs || null;
    report.stepTimeNote = report.medianStepMs === null ? 'not measurable: the page clock is frozen by the harness' : undefined;
  } catch (error) {
    fail(`scenario error: ${error.stack ?? error}`);
  } finally {
    report.status = failures.length ? 'fail' : 'pass';
    report.failures = failures;
    await writeFile(path.join(artifactDir, 'object-physics-report.json'), JSON.stringify(report, null, 2));
    await s.context.close();
  }
  return { label: s.label, status: report.status, failures, report: path.join(artifactDir, 'object-physics-report.json'), glb: report.scenarios.recordedThrow?.glb ?? null, scenarios: Object.keys(report.scenarios) };
}

/** Largest angle between consecutive rotation keys of `node`. */
function rotationKeyDeltas(take, node) {
  let max = 0;
  const channel = take.channels.get(node)?.rotation;
  const values = channel?.values;
  if (!values) return { max };
  for (let i = 1; i < channel.keys; i += 1) {
    const a = new THREE.Quaternion(values[(i - 1) * 4], values[(i - 1) * 4 + 1], values[(i - 1) * 4 + 2], values[(i - 1) * 4 + 3]);
    const b = new THREE.Quaternion(values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]);
    max = Math.max(max, angleDeg(a, b));
  }
  return { max };
}

/** Keys after `fromSec` at which the object's translation changes from the previous key. */
function movingKeysAfter(take, node, fromSec) {
  const channel = take.channels.get(node)?.translation;
  const values = channel?.values;
  if (!values) return 0;
  let count = 0;
  for (let i = 1; i < channel.keys; i += 1) {
    if (take.times[i] < fromSec) continue;
    const d = Math.hypot(values[i * 3] - values[(i - 1) * 3], values[i * 3 + 1] - values[(i - 1) * 3 + 1], values[i * 3 + 2] - values[(i - 1) * 3 + 2]);
    if (d > 1e-4) count += 1;
  }
  return count;
}
