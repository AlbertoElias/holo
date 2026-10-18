import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import {
  attachXrEnvironment,
  captureXrScreenshot,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  launchXrBrowser,
  resolveSimulationViewport,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

import { analyzeBodyReplay, formatBodyReport } from './lib/body-fidelity.mjs';

// Replays room-scale headset input (walking, turning, crouching, leaning,
// stepping) through the real WebXR path and measures the avatar's whole body
// against the recorded head. The simulation ticks inside each XR frame, as on
// a headset, on a frozen page clock released one 30 Hz step at a time.
//
// BODY_REPLAY_FAULTS=1 instead breaks each behavior in turn (debug hook
// __setBodyFaults) and requires the named metric to fail, proving the check
// can catch it.

const STEP_MS = 1000 / 30;
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const fixtureDir = process.env.BODY_REPLAY_FIXTURES ?? 'fixtures/body-recordings';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-body-replay';
const videoFrameDir = process.env.BODY_REPLAY_VIDEO === '1' ? path.join(artifactDir, 'video-frames') : null;
const captureScreenshots = process.env.XR_CAPTURE_SUCCESS_SCREENSHOTS === '1';
const faultMode = process.env.BODY_REPLAY_FAULTS === '1';

// Fault → fixture to replay and the metrics of which at least one must fail.
const FAULTS = {
  'rig-follows-avatar': { fixture: 'iwer-turn-in-place-and-arc', metrics: ['rigDriftM'] },
  'root-ignores-head': { fixture: 'iwer-walk-forward-back-side', metrics: ['eyeErrorWalkingP95M', 'eyeErrorMaxM'] },
  'body-yaw-snaps': { fixture: 'iwer-turn-in-place-and-arc', metrics: ['turnLagMinSec'] },
  'feet-glued-to-root': { fixture: 'iwer-walk-forward-back-side', metrics: ['footDriftMaxM', 'skatingShare'] },
  'pelvis-ignores-crouch': { fixture: 'iwer-crouch-and-lean', metrics: ['crouchRatio'] },
  'no-spine-lean': { fixture: 'iwer-crouch-and-lean', metrics: ['leanCorrelation'] },
  'head-not-rotated': { fixture: 'iwer-crouch-and-lean', metrics: ['headPitchErrorP95Deg'] },
  'root-overshoots': { fixture: 'iwer-walk-forward-back-side', metrics: ['rootOvershootM'] },
  'feet-float': { fixture: 'iwer-small-steps-and-sway', metrics: ['plantedSoleHeightMaxM'] },
  'pelvis-jitter': { fixture: 'iwer-small-steps-and-sway', metrics: ['pelvisJerkRatio'] },
  'feet-cross': { fixture: 'iwer-walk-forward-back-side', metrics: ['footSeparationMinM'] },
  'fidget-steps': { fixture: 'iwer-small-steps-and-sway', metrics: ['stepsWhileStillMax'] }
};

const fixtures = (await readdir(fixtureDir).catch(() => []))
  .filter((name) => name.endsWith('.json'))
  .sort();
if (fixtures.length === 0) throw new Error(`No body recordings in ${fixtureDir}. Run fixtures:body or record one on a headset (apps/capture/README.md).`);
await mkdir(artifactDir, { recursive: true });

const browser = await launchXrBrowser(chromium);
const consoleErrors = [];

async function replay(fileName, { faults = [], video = false, screenshot = false } = {}) {
  const label = `${path.basename(fileName, '.json')}${faults.length ? `--${faults.join('+')}` : ''}`;
  const recording = JSON.parse(await readFile(path.join(fixtureDir, fileName), 'utf8'));
  const viewport = video ? { width: 1280, height: 720 } : resolveSimulationViewport();
  const context = await createXrContext(browser, { viewport });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await attachXrEnvironment(page, { mode: 'iwer' });
  // Load the environment the input was recorded in.
  await page.goto(new URL(recording.meta?.query ?? '', baseUrl).href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', '__setFrameStepping', '__sampleBody', '__setBodyFaults', 'advanceTime']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate((list) => {
    window.__setManualClock(true, false);
    window.__setBodyFaults(list);
  }, faults);
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', {
    readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
  });
  if (video) {
    await page.evaluate(() => {
      window.__setSpectatorView('body');
      const devui = window.IWER_DEVICE.devui;
      for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
        if (element instanceof HTMLElement) element.style.display = 'none';
      }
    });
  }
  await freezePageClock(page);
  const durationMs = await page.evaluate(async ({ data, draw }) => {
    const session = window.IWER_DEVICE.activeSession;
    const refSpace = await session.requestReferenceSpace('local-floor');
    window.__replayPlayer = window.IWER_DEVICE.createActionPlayer(refSpace, data);
    window.__replayPlayer.play();
    // From here every XR frame ticks the simulation, as on a headset.
    window.__setFrameStepping(true, draw);
    return window.__replayPlayer.duration;
  }, { data: recording, draw: video });

  const frames = [];
  const totalSteps = Math.floor(durationMs / STEP_MS);
  for (let index = 0; index < totalSteps; index += 1) {
    await page.clock.runFor(STEP_MS);
    const frame = await page.evaluate(() => {
      const hands = window.__sampleHands();
      const wrist = (side) => ({ source: hands[side].source, tracked: { wrist: hands[side].tracked.wrist }, avatar: { wrist: hands[side].avatar.wrist } });
      return { timeMs: window.__replayPlayer.currentTime, body: window.__sampleBody(), hands: { left: wrist('left'), right: wrist('right') } };
    });
    // Once playback ends IWER returns the headset to its default pose.
    if (frame.timeMs >= durationMs - 1) break;
    frames.push(frame);
    if (video) await page.screenshot({ path: path.join(videoFrameDir, label, `${String(index).padStart(5, '0')}.png`) });
  }

  if (screenshot) {
    await page.evaluate(() => {
      window.__setSpectatorView('body');
      window.__setFrameStepping(true, true);
    });
    await captureXrScreenshot(page, path.join(artifactDir, `${label}-final.png`));
  }
  if (video) {
    const videoPath = path.join(artifactDir, `${label}.mp4`);
    const encoded = spawnSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-framerate', String(Math.round(1000 / STEP_MS)),
      '-i', path.join(videoFrameDir, label, '%05d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', videoPath
    ], { stdio: 'inherit' });
    console.log(encoded.status === 0 ? `[body-replay] video: ${videoPath}` : '[body-replay] ffmpeg unavailable; frames kept as PNGs');
  }
  // Contexts stay open until the browser closes: closing one mid-run makes
  // the next wait on GPU teardown (see ci-vr-locomotion-playwright.mjs).
  await writeFile(path.join(artifactDir, `${label}-samples.json`), JSON.stringify(frames));
  const report = analyzeBodyReplay(frames, { stepMs: STEP_MS, recording });
  report.label = label;
  report.frames = frames.length;
  report.durationMs = durationMs;
  report.source = recording.meta?.source ?? 'unknown';
  await writeFile(path.join(artifactDir, `${label}-report.json`), JSON.stringify(report, null, 2));
  return report;
}

try {
  if (faultMode) {
    const outcomes = [];
    for (const [fault, { fixture, metrics }] of Object.entries(FAULTS)) {
      const report = await replay(`${fixture}.json`, { faults: [fault] });
      const caught = report.failures.filter((failure) => metrics.some((metric) => failure.startsWith(`${metric}:`)));
      outcomes.push({ fault, fixture, expected: metrics, caught: caught.length > 0, failures: report.failures });
      console.log(`[body-faults] ${fault} on ${fixture}: ${caught.length ? `caught — ${caught.join('; ')}` : `NOT caught (failures: ${report.failures.join('; ') || 'none'})`}`);
    }
    await writeFile(path.join(artifactDir, 'fault-matrix.json'), JSON.stringify(outcomes, null, 2));
    const missed = outcomes.filter((outcome) => !outcome.caught);
    if (missed.length > 0) throw new Error(`Body metrics missed faults: ${missed.map((outcome) => outcome.fault).join(', ')}`);
    console.log(`Body fault matrix passed: ${outcomes.length} faults, each caught by its metric.`);
  } else {
    if (videoFrameDir) {
      for (const fileName of fixtures) await mkdir(path.join(videoFrameDir, path.basename(fileName, '.json')), { recursive: true });
    }
    const reports = [];
    for (const fileName of fixtures) {
      const report = await replay(fileName, { video: Boolean(videoFrameDir), screenshot: captureScreenshots });
      reports.push(report);
      console.log(formatBodyReport(report));
    }
    const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.label}: ${failure}`));
    if (consoleErrors.length > 0) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
    if (failures.length > 0) throw new Error(`Body replay fidelity failed:\n- ${failures.join('\n- ')}`);
    console.log('Body replay fidelity check passed.');
  }
} finally {
  await browser.close();
}
