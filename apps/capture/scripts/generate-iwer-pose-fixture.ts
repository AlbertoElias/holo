import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  waitForTextContentPrefix,
  waitForXrRenderLoop
} from '@holoim/tooling-testing/xr-env';

import { installHandBlend } from './lib/iwer-hand-blend.mjs';
import { calibrateTipShift, installPointingRig, REST, runPointingTake } from './lib/pointing-take.mjs';

// Regenerates fixtures/input-recordings/iwer-poses-relaxed-point-pinch.json:
// both hands move through IWER's captured relaxed, point, and pinch poses with
// eased transitions, recorded by capture's own input recorder on a frozen
// clock. Regeneration reproduces the same motion (the recording window can
// shift by a frame because recording starts asynchronously); replaying the
// committed file is deterministic. These are emulator poses, not a headset
// session; they give the hand check known shapes to compare against.
//
// POSE_FIXTURE=pointing instead writes fixtures/pointing-recordings/
// iwer-pointing-targets.json and its labels (fixtures/pointing-labels/), a
// take in the generated pointing-targets scene: the right index finger points
// at TargetA, at the avatar's own left hand, at TargetB and (held, without
// releasing) back at TargetA, then into empty sky, then for 0.2 s only. Labels
// carry the intended referent of each point, which the pointing check scores.

const STEP_MS = 1000 / 30;
const FIXTURE_DIR = 'fixtures/input-recordings';
const FIXTURE_NAME = 'iwer-poses-relaxed-point-pinch.json';
const SCENARIO = process.env.POSE_FIXTURE ?? 'relaxed-point-pinch';
if (!['relaxed-point-pinch', 'pointing'].includes(SCENARIO)) throw new Error(`Unknown POSE_FIXTURE ${SCENARIO}`);
const POINTING = SCENARIO === 'pointing';
const POINTING_FIXTURE_DIR = 'fixtures/pointing-recordings';
const POINTING_FIXTURE_NAME = 'iwer-pointing-targets.json';
const POINTING_LABELS = 'fixtures/pointing-labels/iwer-pointing-targets.json';
const baseUrl = new URL(
  POINTING ? '?scene=/fixtures/scenes/pointing-targets.gltf&sceneScale=1&manualClock=1' : '',
  process.env.BASE_URL ?? 'https://127.0.0.1:5174/'
).href;

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

  await page.evaluate(installHandBlend);

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

  let pointingLabels = null;
  if (POINTING) {
    await waitForXrRenderLoop(page);
    // Frames tick the simulation, so tracked hands exist to aim at.
    await page.evaluate(() => window.__setFrameStepping(true, false));
    await page.evaluate(installPointingRig);
    await page.evaluate((rest) => window.__applyPointState({ right: { s: 0, rest: rest.right }, left: { pos: rest.left } }), REST);
    const tipShift = await calibrateTipShift({ page, stepMs: STEP_MS, readRightTip: () => page.evaluate(() => window.__sampleHands().right.tracked['index-finger-tip']) });
    console.log(`[pose-fixture] tracked fingertip offset ${tipShift.map((v) => v.toFixed(3)).join(', ')}`);
    await clickByText('Start Recording');
    await page.clock.runFor(STEP_MS);
    pointingLabels = await runPointingTake({
      page,
      stepMs: STEP_MS,
      readLeftPalm: () => page.evaluate(() => {
        const { wrist, 'middle-finger-phalanx-proximal': knuckle } = window.__sampleHands().left.tracked;
        return wrist.map((v, i) => (v + knuckle[i]) / 2);
      }),
      tipShift
    });
  } else {
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

  const target = POINTING ? path.join(POINTING_FIXTURE_DIR, POINTING_FIXTURE_NAME) : path.join(FIXTURE_DIR, FIXTURE_NAME);
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { force: true });
  await rename(path.join(FIXTURE_DIR, created), target);
  const recording = JSON.parse(await readFile(target, 'utf8'));
  if (pointingLabels) {
    await mkdir(path.dirname(POINTING_LABELS), { recursive: true });
    await writeFile(POINTING_LABELS, `${JSON.stringify({
      fixture: `pointing-recordings/${POINTING_FIXTURE_NAME}`,
      scene: '/fixtures/scenes/pointing-targets.gltf',
      source: 'IWER-synthetic take from scripts/lib/pointing-take.mjs; times are seconds from the first recorded frame, referents are what the pointing finger was aimed at',
      useFor: 'timing and referents',
      referentNote: 'TargetA and TargetB are node names (exported as <name>_RecordedBubble); leftHand is the humanoid bone of the avatar hand that was pointed at; null is empty sky',
      hand: 'right',
      durationSec: pointingLabels.durationSec,
      points: pointingLabels.labels
    }, null, 2)}\n`);
    console.log(`[pose-fixture] labels: ${POINTING_LABELS}`);
  }
  console.log(`[pose-fixture] ${target}: ${recording.frames.length} frames, ${(recording.meta.durationMs / 1000).toFixed(1)} s, source ${recording.meta.source}`);
} finally {
  await browser.close();
}
