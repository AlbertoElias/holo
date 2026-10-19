import { readdir, readFile, rename, rm } from 'node:fs/promises';
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

// Regenerates fixtures/input-recordings/iwer-poses-relaxed-point-pinch.json:
// both hands move through IWER's captured relaxed, point, and pinch poses with
// eased transitions, recorded by capture's own input recorder on a frozen
// clock. Regeneration reproduces the same motion (the recording window can
// shift by a frame because recording starts asynchronously); replaying the
// committed file is deterministic. These are emulator poses, not a headset
// session; they give the hand check known shapes to compare against.

const STEP_MS = 1000 / 30;
const FIXTURE_DIR = 'fixtures/input-recordings';
const FIXTURE_NAME = 'iwer-poses-relaxed-point-pinch.json';
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';

// [pose to reach, seconds to blend into it, seconds to hold it]
const TIMELINE = [
  ['default', 0, 0.6],
  ['point', 0.5, 0.8],
  ['default', 0.5, 0.4],
  ['pinch', 0.5, 0.7],
  ['default', 0.5, 0.4],
  ['point', 0.5, 0.6],
  ['pinch', 0.5, 0.6],
  ['default', 0.6, 0.5]
];

const browser = await launchXrBrowser(chromium);
try {
  const page = await (await createXrContext(browser, { viewport: { width: 320, height: 180 } })).newPage();
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', 'advanceTime']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => {
    window.__setManualClock(true, false);
    window.IWER_DEVICE.primaryInputMode = 'hand';
  });
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', {
    readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
  });

  // IWER's DevUI rewrites device and hand transforms every frame unless
  // control is programmatic; without this the hands never left its defaults.
  await page.evaluate(() => {
    window.IWER_DEVICE.controlMode = 'programmatic';
  });

  // A writable "blend" pose per hand, interpolated between IWER's captured
  // poses (translation lerp, rotation slerp per joint).
  await page.evaluate(() => {
    const quatFromMatrix = (m) => {
      const [m00, m10, m20, , m01, m11, m21, , m02, m12, m22] = m;
      const trace = m00 + m11 + m22;
      let x; let y; let z; let w;
      if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
      } else if (m00 > m11 && m00 > m22) {
        const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
        w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
      } else if (m11 > m22) {
        const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
        w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
      } else {
        const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
        w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
      }
      return [x, y, z, w];
    };
    const slerp = (a, b, t) => {
      let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
      const sign = cos < 0 ? -1 : 1;
      cos *= sign;
      if (cos > 0.9995) {
        const out = a.map((value, i) => value + (sign * b[i] - value) * t);
        const n = Math.hypot(...out);
        return out.map((value) => value / n);
      }
      const theta = Math.acos(cos);
      const wa = Math.sin((1 - t) * theta) / Math.sin(theta);
      const wb = (sign * Math.sin(t * theta)) / Math.sin(theta);
      return a.map((value, i) => wa * value + wb * b[i]);
    };
    const compose = ([x, y, z, w], [tx, ty, tz]) => [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
      tx, ty, tz, 1
    ];
    // Hierarchical blend: each joint's rotation and offset relative to its
    // parent joint is interpolated, then the hand is rebuilt from the wrist
    // out, so fingers rotate about their joints instead of cutting chords.
    const fingers = ['thumb', 'index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
    const parentOf = { wrist: null };
    for (const finger of fingers) {
      const chain = finger === 'thumb'
        ? ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip']
        : ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((part) => `${finger}-${part}`);
      chain.forEach((joint, i) => { parentOf[joint] = i === 0 ? 'wrist' : chain[i - 1]; });
    }
    const order = Object.keys(parentOf);
    const conj = ([x, y, z, w]) => [-x, -y, -z, w];
    const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz
    ];
    const rotate = (q, [x, y, z]) => qmul(qmul(q, [x, y, z, 0]), conj(q)).slice(0, 3);
    const rigid = (m) => ({ q: quatFromMatrix(m), t: [m[12], m[13], m[14]] });
    const locals = (pose) => Object.fromEntries(order.map((joint) => {
      const self = rigid(pose.jointTransforms[joint].offsetMatrix);
      const parent = parentOf[joint];
      if (!parent) return [joint, self];
      const base = rigid(pose.jointTransforms[parent].offsetMatrix);
      const inv = conj(base.q);
      return [joint, { q: qmul(inv, self.q), t: rotate(inv, self.t.map((v, i) => v - base.t[i])) }];
    }));
    window.__blendHands = (fromId, toId, t) => {
      for (const hand of [window.IWER_DEVICE.hands.left, window.IWER_DEVICE.hands.right]) {
        const key = Object.getOwnPropertySymbols(hand).find((symbol) => hand[symbol]?.poses);
        const { poses } = hand[key];
        const from = poses[fromId];
        const to = poses[toId];
        const a = locals(from);
        const b = locals(to);
        const world = {};
        const blend = { jointTransforms: {} };
        if (from.gripOffsetMatrix && to.gripOffsetMatrix) {
          const gripFrom = rigid(from.gripOffsetMatrix);
          const gripTo = rigid(to.gripOffsetMatrix);
          blend.gripOffsetMatrix = new Float32Array(compose(
            slerp(gripFrom.q, gripTo.q, t),
            gripFrom.t.map((v, i) => v + (gripTo.t[i] - v) * t)
          ));
        }
        for (const joint of order) {
          const q = slerp(a[joint].q, b[joint].q, t);
          const local = a[joint].t.map((v, i) => v + (b[joint].t[i] - v) * t);
          const parent = parentOf[joint] && world[parentOf[joint]];
          world[joint] = parent
            ? { q: qmul(parent.q, q), t: rotate(parent.q, local).map((v, i) => v + parent.t[i]) }
            : { q, t: local };
          const fromRadius = from.jointTransforms[joint].radius;
          blend.jointTransforms[joint] = {
            offsetMatrix: new Float32Array(compose(world[joint].q, world[joint].t)),
            radius: fromRadius + (to.jointTransforms[joint].radius - fromRadius) * t
          };
        }
        poses.blend = blend;
        hand.poseId = 'blend';
        hand.updatePinchValue(0);
        hand.updateHandPose();
      }
    };
  });

  await freezePageClock(page);
  const before = new Set(await readdir(FIXTURE_DIR).catch(() => []));
  const clickByText = (text) => page.evaluate((label) => {
    [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)?.click();
  }, text);

  const placeHands = (seconds) => page.evaluate((s) => {
    // Hands held in front of the face, drifting slightly so wrists move too.
    const sway = Math.sin(s * 1.3) * 0.03;
    window.IWER_DEVICE.hands.left.position.set(-0.17, 1.38 + sway, -0.32);
    window.IWER_DEVICE.hands.right.position.set(0.17, 1.38 - sway, -0.32);
  }, seconds);

  let elapsed = 0;
  let current = TIMELINE[0][0];
  await page.evaluate((pose) => window.__blendHands(pose, pose, 1), current);
  await placeHands(0);
  await page.clock.runFor(STEP_MS);
  await clickByText('Start Recording');
  await page.clock.runFor(STEP_MS);

  for (const [target, blendSeconds, holdSeconds] of TIMELINE) {
    const blendSteps = Math.round((blendSeconds * 1000) / STEP_MS);
    const holdSteps = Math.round((holdSeconds * 1000) / STEP_MS);
    for (let step = 1; step <= blendSteps + holdSteps; step += 1) {
      const raw = Math.min(1, step / Math.max(1, blendSteps));
      const eased = raw * raw * (3 - 2 * raw);
      await page.evaluate(({ from, to, t }) => window.__blendHands(from, to, t), { from: current, to: target, t: eased });
      elapsed += STEP_MS / 1000;
      await placeHands(elapsed);
      await page.clock.runFor(STEP_MS);
    }
    current = target;
  }

  await clickByText('Stop Recording');
  // Export runs on animation frames; release them until the file lands.
  let created = null;
  for (let attempt = 0; attempt < 300 && !created; attempt += 1) {
    await page.clock.runFor(100);
    const after = await readdir(FIXTURE_DIR).catch(() => []);
    created = after.find((name) => !before.has(name) && name.endsWith('.json')) ?? null;
    if (!created) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!created) throw new Error('Input recording was not saved by the dev server.');

  const target = path.join(FIXTURE_DIR, FIXTURE_NAME);
  await rm(target, { force: true });
  await rename(path.join(FIXTURE_DIR, created), target);
  const recording = JSON.parse(await readFile(target, 'utf8'));
  console.log(`[pose-fixture] ${target}: ${recording.frames.length} frames, ${(recording.meta.durationMs / 1000).toFixed(1)} s, source ${recording.meta.source}`);
} finally {
  await browser.close();
}
