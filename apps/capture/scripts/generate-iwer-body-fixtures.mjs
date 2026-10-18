import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  launchXrBrowser,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix
} from '@holoim/tooling-testing/xr-env';

// Regenerates fixtures/body-recordings/*.json: scripted room-scale motion of
// the IWER headset (and hands or controllers), recorded by capture's own
// input recorder on a frozen clock, on the flat-floor-and-ramp test scene.
// Paths use human-like speeds (walking ~1.2 m/s with eased starts and stops,
// head bob and sway at step frequency). These are emulator paths, not a
// headset session. Run: pnpm --filter @holoim/capture run fixtures:body

const STEP_MS = 1000 / 30;
const STEP_SEC = STEP_MS / 1000;
const SAVE_DIR = 'fixtures/input-recordings';
const FIXTURE_DIR = 'fixtures/body-recordings';
const SCENE_QUERY = '?scene=/fixtures/scenes/body-floor.gltf&sceneScale=1';
const STANDING_HEAD_Y = 1.6;
const baseUrl = new URL(SCENE_QUERY, process.env.BASE_URL ?? 'https://127.0.0.1:5174/').href;

const deg = (value) => (value * Math.PI) / 180;
const minJerk = (u) => u * u * u * (10 - 15 * u + 6 * u * u);

// Each action advances the head state; `pose` offsets (crouch/lean) live in
// the head's yaw frame and blend over the action's duration.
const SCENARIOS = {
  'walk-forward-back-side': {
    input: 'controller',
    actions: [
      { hold: 1.0 },
      { walk: [0, -3.4], speed: 1.2 },
      { hold: 1.0 },
      { walk: [0, 1.4], speed: 0.6 },
      { hold: 0.8 },
      { walk: [0.9, 0], speed: 0.5 },
      { hold: 0.8 },
      { walk: [-0.9, 0], speed: 0.5 },
      { hold: 1.2 }
    ]
  },
  'turn-in-place-and-arc': {
    input: 'controller',
    actions: [
      { hold: 1.0 },
      { turn: 90, sec: 1.0 },
      { hold: 1.0 },
      { turn: -180, sec: 1.6 },
      { hold: 1.0 },
      { turn: 90, sec: 1.0 },
      { hold: 0.8 },
      { arc: 90, radius: 1.5, speed: 1.0 },
      { hold: 1.0 },
      { glance: 30, sec: 0.8 },
      { glance: -30, sec: 0.8 },
      { hold: 1.0 }
    ]
  },
  'crouch-and-lean': {
    input: 'hand',
    actions: [
      { hold: 1.0 },
      { pose: { down: 0.45, forward: 0.05, pitch: -15 }, sec: 1.2 },
      { hold: 1.5 },
      { pose: {}, sec: 1.2 },
      { hold: 1.0 },
      { pose: { down: 0.06, forward: 0.25, pitch: -20 }, sec: 1.0 },
      { hold: 1.2 },
      { pose: {}, sec: 1.0 },
      { hold: 0.8 },
      { pose: { down: 0.02, side: -0.15, roll: 10 }, sec: 0.9 },
      { hold: 1.0 },
      { pose: {}, sec: 0.9 },
      { hold: 1.0 }
    ]
  },
  'small-steps-and-sway': {
    input: 'controller',
    actions: [
      { sway: 3.0 },
      { walk: [0, -0.3], speed: 0.45 },
      { hold: 1.0 },
      { walk: [0.25, 0], speed: 0.4 },
      { hold: 1.0 },
      { walk: [0, 0.3], speed: 0.45 },
      { hold: 1.0 },
      { walk: [-0.25, 0], speed: 0.4 },
      { sway: 2.0 }
    ]
  },
  'walk-ramp': {
    input: 'controller',
    actions: [
      { hold: 0.8 },
      { turn: 180, sec: 1.4 },
      { hold: 0.6 },
      { walk: [0, 4.0], speed: 1.0 },
      { hold: 1.2 }
    ]
  }
};

// Velocity profile for a walk of `distance` at cruise `speed`: raised-cosine
// ramps of `ramp` seconds at each end.
function walkProfile(distance, speed, ramp = 0.5) {
  const rampDistance = speed * ramp * 0.5;
  let cruise = speed;
  let rampSec = ramp;
  if (2 * rampDistance > distance) {
    cruise = Math.sqrt(distance * speed / ramp);
    rampSec = ramp * (cruise / speed);
  }
  const cruiseSec = Math.max(0, (distance - cruise * rampSec) / cruise);
  const total = 2 * rampSec + cruiseSec;
  const velocity = (t) => {
    if (t < rampSec) return cruise * 0.5 * (1 - Math.cos((Math.PI * t) / rampSec));
    if (t < rampSec + cruiseSec) return cruise;
    if (t < total) return cruise * 0.5 * (1 + Math.cos((Math.PI * (t - rampSec - cruiseSec)) / rampSec));
    return 0;
  };
  return { total, velocity };
}

function* headPath(actions) {
  const state = { x: 0, z: 0, yaw: 0, glance: 0, pose: { down: 0, forward: 0, side: 0, pitch: 0, roll: 0 }, speed: 0, phase: 0, t: 0 };
  const emit = () => ({ ...state, pose: { ...state.pose } });
  const advanceGait = (speed) => {
    state.speed = speed;
    state.phase += (1.4 + 0.45 * speed) * STEP_SEC;
  };
  for (const action of actions) {
    if (action.hold !== undefined || action.sway !== undefined) {
      const seconds = action.hold ?? action.sway;
      for (let t = 0; t < seconds; t += STEP_SEC) {
        advanceGait(0);
        state.t += STEP_SEC;
        state.swaying = action.sway !== undefined;
        yield emit();
      }
      state.swaying = false;
    } else if (action.walk) {
      const [dx, dz] = action.walk;
      const distance = Math.hypot(dx, dz);
      const { total, velocity } = walkProfile(distance, action.speed);
      for (let t = 0; t < total; t += STEP_SEC) {
        const v = velocity(t + STEP_SEC / 2);
        state.x += (dx / distance) * v * STEP_SEC;
        state.z += (dz / distance) * v * STEP_SEC;
        advanceGait(v);
        state.t += STEP_SEC;
        yield emit();
      }
    } else if (action.turn !== undefined) {
      const from = state.yaw;
      for (let t = STEP_SEC; t <= action.sec + 1e-9; t += STEP_SEC) {
        state.yaw = from + deg(action.turn) * minJerk(t / action.sec);
        advanceGait(0);
        state.t += STEP_SEC;
        yield emit();
      }
    } else if (action.arc !== undefined) {
      // Arc to the left at constant radius; yaw follows the tangent.
      const length = deg(Math.abs(action.arc)) * action.radius;
      const { total, velocity } = walkProfile(length, action.speed);
      const sign = Math.sign(action.arc);
      for (let t = 0; t < total; t += STEP_SEC) {
        const v = velocity(t + STEP_SEC / 2);
        state.yaw += (sign * v * STEP_SEC) / action.radius;
        state.x += -Math.sin(state.yaw) * v * STEP_SEC;
        state.z += -Math.cos(state.yaw) * v * STEP_SEC;
        advanceGait(v);
        state.t += STEP_SEC;
        yield emit();
      }
    } else if (action.glance !== undefined) {
      for (let t = STEP_SEC; t <= action.sec + 1e-9; t += STEP_SEC) {
        state.glance = deg(action.glance) * Math.sin(Math.PI * (t / action.sec));
        advanceGait(0);
        state.t += STEP_SEC;
        yield emit();
      }
      state.glance = 0;
    } else if (action.pose) {
      const from = { ...state.pose };
      const to = { down: 0, forward: 0, side: 0, pitch: 0, roll: 0, ...action.pose };
      for (let t = STEP_SEC; t <= action.sec + 1e-9; t += STEP_SEC) {
        const s = minJerk(t / action.sec);
        for (const key of Object.keys(to)) state.pose[key] = from[key] + (to[key] - from[key]) * s;
        advanceGait(0);
        state.t += STEP_SEC;
        yield emit();
      }
    }
  }
}

// Head pose in local-floor space plus hands, for one generated state.
function deviceFrame(state) {
  const forward = [-Math.sin(state.yaw), -Math.cos(state.yaw)];
  const right = [Math.cos(state.yaw), -Math.sin(state.yaw)];
  const gait = Math.min(1, state.speed / 1.2);
  // Vertical bob at step frequency, lateral sway at stride frequency.
  let bob = -0.018 * gait * Math.cos(2 * Math.PI * state.phase);
  let sway = 0.015 * gait * Math.sin(Math.PI * state.phase);
  let yawSway = 0;
  if (state.swaying) {
    sway += 0.03 * Math.sin(2 * Math.PI * 0.35 * state.t);
    bob += 0.01 * Math.sin(2 * Math.PI * 0.5 * state.t + 1);
    yawSway = deg(8) * Math.sin(2 * Math.PI * 0.3 * state.t);
  }
  const lateral = sway + state.pose.side;
  const along = state.pose.forward + (state.swaying ? 0.02 * Math.sin(2 * Math.PI * 0.27 * state.t) : 0);
  const head = [
    state.x + right[0] * lateral + forward[0] * along,
    STANDING_HEAD_Y - state.pose.down + bob,
    state.z + right[1] * lateral + forward[1] * along
  ];
  const yaw = state.yaw + state.glance + yawSway;
  const pitch = deg(state.pose.pitch);
  const roll = deg(state.pose.roll) - Math.sin(Math.PI * state.phase) * deg(2) * gait;
  // Quaternion from yaw (Y), then pitch (X), then roll (Z).
  const [cy, sy] = [Math.cos(yaw / 2), Math.sin(yaw / 2)];
  const [cp, sp] = [Math.cos(pitch / 2), Math.sin(pitch / 2)];
  const [cr, sr] = [Math.cos(roll / 2), Math.sin(roll / 2)];
  const quaternion = [
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    cy * cp * cr + sy * sp * sr
  ];
  // Hands hang in front of the hips, swinging opposite the legs. They hang
  // from the shoulders, which travel only part of a lean (the torso pivots
  // at the hips), not rigidly with the head.
  const hands = {};
  const shoulderLag = 0.45 * state.pose.forward;
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? -1 : 1;
    const swing = 0.1 * gait * Math.sin(Math.PI * state.phase) * sign;
    const out = 0.22;
    const ahead = 0.2 + swing - shoulderLag;
    hands[side] = {
      position: [
        head[0] + right[0] * out * sign + forward[0] * ahead,
        head[1] - 0.62 + state.pose.down * 0.25,
        head[2] + right[1] * out * sign + forward[1] * ahead
      ],
      quaternion: [0, Math.sin(state.yaw / 2), 0, Math.cos(state.yaw / 2)]
    };
  }
  return { head, quaternion, hands };
}

const browser = await launchXrBrowser(chromium);
try {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const requested = process.argv.slice(2);
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (requested.length > 0 && !requested.includes(name)) continue;
    const page = await (await createXrContext(browser, { viewport: { width: 320, height: 180 } })).newPage();
    await attachXrEnvironment(page, { mode: 'iwer' });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await waitForPageFunctions(page, ['__setManualClock', 'advanceTime']);
    await waitForTextContentPrefix(page, '#status', 'loaded');
    await page.evaluate((input) => {
      window.__setManualClock(true, false);
      window.IWER_DEVICE.primaryInputMode = input;
    }, scenario.input);
    await waitForIwerRuntime(page);
    await enterIwerSessionFromButton(page, '#VRButton', {
      readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
    });
    // IWER's DevUI rewrites the device pose every frame unless control is
    // programmatic.
    await page.evaluate(() => {
      window.IWER_DEVICE.controlMode = 'programmatic';
    });
    await freezePageClock(page);
    const apply = (frame) => page.evaluate(({ head, quaternion, hands, input }) => {
      const device = window.IWER_DEVICE;
      device.position.set(...head);
      device.quaternion.set(...quaternion);
      for (const side of ['left', 'right']) {
        const target = input === 'hand' ? device.hands[side] : device.controllers[side];
        target.position.set(...hands[side].position);
        target.quaternion.set(...hands[side].quaternion);
      }
    }, { ...frame, input: scenario.input });

    const states = [...headPath(scenario.actions)];
    await apply(deviceFrame(states[0]));
    await page.clock.runFor(STEP_MS);
    const before = new Set(await readdir(SAVE_DIR).catch(() => []));
    const clickByText = (text) => page.evaluate((label) => {
      [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)?.click();
    }, text);
    await clickByText('Start Recording');
    await page.clock.runFor(STEP_MS);
    for (const state of states) {
      await apply(deviceFrame(state));
      await page.clock.runFor(STEP_MS);
    }
    await clickByText('Stop Recording');
    let created = null;
    for (let attempt = 0; attempt < 300 && !created; attempt += 1) {
      await page.clock.runFor(100);
      const after = await readdir(SAVE_DIR).catch(() => []);
      created = after.find((file) => !before.has(file) && file.endsWith('.json')) ?? null;
      if (!created) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!created) throw new Error(`${name}: input recording was not saved by the dev server.`);
    const target = path.join(FIXTURE_DIR, `iwer-${name}.json`);
    await rm(target, { force: true });
    await rename(path.join(SAVE_DIR, created), target);
    const recording = JSON.parse(await readFile(target, 'utf8'));
    console.log(`[body-fixtures] ${target}: ${recording.frames.length} frames, ${(recording.meta.durationMs / 1000).toFixed(1)} s, ${scenario.input}, query ${recording.meta.query}`);
    await page.context().close();
  }
} finally {
  await browser.close();
}
