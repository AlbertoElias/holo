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

import { openCapture, proofPace, readState, setupPage } from './lib/object-take.mjs';

// VR locomotion states (TODOS item 8, locomotion): the thumbstick's move and
// turn state is written by a poll of the real controllers' gamepads. Each
// phase drives IWER's real controller axes in the exact order a headset
// produces and reads capture's own state, so a stale stick (an input source
// that goes away while the stick is held, or a session that ends with it
// held) shows as walking, or as a stick value, that nobody is pushing.
// Writes output/ci-locomotion-states/report.json.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = path.resolve(process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-locomotion-states');
await mkdir(artifactDir, { recursive: true });

const STEP_MS = 1000 / 60;
const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
const travel = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

function makeRows(failures) {
  const rows = [];
  const row = (name, ok, values = {}) => {
    rows.push({ name, pass: Boolean(ok), ...values });
    if (!ok) failures.push(`${name}: ${JSON.stringify(values)}`);
  };
  return { rows, row };
}

async function openIwer({ browser, consoleErrors, label, input = 'controller' }) {
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  await openCapture(page, baseUrl, {});
  // SUMMON_VIDEO_DIR (a proof video, output/ only): draw the frames and pace each step in real time.
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
  s.state = () => readState(page);
  s.stick = (side, x, y) => page.evaluate(({ sd, px, py }) => window.IWER_DEVICE.controllers[sd].updateAxes('thumbstick', px, py), { sd: side, px: x, py: y });
  s.device = (fn, arg) => page.evaluate(fn, arg);
  await s.step(20);
  return s;
}

/** Stick pushed forward, then the controller goes away or the input switches, the stick still held: does the avatar keep walking? */
async function runInputLost({ label, lose, restore }) {
  const failures = [];
  const { rows, row } = makeRows(failures);
  const s = await openIwer({ browser, consoleErrors, label });
  try {
    const start = await s.state();
    await s.stick('left', 0, -1); // axes y is down-positive: -1 is forward
    await s.step(40);
    const walking = await s.state();
    row('stick forward walks', walking.thumbstick.moveY > 0.9 && travel(start.character.position, walking.character.position) > 0.3, {
      moveY: round(walking.thumbstick.moveY),
      travelM: round(travel(start.character.position, walking.character.position))
    });
    await s.device(lose);
    await s.step(5);
    const lost = await s.state();
    await s.step(60);
    const later = await s.state();
    const drift = travel(lost.character.position, later.character.position);
    row('with no controller reporting, nothing is pushed: the stick reads rest and the avatar stands', Math.abs(later.thumbstick.moveY) < 0.15 && drift < 0.05, {
      moveYAfterLoss: round(later.thumbstick.moveY),
      walkedWithNobodyPushingM: round(drift)
    });
    // The hand lets go of the stick while nothing reads it, then the controller reports again.
    await s.stick('left', 0, 0);
    await s.device(restore);
    await s.step(10);
    const back = await s.state();
    row('controller back with the stick let go meanwhile: stands', Math.abs(back.thumbstick.moveY) < 0.15, { moveY: round(back.thumbstick.moveY) });
    return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
  } finally {
    await s.context.close();
  }
}

/** The session ends with the stick held; the next one starts with hands only, so no controller reports the stick. */
async function runSessionEndHeld() {
  const label = 'session-end-held';
  const failures = [];
  const { rows, row } = makeRows(failures);
  const s = await openIwer({ browser, consoleErrors, label });
  const { page } = s;
  try {
    await s.stick('left', 0, -1);
    await s.step(20);
    await page.evaluate(() => window.IWER_DEVICE.activeSession.end());
    await s.step(10);
    const ended = await s.state();
    row('session ended: mode is no longer vr', ended.mode !== 'vr', { mode: ended.mode });
    row('the held stick is let go with the session', Math.abs(ended.thumbstick.moveY) < 0.15, { moveYAfterEnd: round(ended.thumbstick.moveY) });
    // Back in with hands only.
    await s.stick('left', 0, 0);
    await page.evaluate(() => {
      window.IWER_DEVICE.primaryInputMode = 'hand';
    });
    await page.clock.resume();
    await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
    await page.evaluate(() => {
      window.IWER_DEVICE.controlMode = 'programmatic';
    });
    await freezePageClock(page);
    await waitForXrRenderLoop(page);
    await page.evaluate(() => window.__setFrameStepping(true, false));
    await s.step(5);
    const entered = await s.state();
    await s.step(60);
    const later = await s.state();
    const drift = travel(entered.character.position, later.character.position);
    row('re-entered with hands only: the avatar stands', Math.abs(later.thumbstick.moveY) < 0.15 && drift < 0.05, {
      mode: later.mode,
      moveY: round(later.thumbstick.moveY),
      walkedWithNobodyPushingM: round(drift)
    });
    return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
  } finally {
    await s.context.close();
  }
}

const browser = await launchXrBrowser(chromium);
const consoleErrors = [];
try {
  const takes = [];
  takes.push(
    await runInputLost({
      label: 'controller-lost',
      lose: () => {
        window.IWER_DEVICE.controllers.left.connected = false;
      },
      restore: () => {
        window.IWER_DEVICE.controllers.left.connected = true;
      }
    })
  );
  takes.push(
    await runInputLost({
      label: 'switch-to-hands',
      lose: () => {
        window.IWER_DEVICE.primaryInputMode = 'hand';
      },
      restore: () => {
        window.IWER_DEVICE.primaryInputMode = 'controller';
      }
    })
  );
  takes.push(await runSessionEndHeld());
  const failures = [...takes.flatMap((take) => take.failures.map((message) => `${take.label}: ${message}`)), ...consoleErrors.map((error) => `console: ${error}`)];
  const report = { status: failures.length ? 'fail' : 'pass', failures, takes };
  await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  for (const take of takes) console.log(`[loco-states] ${take.label}: ${take.status}${take.failures.length ? `\n  ${take.failures.join('\n  ')}` : ''}`);
  console.log(`[loco-states] report: ${path.join(artifactDir, 'report.json')}`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}
