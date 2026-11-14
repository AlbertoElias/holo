import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import {
  enterIwerSessionFromButton,
  freezePageClock,
  launchXrBrowser,
  waitForIwerRuntime,
  waitForXrRenderLoop
} from '@holoim/tooling-testing/xr-env';

import { installMiddlePinchPose } from './lib/iwer-halo.ts';
import { clickButton, openCapture, proofPace, setupPage } from './lib/object-take.mjs';

// Held modes in a headset (TODOS item 8, held modes): the mark "this" is held
// on the non-dominant hand (its trigger, or a thumb–middle pinch), and a
// mode that ends early (the controller goes away, the take stops, the
// session ends) keeps its own release from also pressing chrome. That
// release arrives only when the hand lets go; this replays the orders where
// it must not be waited for forever: the next select on that hand has to
// press chrome as usual. Each phase drives IWER's real controllers or hands
// and presses the world panel's Refit row with the holding hand's ray, then
// reads capture's own chrome counters. HELD_STATES_ONLY=<substring> keeps only matching phases.
// Writes output/ci-held-states/report.json.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = path.resolve(process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-held-states');
await mkdir(artifactDir, { recursive: true });

const STEP_MS = 1000 / 60;

function makeRows(failures) {
  const rows = [];
  const row = (name, ok, values = {}) => {
    rows.push({ name, pass: Boolean(ok), ...values });
    if (!ok) failures.push(`${name}: ${JSON.stringify(values)}`);
  };
  return { rows, row };
}

async function openIwer({ label, input = 'controller' }) {
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  // tsx compiles with keepNames, which wraps named inner functions of page.evaluate callbacks in a helper the page lacks.
  await page.addInitScript('globalThis.__name = (target) => target;');
  await openCapture(page, baseUrl, {});
  await page.evaluate(({ mode, draw }) => {
    window.__setManualClock(true, draw);
    window.IWER_DEVICE.primaryInputMode = mode;
  }, { mode: input, draw: Boolean(process.env.SUMMON_VIDEO_DIR) });
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  await page.evaluate(() => {
    window.IWER_DEVICE.controlMode = 'programmatic';
  });
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  await page.evaluate(() => window.__setFrameStepping(true, false));
  const s = { context, page };
  s.step = async (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      await page.clock.runFor(STEP_MS);
      await proofPace(page, STEP_MS);
    }
  };
  s.chrome = () => page.evaluate(() => window.__sampleChrome());
  s.holds = () => page.evaluate(() => window.__sampleHolds().headset);
  s.device = (fn, arg) => page.evaluate(fn, arg);
  await s.step(30);
  return s;
}

/** A controller's ray from `from` toward `target`, in the head's frame (the checks' world), as the capture-ui check aims. */
async function aimController(s, side, from, target) {
  await s.device(({ side, from, target }) => {
    const device = window.IWER_DEVICE;
    const head = window.__sampleChrome().vr.head;
    const offset = [head[0] - device.position.x, head[1] - device.position.y, head[2] - device.position.z];
    const controller = device.controllers[side];
    controller.position.set(from[0] - offset[0], from[1] - offset[1], from[2] - offset[2]);
    const [dx, dy, dz] = [target[0] - from[0], target[1] - from[1], target[2] - from[2]];
    const length = Math.hypot(dx, dy, dz);
    const [x, y, z] = [dx / length, dy / length, dz / length];
    const w = 1 - z;
    if (w < 1e-6) controller.quaternion.set(0, 1, 0, 0);
    else {
      const half = Math.hypot(y, -x, w);
      controller.quaternion.set(y / half, -x / half, 0, w / half);
    }
  }, { side, from, target });
  await s.step(3);
}

const trigger = (s, side, value) => s.device(({ side, value }) => window.IWER_DEVICE.controllers[side].updateButtonValue('trigger', value), { side, value });

/** One select with a controller: down, two frames, up, two frames. */
async function select(s, side) {
  await trigger(s, side, 1);
  await s.step(2);
  await trigger(s, side, 0);
  await s.step(2);
}

async function startTake(s) {
  await clickButton(s.page, 'Start Recording');
  await s.step(40);
}

/** Stops the take and steps until the export is done (the download is discarded). */
async function stopTake(s) {
  const download = s.page.waitForEvent('download', { timeout: 60_000 });
  await clickButton(s.page, 'Stop Recording');
  let settled = false;
  download.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 400 && !settled; i += 1) {
    await s.step(6);
    await new Promise((resolve) => setTimeout(resolve, 20)); // wall-clock: the export's encode runs off the page clock.
  }
  await download;
  for (let i = 0; i < 30; i += 1) {
    if ((await s.chrome()).ui.recordingState === 'idle') break;
    await s.step(6);
  }
}

/** Presses the Refit row with the left ray (the holding hand's), as a headset author does; returns the commits it made. */
async function pressRefitWithLeft(s) {
  const target = await s.device(() => window.__chromeTarget('refit'));
  if (!target) return { commits: null, panel: null };
  const before = (await s.chrome()).vr.feedback.commits;
  await aimController(s, 'left', [-0.15, 1.35, -0.15], target);
  await select(s, 'left');
  const after = (await s.chrome()).vr.feedback.commits;
  return { commits: after - before, panel: true };
}

async function runControllerPhase({ label, cutMark, describe, stopsTake = false }) {
  const failures = [];
  const { rows, row } = makeRows(failures);
  const s = await openIwer({ label });
  try {
    await s.device(() => {
      window.IWER_DEVICE.controllers.left.position.set(-0.22, 1.1, -0.3);
      window.IWER_DEVICE.controllers.right.position.set(0.22, 1.1, -0.3);
    });
    await s.step(10);
    const visible = (await s.chrome()).vr.panel?.visible;
    row('the world panel shows before the take', visible === true, { visible });
    if (cutMark) {
      await startTake(s);
      await trigger(s, 'left', 1);
      await s.step(6);
      const held = await s.holds();
      row('the left trigger holds the mark', held.mark.phase === 'held', { mark: held.mark });
      await cutMark(s);
      const ended = await s.holds();
      row('the mark has ended', ended.mark.phase === 'idle', { mark: ended.mark });
      await trigger(s, 'left', 0);
      await s.step(6);
      if (!stopsTake) await stopTake(s);
      await s.step(20);
    }
    const settled = await s.holds();
    const press = await pressRefitWithLeft(s);
    row(describe, press.commits === 1, { commits: press.commits, mark: settled.mark });
    return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
  } finally {
    await s.context.close();
  }
}

/** The left hand's ray from `from` toward `target` (a hand aims like a controller), then an ordinary thumb–index pinch select. */
async function pressRefitWithLeftHand(s) {
  const target = await s.device(() => window.__chromeTarget('refit'));
  if (!target) return { commits: null, panel: null };
  const before = (await s.chrome()).vr.feedback.commits;
  await s.device(({ target }) => {
    const device = window.IWER_DEVICE;
    const head = window.__sampleChrome().vr.head;
    const from = [-0.15, 1.35, -0.15];
    const offset = [head[0] - device.position.x, head[1] - device.position.y, head[2] - device.position.z];
    const hand = device.hands.left;
    hand.position.set(from[0] - offset[0], from[1] - offset[1], from[2] - offset[2]);
    const [dx, dy, dz] = [target[0] - from[0], target[1] - from[1], target[2] - from[2]];
    const length = Math.hypot(dx, dy, dz);
    const [x, y, z] = [dx / length, dy / length, dz / length];
    const w = 1 - z;
    if (w < 1e-6) hand.quaternion.set(0, 1, 0, 0);
    else {
      const half = Math.hypot(y, -x, w);
      hand.quaternion.set(y / half, -x / half, 0, w / half);
    }
  }, { target });
  await s.step(4);
  const rays = (await s.chrome()).vr.rays;
  await s.device(() => {
    const hand = window.IWER_DEVICE.hands.left;
    window.__setHandPoseId('left', 'pinch');
    hand.updatePinchValue(1);
  });
  await s.step(4);
  await s.device(() => {
    window.IWER_DEVICE.hands.left.updatePinchValue(0);
    window.__setHandPoseId('left', 'default');
  });
  await s.step(4);
  const after = (await s.chrome()).vr.feedback.commits;
  return { commits: after - before, panel: true, rays };
}

async function runHandsPhase({ label, hold, describe }) {
  const failures = [];
  const { rows, row } = makeRows(failures);
  const s = await openIwer({ label, input: 'hand' });
  try {
    await s.device(installMiddlePinchPose);
    await s.device(() => {
      window.IWER_DEVICE.hands.left.position.set(-0.22, 1.1, -0.3);
      window.IWER_DEVICE.hands.right.position.set(0.22, 1.1, -0.3);
    });
    await s.step(10);
    const visible = (await s.chrome()).vr.panel?.visible;
    row('the world panel shows before the take', visible === true, { visible });
    if (hold) {
      await startTake(s);
      await s.device(() => window.__setHandPoseId('left', 'middlePinch'));
      await s.step(12);
      const held = await s.holds();
      row('the left thumb–middle pinch holds the mark', held.mark.phase === 'held', { mark: held.mark, pinches: held.pinches });
      await hold(s);
      const ended = await s.holds();
      row('the mark has ended', ended.mark.phase === 'idle', { mark: ended.mark });
      await s.device(() => window.__setHandPoseId('left', 'default'));
      await s.step(20);
    }
    const settled = await s.holds();
    const press = await pressRefitWithLeftHand(s);
    row(describe, press.commits === 1, { commits: press.commits, mark: settled.mark, rays: press.rays });
    return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
  } finally {
    await s.context.close();
  }
}

const browser = await launchXrBrowser(chromium);
const consoleErrors = [];
try {
  const takes = [];
  const only = process.env.HELD_STATES_ONLY;
  const wanted = (label) => !only || label.includes(only);
  if (wanted('control-no-hold')) takes.push(await runControllerPhase({ label: 'control-no-hold', cutMark: null, describe: 'with no hold at all, the left ray presses Refit' }));
  if (wanted('trigger-controller-lost')) takes.push(
    await runControllerPhase({
      label: 'trigger-controller-lost',
      cutMark: async (s) => {
        await s.device(() => {
          window.IWER_DEVICE.controllers.left.connected = false;
        });
        await s.step(10);
        await trigger(s, 'left', 0);
        await s.device(() => {
          window.IWER_DEVICE.controllers.left.connected = true;
        });
        await s.step(10);
      },
      describe: 'the controller went away mid-hold and came back: the first select on that hand presses Refit'
    })
  );
  if (wanted('trigger-take-stopped')) takes.push(
    await runControllerPhase({
      label: 'trigger-take-stopped',
      stopsTake: true,
      cutMark: stopTake,
      describe: 'the take stopped with the trigger held: after its release the first select presses Refit'
    })
  );
  if (wanted('hands-control-no-hold')) takes.push(await runHandsPhase({ label: 'hands-control-no-hold', hold: null, describe: 'with no hold at all, the left hand pinch presses Refit' }));
  if (wanted('pinch-take-stopped')) takes.push(
    await runHandsPhase({
      label: 'pinch-take-stopped',
      hold: stopTake,
      describe: 'the take stopped with the pinch held: after it opens the next ordinary pinch presses Refit'
    })
  );
  if (wanted('pinch-hand-lost')) takes.push(
    await runHandsPhase({
      label: 'pinch-hand-lost',
      hold: async (s) => {
        await s.device(() => {
          window.IWER_DEVICE.hands.left.connected = false;
        });
        await s.step(30);
        await s.device(() => {
          window.IWER_DEVICE.hands.left.connected = true;
          window.__setHandPoseId('left', 'default');
        });
        await s.step(10);
        await stopTake(s);
      },
      describe: 'the holding hand left the view mid-hold and came back open: its next ordinary pinch presses Refit'
    })
  );
  const failures = [...takes.flatMap((take) => take.failures.map((message) => `${take.label}: ${message}`)), ...consoleErrors.map((error) => `console: ${error}`)];
  const report = { status: failures.length ? 'fail' : 'pass', failures, takes };
  await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  for (const take of takes) console.log(`[held-states] ${take.label}: ${take.status}${take.failures.length ? `\n  ${take.failures.join('\n  ')}` : ''}`);
  console.log(`[held-states] report: ${path.join(artifactDir, 'report.json')}`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}
