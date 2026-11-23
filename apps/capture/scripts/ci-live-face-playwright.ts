import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Route } from 'playwright';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  launchXrBrowser,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

import type {} from '../src/runtime/automationHooks';
import type { FaceSnapshot } from '../src/face/FaceDriver';
import { liveFaceTrack, type FaceTrack } from './fixtures/live-face-sets';

// The live face on the default avatar, with no person in the loop (B-092): hand-made scores of the camera face
// tracker (fixtures/live-face-sets.ts, which keeps the tracker's habits: weak and uneven scores) are replayed through
// the camera's own path to the face, one expression at a time, and the face the avatar shows must move as a whole:
// cheeks and eyes with a smile, brows and mouth corners with a sad face, lips that close and round in speech.
//
// LIVE_FACE_FRAMES=1 also writes a picture of every frame (for the before and after sheets and the proof video);
// LIVE_FACE_RAW=1 shows the tracker scores applied one to one, as before the fix, and asserts nothing.

type Row = { set: string; frame: number; head: Record<string, number> };

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-live-face';
const wantFrames = process.env.LIVE_FACE_FRAMES === '1';
const faceFrame = process.env.LIVE_FACE_VIEW === 'mouth' ? ('mouth' as const) : ('whole' as const);
const rawMode = process.env.LIVE_FACE_RAW === '1';
// LIVE_FACE_TRACK names a JSON file of the same form to replay in place of the hand-made sets.
const track: FaceTrack = process.env.LIVE_FACE_TRACK ? JSON.parse(await readFile(process.env.LIVE_FACE_TRACK, 'utf8')) : liveFaceTrack();
const only = process.env.LIVE_FACE_ONLY?.split(',');
if (only) track.sets = track.sets.filter((set) => only.includes(set.name));
const stepMs = 1000 / track.fps;
const t0 = Date.now();
const stage = (name: string) => { if (process.env.LIVE_FACE_TRACE) console.error(`[trace] ${((Date.now() - t0) / 1000).toFixed(1)}s ${name}`); };
// [set, measure, bound]: what each expression must (EXPECT_MIN) and must not (EXPECT_MAX) move on the avatar.
// The scores applied one to one fail most of these: a smile's cheeks reach 0.05 and a sad face's frown 0.03.
const EXPECT_MIN: Array<[string, string, number]> = [
  ['smile', 'smile', 0.6], ['smile', 'cheekSquint', 0.4], ['smile', 'eyeSquint', 0.3],
  ['laugh', 'smile', 0.6], ['laugh', 'cheekSquint', 0.4], ['laugh', 'upperUp', 0.5], ['laugh', 'jawOpen', 0.4],
  ['sad', 'frown', 0.6], ['sad', 'browInnerUp', 0.5],
  ['surprise', 'browInnerUp', 0.5], ['surprise', 'browOuterUp', 0.4], ['surprise', 'eyeWide', 0.35], ['surprise', 'jawOpen', 0.3],
  ['anger', 'browDown', 0.7], ['anger', 'noseSneer', 0.3], ['anger', 'eyeSquint', 0.3],
  ['speech', 'jawOpen', 0.3], ['speech', 'round', 0.6], ['speech', 'wide', 0.3]
];
const EXPECT_MAX: Array<[string, string, number]> = [
  ['neutral', 'smile', 0.1], ['neutral', 'frown', 0.1], ['neutral', 'eyeSquint', 0.15], ['neutral', 'jawOpen', 0.05],
  ['smile', 'frown', 0.1], ['laugh', 'frown', 0.1],
  ['sad', 'smile', 0.1], ['sad', 'jawOpen', 0.05],
  ['surprise', 'frown', 0.1], ['surprise', 'smile', 0.1],
  ['anger', 'frown', 0.15],
  // The lips close for m, b and p.
  ['speech', 'jawOpenLow', 0.02], ['speech', 'frown', 0.1]
];

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const browser = await launchXrBrowser(chromium, {});
const consoleErrors: string[] = [];
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

try {
  const context = await createXrContext(browser, { viewport: { width: 640, height: 640 } });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label: 'live-face' });
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  await page.route('**/__holoim/input-recordings*', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"(discarded by the live face check)"}' }));
  const pageUrl = new URL(baseUrl);
  pageUrl.searchParams.set('manualClock', '1');
  if (process.env.XR_AVATAR_URL) pageUrl.searchParams.set('avatar', process.env.XR_AVATAR_URL);
  stage('goto');
  await page.goto(pageUrl.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', '__setFrameStepping', '__setFaceInput', '__setFaceTrackerInput', '__sampleFace', '__setSpectatorView']);
  stage('functions ready');
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => window.__setManualClock(true, false));
  stage('loaded');
  await waitForIwerRuntime(page);
  stage('iwer');
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  await page.evaluate((faceFrame) => {
    window.__setSpectatorView('face', { faceFrame });
    const devui = window.IWER_DEVICE!.devui;
    for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
      if (element instanceof HTMLElement) element.style.display = 'none';
    }
  }, faceFrame);
  stage('in vr, view set');
  await freezePageClock(page);
  stage('clock frozen');
  await waitForXrRenderLoop(page);
  stage('render loop');
  await page.evaluate((draw: boolean) => window.__setFrameStepping(true, draw), wantFrames);

  const first: FaceSnapshot = await page.evaluate(() => window.__sampleFace());
  const headMesh = first.binding?.morphTargets.find((target) => target.name === 'mouthSmileLeft')?.mesh;
  check(Boolean(headMesh), 'no mesh binds mouthSmileLeft');

  const rows: Row[] = [];
  const setInput = (scores: Record<string, number> | null) =>
    page.evaluate(([raw, one]) => {
      if (one) window.__setFaceInput(raw ? { weights: raw as never } : null);
      else window.__setFaceTrackerInput(raw as Record<string, number> | null);
    }, [scores, rawMode] as const);
  // The picture of a frame can stall on a busy host; the page stands still between steps, so it is taken again.
  const framePicture = async (file: string) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await page.screenshot({ path: file, timeout: 5000 });
        return;
      } catch (error) {
        if (attempt === 8) throw error;
      }
    }
  };
  for (const set of track.sets) {
    if (wantFrames) await mkdir(path.join(artifactDir, 'frames', set.name), { recursive: true });
    // The face settles on the set's first frame before the set plays: a source change crossfades, and the sad
    // face of the set before fades out over the tracker samples that follow it.
    for (let settle = 0; settle < 15; settle += 1) {
      await setInput(set.frames[0]!);
      await page.clock.runFor(100);
    }
    for (const [index, scores] of set.frames.entries()) {
      stage(`frame ${index}`);
      await setInput(scores);
      await page.clock.runFor(stepMs);
      stage('ran');
      const snapshot: FaceSnapshot = await page.evaluate(() => window.__sampleFace());
      const head: Record<string, number> = {};
      for (const [key, value] of Object.entries(snapshot.influences)) {
        const [mesh, name] = key.split(':');
        if (mesh === headMesh) head[name!] = Math.round(value * 1000) / 1000;
      }
      rows.push({ set: set.name, frame: index, head });
      if (wantFrames) await framePicture(path.join(artifactDir, 'frames', set.name, `${String(index).padStart(5, '0')}.png`));
    }
  }
  await setInput(null);

  // What each expression must move. `peak` is the highest value a shape reaches in the set (mean of both sides).
  const peak = (set: string, ...names: string[]): number =>
    Math.max(0, ...rows.filter((row) => row.set === set).map((row) => names.reduce((sum, name) => sum + (row.head[name] ?? 0), 0) / names.length));
  const low = (set: string, ...names: string[]): number =>
    Math.min(...rows.filter((row) => row.set === set).map((row) => names.reduce((sum, name) => sum + (row.head[name] ?? 0), 0) / names.length));
  const summary: Record<string, Record<string, number>> = {};
  for (const set of track.sets) {
    summary[set.name] = {
      smile: peak(set.name, 'mouthSmileLeft', 'mouthSmileRight'),
      cheekSquint: peak(set.name, 'cheekSquintLeft', 'cheekSquintRight'),
      eyeSquint: peak(set.name, 'eyeSquintLeft', 'eyeSquintRight'),
      upperUp: peak(set.name, 'mouthUpperUpLeft', 'mouthUpperUpRight'),
      frown: peak(set.name, 'mouthFrownLeft', 'mouthFrownRight'),
      browInnerUp: peak(set.name, 'browInnerUp'),
      browDown: peak(set.name, 'browDownLeft', 'browDownRight'),
      browOuterUp: peak(set.name, 'browOuterUpLeft', 'browOuterUpRight'),
      eyeWide: peak(set.name, 'eyeWideLeft', 'eyeWideRight'),
      noseSneer: peak(set.name, 'noseSneerLeft', 'noseSneerRight'),
      jawOpen: peak(set.name, 'jawOpen'),
      jawOpenLow: low(set.name, 'jawOpen'),
      lipsClosed: peak(set.name, 'mouthClose'),
      round: Math.max(peak(set.name, 'mouthPucker'), peak(set.name, 'mouthFunnel')),
      wide: peak(set.name, 'mouthStretchLeft', 'mouthStretchRight')
    };
  }
  if (!rawMode) {
    const need = (set: string, key: string, min: number) => {
      const value = summary[set]?.[key];
      check(value !== undefined && value >= min, `${set}: ${key} peaks at ${value?.toFixed(3)}, below ${min}`);
    };
    const atMost = (set: string, key: string, max: number) => {
      const value = summary[set]?.[key];
      check(value !== undefined && value <= max, `${set}: ${key} peaks at ${value?.toFixed(3)}, above ${max}`);
    };
    for (const [set, key, min] of EXPECT_MIN) need(set, key, min);
    for (const [set, key, max] of EXPECT_MAX) atMost(set, key, max);
  }

  await writeFile(path.join(artifactDir, 'live-face-report.json'), JSON.stringify({ credit: track.credit, mode: rawMode ? 'raw' : 'shaped', summary, failures, consoleErrors }, null, 2));
  await writeFile(path.join(artifactDir, 'live-face-rows.json'), JSON.stringify(rows));
  if (wantFrames) {
    for (const set of track.sets) {
      const dir = path.join(artifactDir, 'frames', set.name);
      spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(track.fps), '-i', path.join(dir, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', path.join(artifactDir, `${set.name}.mp4`)], { stdio: 'inherit' });
    }
  }
  for (const [name, values] of Object.entries(summary)) console.log(`[live-face] ${name}: ${Object.entries(values).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
} finally {
  await browser.close();
}

if (consoleErrors.length) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
if (failures.length) {
  console.error(`[live-face] FAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('[live-face] passed');
