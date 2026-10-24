import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
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
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';
import { writeContactSheet } from '@holoim/tooling-testing/preview';

// Drives the avatar's face through the real VR path on an emulated Quest Pro
// (the one IWER device with eye gaze): a scripted ARKit performance through
// the automation input, then the release to WebXR eye gaze (swept through
// IWER), then the release to liveness (blinks, saccades). The face is
// recorded and exported, and the GLB's morph animation must carry the same
// weights the avatar showed. FACE_VIDEO=1 writes the proof video and contact
// sheet from the face spectator camera.

const STEP_MS = 1000 / 30;
const DEG = Math.PI / 180;
const MAX_YAW = 30 * DEG;
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-face';
const video = process.env.FACE_VIDEO === '1';
const frameDir = path.join(artifactDir, 'video-frames');

const smile = { mouthSmileLeft: 1, mouthSmileRight: 1, cheekSquintLeft: 0.4, cheekSquintRight: 0.4, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 };
// Each segment holds its face; `expect` names the head targets that must
// read high (1 − tolerance) and low (≤ tolerance) at its end.
const SEGMENTS = [
  { name: 'neutral', sec: 0.8, face: { weights: {} }, low: ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthSmileLeft'] },
  { name: 'wink-left', sec: 0.8, face: { weights: { eyeBlinkLeft: 1 } }, high: ['eyeBlinkLeft'], low: ['eyeBlinkRight'] },
  { name: 'wink-right', sec: 0.8, face: { weights: { eyeBlinkRight: 1 } }, high: ['eyeBlinkRight'], low: ['eyeBlinkLeft'] },
  { name: 'smile', sec: 1, face: { weights: smile }, high: ['mouthSmileLeft', 'mouthSmileRight'], low: ['mouthFrownLeft', 'jawOpen'] },
  { name: 'jaw-open', sec: 1, face: { weights: { jawOpen: 1 } }, high: ['jawOpen'], low: ['mouthSmileLeft'] },
  { name: 'brows-up', sec: 1, face: { weights: { browInnerUp: 1, browOuterUpLeft: 1, browOuterUpRight: 1, eyeWideLeft: 1, eyeWideRight: 1 } }, high: ['browInnerUp', 'browOuterUpLeft', 'eyeWideLeft'], low: ['browDownLeft'] },
  { name: 'frown', sec: 1, face: { weights: { mouthFrownLeft: 1, mouthFrownRight: 1, browDownLeft: 1, browDownRight: 1 } }, high: ['mouthFrownLeft', 'mouthFrownRight', 'browDownLeft'], low: ['mouthSmileLeft'] },
  { name: 'pucker', sec: 0.8, face: { weights: { mouthPucker: 1 } }, high: ['mouthPucker'] },
  { name: 'cheek-puff', sec: 0.8, face: { weights: { cheekPuff: 1 } }, high: ['cheekPuff'] },
  // Visemes have no targets on this avatar; they route to jaw and lips.
  { name: 'viseme-aa', sec: 0.6, face: { weights: { viseme_aa: 1 } }, routed: ['jawOpen'] },
  { name: 'viseme-U', sec: 0.6, face: { weights: { viseme_U: 1 } }, routed: ['mouthPucker'] },
  { name: 'look-left', sec: 0.8, face: { weights: {}, gaze: gazeBoth(20 * DEG, 0) }, gaze: { yaw: 20 * DEG, pitch: 0 } },
  { name: 'look-right', sec: 0.8, face: { weights: {}, gaze: gazeBoth(-20 * DEG, 0) }, gaze: { yaw: -20 * DEG, pitch: 0 } },
  { name: 'look-up', sec: 0.8, face: { weights: {}, gaze: gazeBoth(0, 15 * DEG) }, gaze: { yaw: 0, pitch: 15 * DEG } },
  { name: 'look-down', sec: 0.8, face: { weights: {}, gaze: gazeBoth(0, -15 * DEG) }, gaze: { yaw: 0, pitch: -15 * DEG }, lidFollow: true }
];
// IWER eye-gaze sweep after release, viewer-relative: yaw + turns the ray
// toward the author's left, which is the avatar's own left.
const XR_GAZE = [
  { name: 'xr-left', sec: 1, yaw: 15 * DEG, pitch: 0 },
  { name: 'xr-right', sec: 1, yaw: -15 * DEG, pitch: 0 },
  { name: 'xr-far-left', sec: 1, yaw: 60 * DEG, pitch: 0, clamped: true },
  { name: 'xr-up', sec: 1, yaw: 0, pitch: 12 * DEG }
];
const LIVENESS_SEC = 7;
const TOLERANCE = 0.05;

function gazeBoth(yaw, pitch) {
  return { left: { yaw, pitch }, right: { yaw, pitch } };
}

await rm(artifactDir, { recursive: true, force: true });
await mkdir(video ? frameDir : artifactDir, { recursive: true });

// Chromium's fake camera (a test pattern, never a face) for the webcam phase.
const browser = await launchXrBrowser(chromium, { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const consoleErrors = [];
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

try {
  const context = await createXrContext(browser, { viewport: video ? { width: 1280, height: 720 } : { width: 960, height: 540 }, acceptDownloads: true });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label: 'face' });
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  // Stopping an IWER recording uploads its input to the dev server's fixture
  // sink; this check's take is not a fixture.
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"(discarded by the face check)"}' }));
  const pageUrl = new URL(baseUrl);
  pageUrl.searchParams.set('manualClock', '1');
  await page.goto(pageUrl.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', '__setFrameStepping', '__setFaceInput', '__sampleFace', '__setSpectatorView']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => window.__setManualClock(true, false));
  await waitForIwerRuntime(page);
  const device = await page.evaluate(() => ({ name: window.IWER_DEVICE.name, gaze: Boolean(window.IWER_DEVICE.gaze) }));
  check(device.gaze, `IWER device ${device.name} has no eye gaze; the face check needs CAPTURE_IWER_DEVICE=metaQuestPro`);
  await enterIwerSessionFromButton(page, '#VRButton', {
    readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
  });
  await page.evaluate((hide) => {
    window.__setSpectatorView('face');
    if (!hide) return;
    const devui = window.IWER_DEVICE.devui;
    for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
      if (element instanceof HTMLElement) element.style.display = 'none';
    }
  }, video);
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  await page.evaluate((draw) => window.__setFrameStepping(true, draw), video);

  const binding = (await page.evaluate(() => window.__sampleFace())).binding;
  const headMesh = binding.morphTargets.find((target) => target.name === 'eyeBlinkLeft')?.mesh;
  check(Boolean(headMesh), 'no head mesh binds eyeBlinkLeft');
  check(binding.eyes.left && binding.eyes.right, 'eye bones not bound');
  for (const side of ['left', 'right']) {
    // The fit leans back a few millimetres on the cornea bulge.
    const offset = binding.eyes.pivotOffsetMm[side];
    check(offset !== null && offset < 5, `${side} eye bone is ${offset} mm off the eyeball centre`);
  }

  // Recording starts with the performance and stops after liveness.
  const clickButton = (name) => page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no button "${label}"`);
    button.click();
  }, name);
  await clickButton('Start Recording');

  const samples = [];
  let frameIndex = 0;
  const step = async (label) => {
    await page.clock.runFor(STEP_MS);
    const snapshot = await page.evaluate(() => window.__sampleFace());
    const head = {};
    for (const [key, value] of Object.entries(snapshot.influences)) {
      const [mesh, name] = key.split(':');
      if (mesh === headMesh) head[name] = value;
    }
    const sample = { label, frame: frameIndex, expressionSource: snapshot.expressionSource, gazeSource: snapshot.gazeSource, head, gaze: snapshot.gaze, weights: snapshot.weights };
    samples.push(sample);
    if (video) await page.screenshot({ path: path.join(frameDir, `${String(frameIndex).padStart(5, '0')}.png`) });
    frameIndex += 1;
    return sample;
  };
  // The video carries each segment's name and the face's sources.
  const caption = (label) => video && page.evaluate((text) => {
    let element = document.getElementById('face-caption');
    if (!element) {
      element = document.createElement('div');
      element.id = 'face-caption';
      element.style.cssText = 'position:fixed;left:24px;bottom:20px;z-index:99999;font:600 22px system-ui;color:#fff;background:rgba(0,0,0,.55);padding:6px 12px;border-radius:6px';
      document.body.append(element);
    }
    element.textContent = text;
  }, label);
  const hold = async (label, sec) => {
    await caption(`${label} · expression: ${label === 'liveness' || label.startsWith('xr-') ? 'liveness' : 'scripted'} · gaze: ${label.startsWith('xr-') ? 'WebXR eye gaze' : label === 'liveness' ? 'liveness' : 'scripted'}`);
    let last = null;
    for (let i = 0; i < Math.round(sec * 1000 / STEP_MS); i += 1) last = await step(label);
    return last;
  };

  const segmentResults = [];
  for (const segment of SEGMENTS) {
    await page.evaluate((face) => window.__setFaceInput(face), segment.face);
    const end = await hold(segment.name, segment.sec);
    const result = { name: segment.name, expressionSource: end.expressionSource, head: end.head, gaze: end.gaze };
    segmentResults.push(result);
    check(end.expressionSource === 'automation', `${segment.name}: expression source ${end.expressionSource}`);
    for (const name of segment.high ?? []) check((end.head[name] ?? 0) >= 1 - TOLERANCE, `${segment.name}: ${name} ${(end.head[name] ?? 0).toFixed(3)} < ${1 - TOLERANCE}`);
    for (const name of segment.low ?? []) check((end.head[name] ?? 0) <= TOLERANCE, `${segment.name}: ${name} ${(end.head[name] ?? 0).toFixed(3)} > ${TOLERANCE}`);
    for (const name of segment.routed ?? []) check((end.head[name] ?? 0) >= 0.3, `${segment.name}: routed ${name} ${(end.head[name] ?? 0).toFixed(3)} < 0.3`);
    if (segment.gaze) {
      for (const side of ['left', 'right']) {
        const eye = end.gaze[side];
        check(Math.abs(eye.yaw - segment.gaze.yaw) < 1 * DEG && Math.abs(eye.pitch - segment.gaze.pitch) < 1 * DEG,
          `${segment.name}: ${side} eye yaw ${(eye.yaw / DEG).toFixed(1)}° pitch ${(eye.pitch / DEG).toFixed(1)}°, wanted ${(segment.gaze.yaw / DEG).toFixed(1)}° / ${(segment.gaze.pitch / DEG).toFixed(1)}°`);
      }
    }
    if (segment.lidFollow) check((end.head.eyeBlinkLeft ?? 0) > 0.1 && (end.head.eyeBlinkLeft ?? 0) < 0.5, `${segment.name}: lids do not follow the eyes down (blink ${(end.head.eyeBlinkLeft ?? 0).toFixed(3)})`);
  }

  // Release: WebXR eye gaze takes the eyes, liveness the expression.
  await page.evaluate(() => {
    window.__setFaceInput(null);
    window.IWER_DEVICE.gaze.connected = true;
  });
  const releaseStart = samples.length;
  const xrResults = [];
  for (const target of XR_GAZE) {
    await page.evaluate(({ yaw, pitch }) => {
      // Viewer-local ray: rotate -Z by yaw about +Y, then pitch about +X.
      const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2);
      window.IWER_DEVICE.gaze.quaternion.set(sx * cy, sy * cx, -sx * sy, cx * cy);
    }, target);
    const end = await hold(target.name, target.sec);
    xrResults.push({ name: target.name, gazeSource: end.gazeSource, gaze: end.gaze });
    check(end.gazeSource === 'xr-gaze', `${target.name}: gaze source ${end.gazeSource}`);
    const mean = (end.gaze.left.yaw + end.gaze.right.yaw) / 2;
    if (target.clamped) check(Math.abs(mean - MAX_YAW) < 0.5 * DEG, `${target.name}: yaw ${(mean / DEG).toFixed(1)}° not clamped at 30°`);
    else check(Math.sign(mean) === Math.sign(target.yaw) || target.yaw === 0, `${target.name}: eyes turned the wrong way (yaw ${(mean / DEG).toFixed(1)}°)`);
    if (target.yaw === 0) check(end.gaze.left.pitch > 5 * DEG, `${target.name}: eyes did not look up (pitch ${(end.gaze.left.pitch / DEG).toFixed(1)}°)`);
  }
  // A source change crossfades instead of popping.
  let maxJump = 0;
  for (let i = releaseStart; i < releaseStart + 12 && i < samples.length; i += 1) {
    for (const name of Object.keys(samples[i].head)) maxJump = Math.max(maxJump, Math.abs((samples[i].head[name] ?? 0) - (samples[i - 1].head[name] ?? 0)));
  }
  check(maxJump <= 0.3, `release popped: a head target moved ${maxJump.toFixed(3)} in one step`);

  await page.evaluate(() => {
    window.IWER_DEVICE.gaze.connected = false;
  });
  const livenessStart = samples.length;
  await hold('liveness', LIVENESS_SEC);
  const live = samples.slice(livenessStart + 10);
  let blinks = 0;
  for (let i = 1; i < live.length; i += 1) if ((live[i].head.eyeBlinkLeft ?? 0) > 0.8 && (live[i - 1].head.eyeBlinkLeft ?? 0) <= 0.8) blinks += 1;
  const yaws = live.map((s) => s.gaze.left.yaw);
  const saccadeRangeDeg = (Math.max(...yaws) - Math.min(...yaws)) / DEG;
  check(live.every((s) => s.expressionSource === 'liveness' && s.gazeSource === 'liveness'), 'liveness did not take the face after gaze dropped');
  check(blinks >= 1 && blinks <= 4, `liveness blinked ${blinks} times in ${LIVENESS_SEC} s`);
  check(saccadeRangeDeg > 2 && saccadeRangeDeg < 13, `liveness saccade range ${saccadeRangeDeg.toFixed(1)}°`);

  // Stop and export; the clock has to run for the export to finish.
  const download = page.waitForEvent('download', { timeout: 60_000 });
  const exportStarted = performance.now();
  await clickButton('Stop Recording');
  let file = null;
  void download.then((d) => { file = d; });
  for (let waited = 0; !file && waited < 60_000; waited += STEP_MS) await page.clock.runFor(STEP_MS);
  const glbPath = path.join(artifactDir, 'face-recording.glb');
  await (await download).saveAs(glbPath);
  const exportMs = Math.round(performance.now() - exportStarted);
  const exportResult = await verifyExport(glbPath, headMesh, samples);
  for (const message of exportResult.failures) failures.push(`export: ${message}`);

  const report = {
    device: device.name,
    frames: samples.length,
    binding: { headMesh, boundChannels: binding.boundChannels.length, eyes: binding.eyes, unresolvedTargets: binding.unresolvedTargets },
    segments: segmentResults.map(({ name, expressionSource, gaze }) => ({ name, expressionSource, gazeDeg: { left: toDeg(gaze.left), right: toDeg(gaze.right) } })),
    xrGaze: xrResults.map(({ name, gazeSource, gaze }) => ({ name, gazeSource, gazeDeg: { left: toDeg(gaze.left), right: toDeg(gaze.right) } })),
    release: { maxStepJump: round(maxJump) },
    liveness: { blinks, saccadeRangeDeg: round(saccadeRangeDeg) },
    export: { ...exportResult.summary, exportMs },
    failures
  };
  await writeFile(path.join(artifactDir, 'face-report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(artifactDir, 'face-samples.json'), JSON.stringify(samples));

  if (video) {
    const videoPath = path.join(artifactDir, 'face.mp4');
    const encoded = spawnSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-framerate', String(Math.round(1000 / STEP_MS)),
      '-i', path.join(frameDir, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', videoPath
    ], { stdio: 'inherit' });
    console.log(encoded.status === 0 ? `[face] video: ${videoPath}` : '[face] ffmpeg unavailable; frames kept as PNGs');
    const sheet = writeContactSheet(frameDir, path.join(artifactDir, 'face-sheet.jpg'));
    if (sheet) console.log(`[face] contact sheet: ${sheet}`);
  }

  report.webcam = await webcamFallbacks();
  await writeFile(path.join(artifactDir, 'face-report.json'), JSON.stringify(report, null, 2));

  console.log(`[face] ${samples.length} frames; liveness ${blinks} blinks, saccades ${saccadeRangeDeg.toFixed(1)}°; export ${exportResult.summary.bytes} bytes in ${exportMs} ms, ${exportResult.summary.faceBytesPerMinute} face bytes/min`);
  // MediaPipe logs its TFLite delegate choice through console.error.
  const errors = consoleErrors.filter((line) => !/INFO: Created TensorFlow Lite/.test(line));
  if (errors.length > 0) failures.push(`console errors:\n${errors.join('\n')}`);
  if (failures.length > 0) throw new Error(`Face check failed:\n- ${failures.join('\n- ')}`);
  console.log('Face check passed.');
} finally {
  await browser.close();
}

/**
 * On desktop the webcam drives the face only while it sees one: a camera
 * with no face in view, or a denied one, leaves liveness in charge.
 */
async function webcamFallbacks() {
  const outcomes = {};
  for (const mode of ['no-face', 'denied']) {
    const context = await createXrContext(browser, { viewport: { width: 960, height: 540 }, permissions: ['camera'] });
    const page = await context.newPage();
    wireXrConsoleErrors(page, consoleErrors, { label: `webcam-${mode}` });
    if (mode === 'denied') {
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      });
    }
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await waitForPageFunctions(page, ['__toggleFaceCamera', '__sampleFace']);
    await waitForTextContentPrefix(page, '#status', 'loaded');
    await page.evaluate(() => window.__toggleFaceCamera());
    const settled = await page.waitForFunction((want) => {
      const face = window.__sampleFace();
      return face.camera === want ? { camera: face.camera, delegate: face.cameraDelegate, expressionSource: face.expressionSource, gazeSource: face.gazeSource } : null;
    }, mode, { timeout: 45_000, polling: 250 }).then((handle) => handle.jsonValue()).catch(async () => page.evaluate(() => {
      const face = window.__sampleFace();
      return { camera: face.camera, delegate: face.cameraDelegate, expressionSource: face.expressionSource, gazeSource: face.gazeSource };
    }));
    // A second after settling, liveness still drives the face.
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => {
      const face = window.__sampleFace();
      return { expressionSource: face.expressionSource, gazeSource: face.gazeSource };
    });
    const label = await page.getByRole('button', { name: /^Face camera/ }).textContent().catch(() => null);
    check(settled.camera === mode, `webcam ${mode}: camera state ${settled.camera}`);
    check(after.expressionSource === 'liveness' && after.gazeSource === 'liveness', `webcam ${mode}: face driven by ${after.expressionSource}/${after.gazeSource}, want liveness`);
    outcomes[mode] = { ...settled, after, buttonLabel: label?.trim() ?? null };
    await context.close();
  }
  return outcomes;
}

/**
 * The GLB's head morph animation must reproduce the weights the avatar showed
 * at each segment's end, and its eye bones must carry the gaze.
 */
async function verifyExport(glbPath, headMesh, recorded) {
  const out = [];
  const document = await new NodeIO().read(glbPath);
  const root = document.getRoot();
  const mesh = root.listMeshes().find((m) => m.getName() === headMesh) ?? root.listMeshes().find((m) => (m.getExtras().targetNames ?? []).includes('eyeBlinkLeft'));
  if (!mesh) return { failures: ['no head mesh with ARKit targets in the GLB'], summary: { bytes: (await readFile(glbPath)).length } };
  const names = mesh.getExtras().targetNames ?? [];
  const nodes = root.listNodes().filter((n) => n.getMesh() === mesh);
  let weightsChannel = null;
  let faceBytes = 0;
  let duration = 0;
  const eyeNames = new Set(['LeftEye', 'RightEye']);
  let eyeChannels = 0;
  for (const animation of root.listAnimations()) {
    for (const channel of animation.listChannels()) {
      const sampler = channel.getSampler();
      const input = sampler.getInput();
      duration = Math.max(duration, input.getMax([0])[0]);
      if (channel.getTargetPath() === 'weights') {
        faceBytes += sampler.getOutput().getByteLength();
        if (nodes.includes(channel.getTargetNode())) weightsChannel = sampler;
      }
      if (channel.getTargetPath() === 'rotation' && eyeNames.has(channel.getTargetNode()?.getName())) {
        eyeChannels += 1;
        faceBytes += sampler.getOutput().getByteLength();
      }
    }
  }
  if (!weightsChannel) out.push(`head mesh ${headMesh} has no weights animation`);
  if (eyeChannels < 2) out.push(`eye bones carry ${eyeChannels} rotation channels, want 2`);
  let maxError = 0;
  if (weightsChannel) {
    const times = weightsChannel.getInput().getArray();
    const values = weightsChannel.getOutput().getArray();
    const count = names.length;
    // Compare at each segment's last frame, by time: recording starts with
    // the first step and keys every XR frame, which can outpace the steps.
    const ends = new Map();
    // Scripted segments only: a liveness blink can fall between keys.
    for (const sample of recorded) if (sample.expressionSource === 'automation') ends.set(sample.label, sample);
    for (const sample of ends.values()) {
      const time = (sample.frame + 1) * STEP_MS / 1000;
      let key = 0;
      while (key + 1 < times.length && times[key + 1] <= time) key += 1;
      const next = Math.min(key + 1, times.length - 1);
      const t = next === key ? 0 : Math.min(1, Math.max(0, (time - times[key]) / (times[next] - times[key])));
      for (const [index, name] of names.entries()) {
        if (!(name in sample.head)) continue;
        const value = values[key * count + index] * (1 - t) + values[next * count + index] * t;
        maxError = Math.max(maxError, Math.abs(value - sample.head[name]));
      }
    }
    if (maxError > TOLERANCE) out.push(`exported weights differ from the avatar by ${maxError.toFixed(3)} (> ${TOLERANCE})`);
  }
  const bytes = (await readFile(glbPath)).length;
  return {
    failures: out,
    summary: { bytes, durationSec: round(duration), headTargets: names.length, maxWeightError: round(maxError), faceBytesPerMinute: duration > 0 ? Math.round(faceBytes / duration * 60) : null }
  };
}

function toDeg(eye) {
  return eye ? { yaw: round(eye.yaw / DEG), pitch: round(eye.pitch / DEG) } : null;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
