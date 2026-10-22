import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import {
  attachXrEnvironment,
  captureXrScreenshot,
  createXrContext,
  enterIwerSessionFromButton,
  filterReplayFixtures,
  freezePageClock,
  launchXrBrowser,
  mapWithConcurrency,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';
import { writeContactSheet } from '@holoim/tooling-testing/preview';

import { TARGETS } from './lib/pointing-scene.mjs';
import { expectations, readGlbJson, scorePointing, TOLERANCE_SEC } from './lib/pointing-score.mjs';

// Self-resolving pointing, headset side. Replays labelled input takes through
// the real WebXR path (IWER ActionPlayer → XRHand joints → retargeter →
// avatar), records and exports with capture's own recorder, reads
// HOLOIM_meaning from the exported GLB, and scores its links against the
// labels in fixtures/pointing-labels/:
//   - headset-open-fist-pinch-point-wave-reach: a real headset take; one link
//     per labelled point, timed within 0.5 s, and silence elsewhere. Its ray
//     hits arbitrary things in the replay scene, so referents are not scored.
//   - iwer-pointing-targets: a synthetic take in a generated scene; links on
//     the named targets and the avatar's own hand, none for sky or a brief
//     point.
// Until capture writes the extension the check fails with "no HOLOIM_meaning".
//
// XR_REPLAY_ONLY=<substring> keeps only matching labels files;
// POINTING_CONCURRENCY sets how many takes replay at once (default 2).
// Writes output/ci-pointing/<label>-{report.json,sheet.jpg,.glb}.

const STEP_MS = 1000 / 30;
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const labelsDir = process.env.POINTING_LABELS ?? 'fixtures/pointing-labels';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-pointing';
const concurrency = Math.max(1, Number(process.env.POINTING_CONCURRENCY ?? 2));
const SHEET_VIEWPORT = { width: 960, height: 540 };

const labelFiles = filterReplayFixtures((await readdir(labelsDir).catch(() => []))
  .filter((name) => name.endsWith('.json'))
  .sort());
if (labelFiles.length === 0) throw new Error(`No pointing labels in ${labelsDir}.`);
await mkdir(artifactDir, { recursive: true });

const browser = await launchXrBrowser(chromium);
const consoleErrors = [];

// Frames the contact sheet shows: the middle of every labelled window.
function sheetShots(labels) {
  const { points, silent } = expectations(labels);
  return [...points, ...silent]
    .map((window) => ({ name: window.name, referent: window.referent, timeSec: (window.start + window.end) / 2 }))
    .sort((a, b) => a.timeSec - b.timeSec)
    .slice(0, 12);
}

const angleDeg = (a, b) => {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
};
const sub = (a, b) => a.map((v, i) => v - b[i]);
// Sanity check on the synthetic take, independent of capture's detector: at a
// point's midpoint, the tracked index finger really aims at the intended referent.
const AIM_TOLERANCE_DEG = 6;

async function replay(labelFile) {
  const label = path.basename(labelFile, '.json');
  const labels = JSON.parse(await readFile(path.join(labelsDir, labelFile), 'utf8'));
  const recording = JSON.parse(await readFile(path.join('fixtures', labels.fixture), 'utf8'));
  const context = await createXrContext(browser, { viewport: SHEET_VIEWPORT, acceptDownloads: true });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  // Capture's dev build saves the input behind every recording as a new
  // fixture; a replay must not write its own input back.
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"(discarded by the pointing check)"}' }));
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  const pageUrl = new URL(recording.meta?.query ?? '', baseUrl);
  pageUrl.searchParams.set('manualClock', '1');
  await page.goto(pageUrl.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', '__setFrameStepping', '__setSpectatorView', '__setHandOverlay']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => {
    window.__setManualClock(true, false);
    window.IWER_DEVICE.primaryInputMode = 'hand';
  });
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', {
    readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
  });
  // Screenshots show the scene, not the emulator's panels or the app's chrome.
  await page.evaluate(() => {
    const devui = window.IWER_DEVICE.devui;
    for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
      if (element instanceof HTMLElement) element.style.display = 'none';
    }
  });
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  const durationMs = await page.evaluate(async (data) => {
    const session = window.IWER_DEVICE.activeSession;
    const refSpace = await session.requestReferenceSpace('local-floor');
    // Created but not playing: recording starts first, then playback.
    window.__replayPlayer = window.IWER_DEVICE.createActionPlayer(refSpace, data);
    window.__setFrameStepping(true, false);
    return window.__replayPlayer.duration;
  }, recording);

  const clickByText = (text) => page.evaluate((name) => {
    [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === name)?.click();
  }, text);
  await clickByText('Start Recording');
  await page.clock.runFor(STEP_MS);
  await page.evaluate(() => window.__replayPlayer.play());

  const frameDir = path.join(artifactDir, `${label}-frames`);
  await mkdir(frameDir, { recursive: true });
  const shots = sheetShots(labels);
  // Hand close-ups show finger shape in the real take; the body view shows the arm aiming in the synthetic scene.
  const spectatorMode = labels.scene ? 'body' : 'hands';
  const aim = [];
  let nextShot = 0;
  const totalSteps = Math.floor(durationMs / STEP_MS);
  for (let index = 0; index < totalSteps; index += 1) {
    const due = nextShot < shots.length && index * STEP_MS / 1000 >= shots[nextShot].timeSec;
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
      const shot = shots[nextShot];
      const target = shot.referent && TARGETS[shot.referent]?.center;
      if (target || shot.referent === 'leftHand') {
        const hands = await page.evaluate(() => {
          const sample = window.__sampleHands();
          return { tip: sample.right.tracked['index-finger-tip'], proximal: sample.right.tracked['index-finger-phalanx-proximal'], leftWrist: sample.left.tracked.wrist };
        });
        aim.push({
          point: shot.name,
          errorDeg: Number(angleDeg(sub(hands.tip, hands.proximal), sub(target ?? hands.leftWrist, hands.tip)).toFixed(2))
        });
      }
      await captureXrScreenshot(page, path.join(frameDir, `${String(nextShot).padStart(2, '0')}.png`));
      await page.evaluate(() => {
        window.__setHandOverlay(false);
        window.__setSpectatorView(false);
        window.__setFrameStepping(true, false);
      });
      nextShot += 1;
    }
    const timeMs = await page.evaluate(() => window.__replayPlayer.currentTime);
    // Once playback ends IWER returns the hands to their default pose.
    if (timeMs >= durationMs - 1) break;
  }

  const downloaded = page.waitForEvent('download', { timeout: 120_000 });
  let settled = false;
  downloaded.then(() => { settled = true; }, () => { settled = true; });
  await clickByText('Stop Recording');
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
  const report = {
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

function format(report) {
  const lines = [`[pointing] ${report.label}: ${report.status}, ${report.links.length} link(s)`];
  for (const match of report.matches) {
    lines.push(match.link
      ? `  ${match.ok ? 'ok  ' : 'FAIL'} ${match.point}: ${match.link.start}–${match.link.end} s (label ${match.label.start}–${match.label.end}) ${match.link.from} → ${match.link.to}`
      : `  MISS ${match.point}`);
  }
  for (const window of report.silence) lines.push(`  ${window.links ? 'FAIL' : 'ok  '} silent ${window.window} ${window.start}–${window.end} s: ${window.links} intruding link(s)`);
  if (report.sheet) lines.push(`  sheet: ${report.sheet}`);
  return lines.join('\n');
}

try {
  const reports = await mapWithConcurrency(labelFiles, concurrency, replay);
  for (const report of reports) console.log(format(report));
  const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.label}: ${failure}`));
  if (consoleErrors.length > 0) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
  if (failures.length > 0) throw new Error(`Pointing check failed:\n- ${failures.join('\n- ')}`);
  console.log('Pointing check passed.');
} finally {
  await browser.close();
}
