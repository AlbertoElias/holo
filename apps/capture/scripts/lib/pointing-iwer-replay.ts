import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import type { ActionPlayer, CompressedRecording, XRReferenceSpaceType } from 'iwer';

import {
  attachXrEnvironment,
  captureXrScreenshot,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';
import { writeContactSheet } from '@holoim/tooling-testing/preview';

import type {} from '../../src/runtime/automationHooks';
import { CONTROL_NAMES } from '@holoim/xr-ui-core';
import { TARGETS } from './pointing-scene.ts';
import {
  expectations,
  readGlbJson,
  scorePointing,
  TOLERANCE_SEC,
  type PointingLabels,
  type PointingLink,
  type PointingMatch,
  type PointingScore,
  type SilenceResult
} from './pointing-score.ts';

declare global {
  interface Window {
    __replayPlayer?: ActionPlayer;
  }
}

type Recording = CompressedRecording & { meta?: { query?: string } };

export type PointingReplayOptions = {
  browser: Browser;
  baseUrl: string;
  /** apps/capture: labels and recorded inputs resolve from it. */
  captureRoot: string;
  /** Relative to `captureRoot`. */
  labelsDir: string;
  artifactDir: string;
  consoleErrors: string[];
  labelFile: string;
};

export type PointingReplayReport = {
  label: string;
  labelsFile: string;
  fixture: string;
  useFor: string | undefined;
  glb: string;
  sheet: string | null;
  sheetTimesSec: number[];
  aim: Array<{ point: string; errorDeg: number }>;
  toleranceSec: number;
  alignment: string;
  durationMs: number;
  status: PointingScore['status'];
  failures: string[];
  matches: PointingMatch[];
  silence: SilenceResult[];
  links: PointingLink[];
};

// Replays one labelled headset-side pointing take through the real WebXR path
// (IWER ActionPlayer → XRHand joints → retargeter → avatar), records and exports
// with capture's own recorder, and scores the exported GLB against its labels.
// Shared by the capture pointing check and the viewer's pointing pipeline spec.

const STEP_MS = 1000 / 30;
const SHEET_VIEWPORT = { width: 960, height: 540 };

// Frames the contact sheet shows: the middle of every labelled window.
function sheetShots(labels: PointingLabels) {
  const { points, silent } = expectations(labels);
  return [...points, ...silent]
    .map((window) => ({ name: window.name, referent: window.referent, timeSec: (window.start + window.end) / 2 }))
    .sort((a, b) => a.timeSec - b.timeSec)
    .slice(0, 12);
}

const angleDeg = (a: number[], b: number[]) => {
  const dot = a.reduce((sum, v, i) => sum + v * b[i]!, 0) / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
};
const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);
// Sanity check on the synthetic take, independent of capture's detector: at a
// point's midpoint, the tracked index finger really aims at the intended referent.
const AIM_TOLERANCE_DEG = 6;

/**
 * `captureRoot` is apps/capture (labels and recorded inputs resolve from it);
 * `labelsDir` is relative to it. Returns the report, whose `glb` is the export.
 */
export async function replayPointingTake({ browser, baseUrl, captureRoot, labelsDir, artifactDir, consoleErrors, labelFile }: PointingReplayOptions): Promise<PointingReplayReport> {
  const recordingsDir = path.join(captureRoot, 'fixtures');
  const label = path.basename(labelFile, '.json');
  await mkdir(artifactDir, { recursive: true });
  const labels: PointingLabels = JSON.parse(await readFile(path.resolve(captureRoot, labelsDir, labelFile), 'utf8'));
  const recording: Recording = JSON.parse(await readFile(path.join(recordingsDir, labels.fixture), 'utf8'));
  const context = await createXrContext(browser, { viewport: SHEET_VIEWPORT, acceptDownloads: true });
  const page: Page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  // Capture's dev build saves the input behind every recording as a new
  // fixture; a replay must not write its own input back.
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"(discarded by the pointing check)"}' }));
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  const pageUrl = new URL(recording.meta?.query ?? '', baseUrl);
  // A take recorded without a scene (the real headset take) replays in the
  // scene its labels name, so its points hit geometry rather than sky.
  if (labels.scene && !pageUrl.searchParams.has('scene')) {
    pageUrl.searchParams.set('scene', labels.scene);
    pageUrl.searchParams.set('sceneScale', '1');
  }
  pageUrl.searchParams.set('manualClock', '1');
  await page.goto(pageUrl.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', '__setFrameStepping', '__setSpectatorView', '__setHandOverlay']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => {
    window.__setManualClock(true, false);
    window.IWER_DEVICE!.primaryInputMode = 'hand';
  });
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', {
    readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
  });
  // Screenshots show the scene, not the emulator's panels or the app's chrome.
  await page.evaluate(() => {
    const devui = window.IWER_DEVICE!.devui;
    for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
      if (element instanceof HTMLElement) element.style.display = 'none';
    }
  });
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  const durationMs = await page.evaluate(async (data) => {
    const session = window.IWER_DEVICE!.activeSession!;
    const refSpace = await session.requestReferenceSpace('local-floor' as XRReferenceSpaceType); // IWER types the name as an enum; the runtime value is the string
    // Created but not playing: recording starts first, then playback.
    window.__replayPlayer = window.IWER_DEVICE!.createActionPlayer(refSpace, data);
    window.__setFrameStepping(true, false);
    return window.__replayPlayer.duration;
  }, recording);

  const clickByText = (text: string) => page.evaluate((name) => {
    [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === name)?.click();
  }, text);
  await clickByText(CONTROL_NAMES.startRecording);
  await page.clock.runFor(STEP_MS);
  await page.evaluate(() => window.__replayPlayer!.play());

  const frameDir = path.join(artifactDir, `${label}-frames`);
  await mkdir(frameDir, { recursive: true });
  const shots = sheetShots(labels);
  // Hand close-ups show finger shape in the real take; the body view shows the arm aiming in the synthetic scene.
  const spectatorMode: 'body' | 'hands' = labels.useFor === 'timing and referents' ? 'body' : 'hands';
  const aim: Array<{ point: string; errorDeg: number }> = [];
  let nextShot = 0;
  const totalSteps = Math.floor(durationMs / STEP_MS);
  for (let index = 0; index < totalSteps; index += 1) {
    const due = nextShot < shots.length && index * STEP_MS / 1000 >= shots[nextShot]!.timeSec;
    if (due) {
      // One drawn frame: the spectator view with tracked-joint dots.
      await page.evaluate((mode) => {
        window.__setSpectatorView(mode);
        window.__setHandOverlay(true);
        window.__setFrameStepping(true, true);
      }, spectatorMode);
    }
    await page.clock.runFor(STEP_MS);
    if (due) {
      const shot = shots[nextShot]!;
      const target = shot.referent ? TARGETS[shot.referent]?.center : undefined;
      if (target || shot.referent === 'leftHand') {
        const hands = await page.evaluate(() => {
          const sample = window.__sampleHands();
          const { wrist, 'middle-finger-phalanx-proximal': knuckle } = sample.left.tracked;
          return { tip: sample.right.tracked['index-finger-tip']!, proximal: sample.right.tracked['index-finger-phalanx-proximal']!, leftPalm: wrist!.map((v, i) => (v + knuckle![i]!) / 2) };
        });
        aim.push({
          point: shot.name,
          errorDeg: Number(angleDeg(sub(hands.tip, hands.proximal), sub(target ?? hands.leftPalm, hands.tip)).toFixed(2))
        });
      }
      // Evidence for the contact sheet only: a 2-CPU runner can take longer
      // than the default 3 s to draw a 1280x720 frame (see the locomotion check).
      await captureXrScreenshot(page, path.join(frameDir, `${String(nextShot).padStart(2, '0')}.png`), { timeout: 10_000 })
        .catch((error: Error) => console.warn(`[pointing] ${label} frame ${nextShot} not captured: ${error.message.split('\n')[0]}`));
      await page.evaluate(() => {
        window.__setHandOverlay(false);
        window.__setSpectatorView(false);
        window.__setFrameStepping(true, false);
      });
      nextShot += 1;
    }
    const timeMs = await page.evaluate(() => window.__replayPlayer!.currentTime);
    // Once playback ends IWER returns the hands to their default pose.
    if (timeMs >= durationMs - 1) break;
  }

  const downloaded = page.waitForEvent('download', { timeout: 120_000 });
  let settled = false;
  downloaded.then(() => { settled = true; }, () => { settled = true; });
  await clickByText(CONTROL_NAMES.stopRecording);
  // Export runs on animation frames; release them until the file lands.
  for (let attempt = 0; attempt < 1200 && !settled; attempt += 1) {
    await page.clock.runFor(100);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const download = await downloaded;
  const glbPath = path.join(artifactDir, `${label}.glb`);
  await copyFile(await download.path(), glbPath);

  const gltf = readGlbJson(await readFile(glbPath));
  const score = scorePointing({ labels, gltf });
  for (const entry of aim) {
    if (entry.errorDeg > AIM_TOLERANCE_DEG) score.failures.push(`${entry.point}: fixture aims ${entry.errorDeg}° off its referent (limit ${AIM_TOLERANCE_DEG}°); regenerate with pointing-fixture`);
  }
  const sheet = writeContactSheet(frameDir, path.join(artifactDir, `${label}-sheet.jpg`));
  const report: PointingReplayReport = {
    label,
    labelsFile: path.join(labelsDir, labelFile),
    fixture: labels.fixture,
    useFor: labels.useFor,
    glb: glbPath,
    sheet,
    sheetTimesSec: shots.map((shot) => shot.timeSec),
    aim,
    toleranceSec: TOLERANCE_SEC,
    // Recording starts one 30 Hz step before playback; spans count from the
    // first recorded frame, so labels line up to within about two steps.
    alignment: 'capture t0 within two steps of replay t0',
    durationMs,
    status: score.status,
    failures: score.failures,
    matches: score.matches,
    silence: score.silence,
    links: score.links
  };
  await writeFile(path.join(artifactDir, `${label}-report.json`), JSON.stringify(report, null, 2));
  return report;
}
