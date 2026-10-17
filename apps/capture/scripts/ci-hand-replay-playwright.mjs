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

import { analyzeHandReplay, formatHandReport } from './lib/hand-fidelity.mjs';

// Replays headset input recorded by capture's dev recorder through the real
// WebXR path (IWER ActionPlayer → XRHand joints → retargeter → avatar) and
// measures how closely the avatar's hands follow the tracked hands.

const STEP_MS = 1000 / 30;
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const fixtureDir = process.env.HAND_REPLAY_FIXTURES ?? 'fixtures/input-recordings';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-hand-replay';
const videoFrameDir = process.env.HAND_REPLAY_VIDEO === '1' ? path.join(artifactDir, 'video-frames') : null;
const captureScreenshots = process.env.XR_CAPTURE_SUCCESS_SCREENSHOTS === '1';

const recordings = (await readdir(fixtureDir).catch(() => []))
  .filter((name) => name.endsWith('.json'))
  .sort();
if (recordings.length === 0) {
  throw new Error(`No input recordings in ${fixtureDir}. Record one on a headset (see apps/capture/README.md).`);
}
await mkdir(artifactDir, { recursive: true });

const browser = await launchXrBrowser(chromium);
const consoleErrors = [];
const reports = [];

async function replay(fileName) {
  const label = path.basename(fileName, '.json');
  const recording = JSON.parse(await readFile(path.join(fixtureDir, fileName), 'utf8'));
  const viewport = videoFrameDir ? { width: 960, height: 540 } : resolveSimulationViewport();
  const context = await createXrContext(browser, { viewport });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await attachXrEnvironment(page, { mode: 'iwer' });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', '__sampleHands', '__setHandOverlay', 'advanceTime']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  // Released frames only deliver XR input unless a video needs them drawn.
  await page.evaluate((draw) => {
    window.__setManualClock(true, draw);
    window.IWER_DEVICE.primaryInputMode = 'hand';
  }, Boolean(videoFrameDir));
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', {
    readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
  });
  if (videoFrameDir) {
    // Video frames: tracked-joint dots, a camera facing the avatar, and no
    // emulator or app chrome over the scene.
    await page.evaluate(() => {
      window.__setHandOverlay(true);
      window.__setSpectatorView(true);
      const devui = window.IWER_DEVICE.devui;
      for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
        if (element instanceof HTMLElement) element.style.display = 'none';
      }
    });
  }

  // Frozen page time makes IWER's playback advance only when the test
  // releases frames, so input and simulation stay in lockstep on any host.
  await freezePageClock(page);
  const durationMs = await page.evaluate(async (data) => {
    const session = window.IWER_DEVICE.activeSession;
    const refSpace = await session.requestReferenceSpace('local-floor');
    window.__replayPlayer = window.IWER_DEVICE.createActionPlayer(refSpace, data);
    window.__replayPlayer.play();
    return window.__replayPlayer.duration;
  }, recording);

  const frames = [];
  const totalSteps = Math.floor(durationMs / STEP_MS);
  for (let index = 0; index < totalSteps; index += 1) {
    await page.clock.runFor(STEP_MS);
    const sample = await page.evaluate((ms) => {
      window.advanceTime(ms);
      const state = JSON.parse(window.render_game_to_text());
      return {
        timeMs: window.__replayPlayer.currentTime,
        hands: window.__sampleHands(),
        state: { mode: state.mode, avatar: state.avatar, character: state.character.position, tracking: { left: { poseValid: state.tracking.left.poseValid, target: state.tracking.left.targetPosition, bone: state.tracking.left.bonePosition, sensor: state.tracking.left.sensorPosition }, right: { poseValid: state.tracking.right.poseValid, target: state.tracking.right.targetPosition, bone: state.tracking.right.bonePosition, sensor: state.tracking.right.sensorPosition } } }
      };
    }, STEP_MS);
    frames.push(sample);
    if (videoFrameDir) {
      await page.screenshot({ path: path.join(videoFrameDir, label, `${String(index).padStart(5, '0')}.png`) });
    }
  }

  if (captureScreenshots) {
    await captureXrScreenshot(page, path.join(artifactDir, `${label}-final.png`));
  }
  if (videoFrameDir) {
    const videoPath = path.join(artifactDir, `${label}.mp4`);
    const encoded = spawnSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-framerate', String(Math.round(1000 / STEP_MS)),
      '-i', path.join(videoFrameDir, label, '%05d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', videoPath
    ], { stdio: 'inherit' });
    console.log(encoded.status === 0 ? `[hand-replay] video: ${videoPath}` : '[hand-replay] ffmpeg unavailable; frames kept as PNGs');
  }
  await writeFile(path.join(artifactDir, `${label}-samples.json`), JSON.stringify(frames));
  const report = analyzeHandReplay(frames, { stepMs: STEP_MS });
  report.label = label;
  report.durationMs = durationMs;
  await writeFile(path.join(artifactDir, `${label}-report.json`), JSON.stringify(report, null, 2));
  return report;
}

try {
  if (videoFrameDir) {
    for (const fileName of recordings) {
      await mkdir(path.join(videoFrameDir, path.basename(fileName, '.json')), { recursive: true });
    }
  }
  for (const fileName of recordings) {
    const report = await replay(fileName);
    reports.push(report);
    console.log(formatHandReport(report));
  }
  const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.label}: ${failure}`));
  if (consoleErrors.length > 0) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
  if (failures.length > 0) {
    throw new Error(`Hand replay fidelity failed:\n- ${failures.join('\n- ')}`);
  }
  console.log('Hand replay fidelity check passed.');
} finally {
  await browser.close();
}
