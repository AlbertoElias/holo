import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Download, type Page } from 'playwright';
import * as THREE from 'three';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  launchXrBrowser,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

import type {} from '../src/runtime/automationHooks';
import {
  assertCameraTake,
  compareNodePositions,
  comparePaths,
  inspectCameraTake,
  type CameraPath,
  type CameraTakeReport,
  type NodeComparison,
  type PathComparison
} from './lib/camera-take-glb.ts';
import { emulatePhone, setHeadPose, type Quat, type Vec3 } from './lib/iwer-phone.ts';

// Camera author mode (docs/features/ar-recording.md, slice 2a): phone AR in
// IWER with the phone helper records a scripted camera walk and exports a
// camera take. Phases (each a fresh page):
//   phone-a          flag on, pointing-targets set and a bracket object: Record, walk, Stop;
//                    the GLB's camera path must match the script within 1 cm and 1 degree.
//   phone-b          the same walk under a second placement (another head start): the world
//                    frame must differ, the take must not (camera path, set nodes, objects).
//   mic-denied       getUserMedia rejects: a silent take with a notice.
//   session-end      the XR session ends mid-take: the take is exported.
//   page-hidden      visibilitychange to hidden mid-take: the take is exported.
//   empty-set        the default (empty) scene: Record is refused, nothing downloads.
//   quest-passthrough flag on, Quest 3 (world-space) AR: spectator, no camera take.
//   phone-flag-off   phone AR without the flag: spectator, no camera take.
// How the path is compared: each walk step sets the head pose (in the set frame, converted to the
// room with the live world frame), waits for one real XR frame, then advances the simulation by
// STEP_MS. The recorder samples the camera each simulated frame, so one pose is held for several
// samples. The export's samples are compared with the script by time: the script is a staircase
// (pose i holds from START + i * STEP to START + (i + 1) * STEP), and START is the take time of the
// first step, found as the offset with the smallest error (reported as `alignmentSec`).
// AR_RECORD_ONLY=<substring> keeps matching phases; AR_RECORD_VIDEO_DIR=<dir> records phone-a on video
// at a watchable pace. Writes output/ci-ar-record/<phase>.glb and ar-record-report.json.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-ar-record';
const only = process.env.AR_RECORD_ONLY;
const videoDir = process.env.AR_RECORD_VIDEO_DIR;

const SCENE = '/fixtures/scenes/pointing-targets.gltf';
const OBJECT_URL = '/fixtures/objects/bracket.glb';
const VIEWPORT = { width: 640, height: 400 };
const STEP_MS = 100;
const WALK_STEPS = 30;
const PATH_TOLERANCE_CM = 1;
const PATH_TOLERANCE_DEG = 1;
const FAKE_MIC_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

const PHASES = ['phone-a', 'phone-b', 'mic-denied', 'session-end', 'page-hidden', 'hidden-at-start', 'empty-set', 'quest-passthrough', 'phone-flag-off'] as const;
type Phase = (typeof PHASES)[number];

type ArState = {
  sessionMode: string | null;
  worldPosition: { x: number; y: number; z: number };
  cameraAuthor: boolean;
  spectator: boolean;
  performerHidden: boolean;
  placementSettled: boolean;
  interactionMode: string | null;
  recordingState: 'idle' | 'recording' | 'exporting';
  recordingMessage: string | null;
  notice: string | null;
  takeKind: string;
  cameraSamples: number;
  micPermission: string;
  micHeld: boolean;
};

type PathAlignment = { alignmentSec: number; maxPositionCm: number; maxRotationDeg: number; samples: number };

type PhaseReport = {
  phase: Phase;
  failures: string[];
  notes: Record<string, unknown>;
  ar: Record<string, ArState>;
  takes: Array<{ filename: string; bytes: number; glb: string }>;
  take?: CameraTakeReport;
  scriptVsExport?: PathAlignment;
  worldFrame?: number[];
};

type Run = { browser: Browser; consoleErrors: string[] };
type Pose = { position: Vec3; quaternion: Quat };

const round = (value: number, places = 2) => Number(value.toFixed(places));

// --- The scripted walk, in the set frame ---

const quat = (yaw: number, pitch: number): Quat => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  return [q.x, q.y, q.z, q.w];
};

/** Translation along an arc with a slow bob, yaw and pitch sweeping; `i` in [0, WALK_STEPS). */
function walkPose(i: number): Pose {
  const a = (i / (WALK_STEPS - 1)) * Math.PI * 0.8;
  return {
    position: [round(0.7 * Math.sin(a), 4), round(1.5 + 0.08 * Math.sin(2 * a), 4), round(0.9 - 0.5 * (1 - Math.cos(a)), 4)],
    quaternion: quat(0.6 * Math.sin(a), -0.2 * Math.sin(a))
  };
}

const toMatrix = (frame: number[]) => new THREE.Matrix4().fromArray(frame);

/** A set-frame pose in the room (what the IWER device is set to). */
function setToRoom(frame: THREE.Matrix4, pose: Pose): Pose {
  const world = new THREE.Vector3(...pose.position).applyMatrix4(frame);
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(frame)).multiply(new THREE.Quaternion(...pose.quaternion));
  return { position: [world.x, world.y, world.z], quaternion: [rotation.x, rotation.y, rotation.z, rotation.w] };
}

// --- Page plumbing ---

type OpenOptions = {
  phone?: boolean;
  flag?: boolean;
  scene?: boolean;
  object?: boolean;
  micDenied?: boolean;
  /** getUserMedia waits on `window.__micGate` (a pending promise until `__openMicGate()`), and records every stream it hands out in `window.__mics`. */
  micGate?: boolean;
  video?: boolean;
};

async function openPage(run: Run, options: OpenOptions): Promise<Page> {
  const context = await createXrContext(run.browser, {
    viewport: VIEWPORT,
    acceptDownloads: true,
    ...(options.video && videoDir ? { recordVideo: { dir: videoDir, size: VIEWPORT } } : {})
  });
  await context.grantPermissions(['microphone']).catch(() => undefined);
  const page = await context.newPage();
  // tsx compiles with keepNames, which wraps named inner functions of the page.evaluate callbacks in a helper the page lacks.
  await page.addInitScript('globalThis.__name = globalThis.__name || ((target) => target);');
  wireXrConsoleErrors(page, run.consoleErrors);
  if (options.phone) await emulatePhone(page);
  if (options.micDenied) {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
  }
  if (options.micGate) {
    await page.addInitScript(() => {
      const w = window as unknown as { __micGate: Promise<void>; __openMicGate: () => void; __mics: { calls: number; streams: MediaStream[] } };
      w.__mics = { calls: 0, streams: [] };
      w.__micGate = new Promise<void>((resolve) => {
        w.__openMicGate = resolve;
      });
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        w.__mics.calls += 1;
        await w.__micGate;
        const stream = await real(constraints);
        w.__mics.streams.push(stream);
        return stream;
      };
    });
  }
  await attachXrEnvironment(page, { mode: 'iwer' });
  const url = new URL(baseUrl);
  url.searchParams.set('manualClock', '1');
  if (options.flag) url.searchParams.set('arCamera', '1');
  if (options.scene) {
    url.searchParams.set('scene', SCENE);
    url.searchParams.set('sceneScale', '1');
  }
  if (options.object) url.searchParams.set('object', OBJECT_URL);
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text', '__toggleRecording', '__arWorldFrame', '__setManualClock']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => window.__setManualClock(true));
  await waitForIwerRuntime(page);
  return page;
}

const arOf = (page: Page): Promise<ArState> => page.evaluate(() => JSON.parse(window.render_game_to_text()).ar as ArState);
const advance = (page: Page, ms: number) => page.evaluate((value) => window.advanceTime(value), ms);
const worldFrame = (page: Page) => page.evaluate(() => window.__arWorldFrame());

/** One real XR frame (emulated frames take about 150 ms); the simulation moves only on advanceTime. */
const nextXrFrame = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => window.IWER_DEVICE!.activeSession!.requestAnimationFrame(() => resolve())));

/** Steps the desktop simulation until the prepared object is placed in front of the avatar (a camera author cannot place one). */
async function placeObjectOnDesktop(page: Page): Promise<{ id: string; placed: boolean; steps: number }> {
  for (let steps = 0; steps < 120; steps += 1) {
    const item = await page.evaluate(() => JSON.parse(window.render_game_to_text()).objects.items[0] as { id?: string; placed: boolean } | undefined);
    if (item?.placed) return { id: item.id ?? '', placed: true, steps };
    await advance(page, STEP_MS);
  }
  return { id: '', placed: false, steps: 120 };
}

/** Enters AR from the page's button with the head at `start`, then advances until the set's placement settles. */
async function enterAr(page: Page, start?: { position: Vec3; yaw: number }, expectSettled = true): Promise<void> {
  await page.evaluate(() => {
    window.IWER_DEVICE!.controlMode = 'programmatic';
  });
  await setHeadPose(page, start?.position ?? [0, 1.6, 0], quat(start?.yaw ?? 0, 0));
  await enterIwerSessionFromButton(page, '#ARButton', { readyCheck: "JSON.parse(window.render_game_to_text()).ar.sessionMode === 'ar'" });
  for (let i = 0; i < 60; i += 1) {
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    if ((await arOf(page)).placementSettled) break;
  }
  if (expectSettled && !(await arOf(page)).placementSettled) throw new Error('placement never settled');
}

async function startRecording(page: Page): Promise<void> {
  await page.evaluate(() => window.__toggleRecording());
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).ar.recordingState === 'recording', null, { timeout: 20000 });
  await advance(page, STEP_MS);
}

async function saveDownload(download: Download, phase: string, report: PhaseReport): Promise<string> {
  const glb = path.join(artifactDir, `${phase}.glb`);
  await copyFile(await download.path(), glb);
  report.takes.push({ filename: download.suggestedFilename(), bytes: (await readFile(glb)).length, glb });
  return glb;
}

/** Waits for a download while advancing the simulation, so the async export can finish. */
async function advanceUntilDownload(page: Page, download: Promise<Download | null>, seconds = 20): Promise<Download | null> {
  let result: Download | null | undefined;
  void download.then((value) => {
    result = value;
  });
  for (let i = 0; i < seconds * 5 && result === undefined; i += 1) {
    await advance(page, STEP_MS);
    await page.waitForTimeout(200);
  }
  return result ?? null;
}

const expectDownload = (page: Page, timeout: number) => page.waitForEvent('download', { timeout }).catch(() => null);

async function walk(page: Page, frame: THREE.Matrix4, pace: number): Promise<void> {
  for (let i = 0; i < WALK_STEPS; i += 1) {
    const room = setToRoom(frame, walkPose(i));
    await setHeadPose(page, room.position, room.quaternion);
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    if (pace > 0) await page.waitForTimeout(pace);
  }
}

// --- Comparing the export with the script ---

function pathOf(report: CameraTakeReport): CameraPath {
  return report.camera!.path;
}

/** Staircase script vs the export: the offset START (take seconds of walk step 0) with the smallest error. */
function alignScript(report: CameraTakeReport): PathAlignment {
  const { translation, rotation } = pathOf(report);
  const empty: PathAlignment = { alignmentSec: NaN, maxPositionCm: Infinity, maxRotationDeg: Infinity, samples: 0 };
  if (!translation || !rotation) return empty;
  const evaluate = (start: number): PathAlignment => {
    let maxPositionCm = 0;
    let maxRotationDeg = 0;
    let samples = 0;
    translation.times.forEach((time, k) => {
      const step = Math.floor((time - start) / (STEP_MS / 1000) + 1e-6);
      if (step < 0 || step >= WALK_STEPS) return;
      const expected = walkPose(step);
      const got = translation.values[k]!;
      maxPositionCm = Math.max(maxPositionCm, Math.hypot(...expected.position.map((v, j) => v - got[j]!)) * 100);
      const q = rotation.values[Math.min(k, rotation.values.length - 1)]!;
      const dot = Math.abs(expected.quaternion.reduce((sum, v, j) => sum + v * q[j]!, 0));
      maxRotationDeg = Math.max(maxRotationDeg, (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI);
      samples += 1;
    });
    return { alignmentSec: round(start, 4), maxPositionCm: round(maxPositionCm), maxRotationDeg: round(maxRotationDeg), samples };
  };
  let best = empty;
  const last = translation.times.at(-1) ?? 0;
  for (let start = 0; start <= last; start += 0.005) {
    const candidate = evaluate(start);
    if (candidate.samples >= WALK_STEPS && candidate.maxPositionCm + candidate.maxRotationDeg < best.maxPositionCm + best.maxRotationDeg) best = candidate;
  }
  return best;
}

function checkTake(report: PhaseReport, glb: Buffer, options: { audio: boolean | 'any' }): CameraTakeReport {
  const take = inspectCameraTake(glb);
  report.take = take;
  for (const failure of assertCameraTake(take)) report.failures.push(failure);
  if (options.audio === true && !take.khrAudio) report.failures.push('KHR_audio missing although the microphone was granted');
  if (options.audio === false && take.khrAudio) report.failures.push('KHR_audio present although the microphone was denied');
  return take;
}

// --- Phases ---

type Walked = { report: PhaseReport; take: CameraTakeReport | null; frame: number[] };

/** phone-a and phone-b: enter, Record, the scripted walk, Stop, read the GLB. */
async function walkPhase(run: Run, phase: 'phone-a' | 'phone-b', start: { position: Vec3; yaw: number }): Promise<Walked> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, flag: true, scene: true, object: true, video: phase === 'phone-a' });
  const pace = phase === 'phone-a' && videoDir ? 500 : 0;
  try {
    const placement = await placeObjectOnDesktop(page);
    report.notes.objectPlacedOnDesktop = placement;
    if (!placement.placed) report.failures.push('the prepared object was not placed on the desktop before AR');
    await enterAr(page, start);
    const frameValues = await worldFrame(page);
    report.worldFrame = frameValues.map((value) => round(value, 4));
    const frame = toMatrix(frameValues);
    report.ar.entered = await arOf(page);
    const ar = report.ar.entered;
    if (!ar.cameraAuthor) report.failures.push('camera author mode is off in a phone AR session with the flag on');
    if (!ar.performerHidden) report.failures.push('performer visible in camera mode');
    if (ar.interactionMode !== 'screen-space') report.failures.push(`interactionMode ${ar.interactionMode}, expected screen-space`);
    if (pace) await page.waitForTimeout(1500);

    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    await startRecording(page);
    report.ar.recording = await arOf(page);
    if (report.ar.recording.takeKind !== 'camera') report.failures.push(`take kind ${report.ar.recording.takeKind}, expected camera`);
    await walk(page, frame, pace);
    // Hold the last pose one more step so the final step has samples.
    await advance(page, STEP_MS);
    report.ar.walked = await arOf(page);

    const download = expectDownload(page, 30000);
    await page.evaluate(() => window.__toggleRecording());
    const saved = await advanceUntilDownload(page, download);
    report.ar.stopped = await arOf(page);
    if (!saved) {
      report.failures.push('no GLB downloaded after Stop');
      return { report, take: null, frame: frameValues };
    }
    const glb = await saveDownload(saved, phase, report);
    if (!saved.suggestedFilename().startsWith('camera-recording-')) report.failures.push(`filename ${saved.suggestedFilename()} is not a camera-recording-*`);
    const take = checkTake(report, await readFile(glb), { audio: true });
    report.scriptVsExport = alignScript(take);
    const xs = take.camera!.path.translation?.values.map((row) => row[0]!) ?? [0];
    report.notes.cameraSpanXMeters = round(Math.max(...xs) - Math.min(...xs));
    if ((report.notes.cameraSpanXMeters as number) < 0.3) report.failures.push('the exported camera barely moved; the walk was not recorded');
    if (!(report.scriptVsExport.maxPositionCm <= PATH_TOLERANCE_CM)) report.failures.push(`camera path off the script by ${report.scriptVsExport.maxPositionCm} cm (limit ${PATH_TOLERANCE_CM})`);
    if (!(report.scriptVsExport.maxRotationDeg <= PATH_TOLERANCE_DEG)) report.failures.push(`camera path off the script by ${report.scriptVsExport.maxRotationDeg} deg (limit ${PATH_TOLERANCE_DEG})`);
    if (take.objects.length !== 1) report.failures.push(`${take.objects.length} event objects in the take, expected the one placed before AR`);
    for (const object of take.objects) {
      const t = object.channels.translation;
      const r = object.channels.rotation;
      if (!t || !r) report.failures.push(`object ${object.name} has no translation/rotation channels`);
      else {
        // Nothing moves it, so it must stand still in the set frame.
        const span = (track: { values: number[][] }, k: number) => Math.max(...track.values.map((row) => row[k]!)) - Math.min(...track.values.map((row) => row[k]!));
        const driftCm = Math.max(span(t, 0), span(t, 1), span(t, 2)) * 100;
        report.notes.objectDriftCm = round(driftCm);
        report.notes.objectPositionInSet = t.values[0]!.map((v) => round(v, 3));
        if (driftCm > PATH_TOLERANCE_CM) report.failures.push(`object ${object.name} moved ${round(driftCm)} cm in the set frame`);
      }
    }
    if (pace) await page.waitForTimeout(1500);
    return { report, take, frame: frameValues };
  } finally {
    await page.context().close();
  }
}

type Comparison = { cameraPath: PathComparison; setNodes: NodeComparison; objects: Array<{ name: string; positionCm: number; rotationDeg: number }>; worldFrameDeltaM: number; worldFrameDeltaDeg: number };

function compareTakes(a: Walked, b: Walked): { comparison: Comparison; failures: string[] } {
  const failures: string[] = [];
  const ta = a.take!;
  const tb = b.take!;
  const frameA = toMatrix(a.frame);
  const frameB = toMatrix(b.frame);
  const deltaM = new THREE.Vector3().setFromMatrixPosition(frameA).distanceTo(new THREE.Vector3().setFromMatrixPosition(frameB));
  const deltaDeg = THREE.MathUtils.radToDeg(
    new THREE.Quaternion().setFromRotationMatrix(frameA).angleTo(new THREE.Quaternion().setFromRotationMatrix(frameB))
  );
  const cameraPath = comparePaths(pathOf(ta), pathOf(tb));
  const setNodes = compareNodePositions(ta.setNodes, tb.setNodes);
  const objects = ta.objects.map((object, index) => {
    const other = tb.objects[index];
    const sa = object.channels.translation;
    const sb = other?.channels.translation;
    if (!sa || !sb) return { name: object.name, positionCm: object.channels.translation || other?.channels.translation ? Infinity : 0, rotationDeg: 0 };
    const path = (track: typeof sa): CameraPath => ({ translation: track, rotation: object.channels.rotation ?? { times: [0], values: [[0, 0, 0, 1]], interpolation: 'LINEAR' } });
    const compared = comparePaths(path(sa), { translation: sb, rotation: other?.channels.rotation ?? object.channels.rotation ?? path(sa).rotation });
    return { name: object.name, positionCm: compared.maxPositionCm, rotationDeg: compared.maxRotationDeg };
  });
  if (!(deltaM > 0.5 || deltaDeg > 20)) failures.push(`the two placements are too alike (${round(deltaM)} m, ${round(deltaDeg)} deg); the cross-placement check proves nothing`);
  if (!(cameraPath.maxPositionCm <= PATH_TOLERANCE_CM)) failures.push(`camera path differs across placements by ${cameraPath.maxPositionCm} cm`);
  if (!(cameraPath.maxRotationDeg <= PATH_TOLERANCE_DEG)) failures.push(`camera path differs across placements by ${cameraPath.maxRotationDeg} deg`);
  if (!(setNodes.maxCm <= PATH_TOLERANCE_CM)) failures.push(`set nodes differ across placements by ${setNodes.maxCm} cm`);
  if (setNodes.onlyInA.length > 0 || setNodes.onlyInB.length > 0) failures.push(`set nodes only in one take: ${[...setNodes.onlyInA, ...setNodes.onlyInB].join(', ')}`);
  if (ta.objects.length !== tb.objects.length) failures.push(`object counts differ across placements (${ta.objects.length} vs ${tb.objects.length})`);
  for (const object of objects) if (!(object.positionCm <= PATH_TOLERANCE_CM)) failures.push(`object ${object.name} differs across placements by ${object.positionCm} cm`);
  return { comparison: { cameraPath, setNodes, objects, worldFrameDeltaM: round(deltaM), worldFrameDeltaDeg: round(deltaDeg) }, failures };
}

/** Records a short still take in a phone session and ends it a given way. */
async function interruptPhase(run: Run, phase: 'mic-denied' | 'session-end' | 'page-hidden'): Promise<PhaseReport> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, flag: true, scene: true, micDenied: phase === 'mic-denied' });
  try {
    await enterAr(page);
    const frame = toMatrix(await worldFrame(page));
    report.ar.entered = await arOf(page);
    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    await startRecording(page);
    report.ar.recording = await arOf(page);
    const notices = new Set<string>();
    const noteMessages = async () => {
      const state = await arOf(page);
      for (const text of [state.notice, state.recordingMessage]) if (text) notices.add(text);
    };
    await noteMessages();
    for (let i = 0; i < 10; i += 1) {
      const room = setToRoom(frame, walkPose(i));
      await setHeadPose(page, room.position, room.quaternion);
      await nextXrFrame(page);
      await advance(page, STEP_MS);
    }
    await noteMessages();
    const download = expectDownload(page, 30000);
    if (phase === 'session-end') {
      await page.evaluate(() => window.IWER_DEVICE!.activeSession!.end());
    } else if (phase === 'page-hidden') {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    } else {
      await page.evaluate(() => window.__toggleRecording());
    }
    const saved = await advanceUntilDownload(page, download);
    await noteMessages();
    report.ar.after = await arOf(page).catch(() => report.ar.recording!);
    report.notes.messages = [...notices];
    if (!saved) {
      report.failures.push(`no GLB downloaded after ${phase}`);
      return report;
    }
    const glb = await saveDownload(saved, phase, report);
    const take = checkTake(report, await readFile(glb), { audio: phase === 'mic-denied' ? false : 'any' });
    if (phase === 'mic-denied') {
      if (report.ar.recording.micPermission !== 'denied' && report.ar.after.micPermission !== 'denied') report.failures.push(`micPermission ${report.ar.after.micPermission}, expected denied`);
      if (notices.size === 0) report.failures.push('no notice or message said the take is silent');
    }
    report.notes.khrAudio = take.khrAudio;
    return report;
  } finally {
    await page.context().close();
  }
}

/** The page hides while Record is waiting for the microphone: the take never begins and nothing downloads. */
async function hiddenAtStartPhase(run: Run): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'hidden-at-start', failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, flag: true, scene: true, micGate: true });
  try {
    // The AR entry holds the microphone; its request stays pending behind the gate, so Record's start waits on it.
    await enterAr(page);
    report.ar.entered = await arOf(page);
    const frame = toMatrix(await worldFrame(page));
    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    const states = new Set<string>();
    const download = expectDownload(page, 5000);
    await page.evaluate(() => window.__toggleRecording());
    await page.waitForTimeout(300);
    report.ar.pending = await arOf(page);
    states.add(report.ar.pending.recordingState);
    if (report.ar.pending.recordingState !== 'idle') report.failures.push(`recordingState ${report.ar.pending.recordingState} while the microphone was still pending, expected idle`);
    // The page hides, the microphone arrives while hidden, then the page shows again.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window as unknown as { __openMicGate: () => void }).__openMicGate());
    for (let i = 0; i < 10; i += 1) {
      await advance(page, STEP_MS);
      await page.waitForTimeout(150);
      states.add((await arOf(page)).recordingState);
    }
    report.ar.hiddenAfterGrant = await arOf(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    for (let i = 0; i < 20; i += 1) {
      await advance(page, STEP_MS);
      await page.waitForTimeout(150);
      states.add((await arOf(page)).recordingState);
    }
    report.ar.after = await arOf(page);
    const saved = await download;
    report.notes.statesSeen = [...states];
    if (saved) {
      report.failures.push(`a take ${saved.suggestedFilename()} was downloaded although the page hid before recording began`);
      await saveDownload(saved, 'hidden-at-start', report);
    }
    if (states.has('recording') || states.has('exporting')) report.failures.push(`recordingState passed through ${[...states].join(', ')}; no take should have begun`);
    if (report.ar.after.recordingState !== 'idle') report.failures.push(`recordingState ${report.ar.after.recordingState} at the end, expected idle`);
    if (report.ar.after.cameraSamples !== 0) report.failures.push(`${report.ar.after.cameraSamples} camera samples recorded for a take that never began`);
    const mics = await page.evaluate(() => {
      const mics = (window as unknown as { __mics: { calls: number; streams: MediaStream[] } }).__mics;
      return { calls: mics.calls, streams: mics.streams.length, liveTracks: mics.streams.flatMap((stream) => stream.getAudioTracks()).filter((track) => track.readyState === 'live').length };
    });
    report.notes.mic = mics;
    if (mics.liveTracks > 1) report.failures.push(`${mics.liveTracks} live microphone tracks left; only the session's held one may remain`);
    // Two calls are expected: the page's startup permission check (its stream is released at once) and the entry hold, which Record's start shares.
    if (mics.calls > 2) report.failures.push(`${mics.calls} getUserMedia calls; the entry hold and Record should share one request`);
    return report;
  } finally {
    await page.context().close();
  }
}

async function emptySetPhase(run: Run): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'empty-set', failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, flag: true, scene: false });
  try {
    await enterAr(page, undefined, false);
    report.ar.entered = await arOf(page);
    if (!report.ar.entered.cameraAuthor) report.failures.push('camera author mode is off in a phone AR session with the flag on');
    const download = expectDownload(page, 4000);
    await page.evaluate(() => window.__toggleRecording());
    for (let i = 0; i < 12; i += 1) {
      await advance(page, STEP_MS);
      await page.waitForTimeout(250);
    }
    report.ar.after = await arOf(page);
    const saved = await download;
    if (saved) {
      report.failures.push(`Record on an empty set downloaded ${saved.suggestedFilename()}`);
      await saveDownload(saved, 'empty-set', report);
    }
    if (report.ar.after.recordingState !== 'idle') report.failures.push(`recordingState ${report.ar.after.recordingState} after a refused Record`);
    if (!/nothing to record/i.test(`${report.ar.after.notice ?? ''} ${report.ar.after.recordingMessage ?? ''}`)) {
      report.failures.push(`no "Nothing to record" notice (notice ${JSON.stringify(report.ar.after.notice)}, message ${JSON.stringify(report.ar.after.recordingMessage)})`);
    }
    return report;
  } finally {
    await page.context().close();
  }
}

/** Quest passthrough and phone-with-flag-off: a spectator that never becomes a camera. */
async function spectatorPhase(run: Run, phase: 'quest-passthrough' | 'phone-flag-off'): Promise<PhaseReport> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: phase === 'phone-flag-off', flag: phase === 'quest-passthrough', scene: true });
  try {
    await enterAr(page);
    const ar = await arOf(page);
    report.ar.entered = ar;
    if (ar.cameraAuthor) report.failures.push('camera author mode on');
    if (!ar.spectator) report.failures.push('not a spectator in AR');
    if (ar.performerHidden) report.failures.push('performer hidden in a spectator session');
    if (ar.micHeld) report.failures.push('microphone held open in a spectator session');
    report.notes.expectedInteractionMode = phase === 'phone-flag-off' ? 'screen-space' : 'world-space';
    if (ar.interactionMode !== report.notes.expectedInteractionMode) report.failures.push(`interactionMode ${ar.interactionMode}, expected ${String(report.notes.expectedInteractionMode)}`);
    const download = expectDownload(page, 6000);
    await page.evaluate(() => window.__toggleRecording());
    for (let i = 0; i < 20; i += 1) {
      await advance(page, STEP_MS);
      await page.waitForTimeout(150);
    }
    report.ar.afterRecord = await arOf(page);
    // Record only: stopping a spectator take (no samples) is main's behaviour and logs a KeyframeTrack error unrelated to camera mode.
    const saved = await download;
    report.notes.afterToggleRecording = { recordingState: report.ar.afterRecord.recordingState, notice: report.ar.afterRecord.notice, download: saved?.suggestedFilename() ?? null };
    if (saved) {
      await saveDownload(saved, phase, report);
      if (saved.suggestedFilename().startsWith('camera-recording-')) report.failures.push(`a camera take ${saved.suggestedFilename()} was exported from a spectator session`);
    }
    if (report.ar.afterRecord.takeKind === 'camera') report.failures.push('take kind camera in a spectator session');
    return report;
  } finally {
    await page.context().close();
  }
}

// --- Main ---

await mkdir(artifactDir, { recursive: true });
if (videoDir) await mkdir(videoDir, { recursive: true });
const consoleErrors: string[] = [];
const reports: PhaseReport[] = [];
const startedAt = Date.now();
const browser = await launchXrBrowser(chromium, { args: FAKE_MIC_ARGS });
const run: Run = { browser, consoleErrors };
const selected = (phase: Phase) => !only || phase.includes(only);
let comparison: Comparison | undefined;
try {
  const walked: Partial<Record<'phone-a' | 'phone-b', Walked>> = {};
  const finish = (report: PhaseReport) => {
    reports.push(report);
    const s = report.scriptVsExport;
    console.log(`[ar-record] ${report.phase}: ${report.failures.length === 0 ? 'passed' : 'FAILED'}${s ? `; script error ${s.maxPositionCm} cm, ${s.maxRotationDeg} deg` : ''}${report.take?.camera ? `; camera keys ${report.take.camera.translationKeys}` : ''}`);
  };
  for (const phase of PHASES) {
    if (!selected(phase)) continue;
    console.log(`[ar-record] ${phase}`);
    if (phase === 'phone-a') {
      walked[phase] = await walkPhase(run, phase, { position: [0, 1.6, 0], yaw: 0 });
      finish(walked[phase]!.report);
    } else if (phase === 'phone-b') {
      walked[phase] = await walkPhase(run, phase, { position: [1.2, 1.6, -0.8], yaw: 1.2 });
      finish(walked[phase]!.report);
    } else if (phase === 'mic-denied' || phase === 'session-end' || phase === 'page-hidden') {
      finish(await interruptPhase(run, phase));
    } else if (phase === 'hidden-at-start') {
      finish(await hiddenAtStartPhase(run));
    } else if (phase === 'empty-set') {
      finish(await emptySetPhase(run));
    } else {
      finish(await spectatorPhase(run, phase));
    }
  }
  if (walked['phone-a']?.take && walked['phone-b']?.take) {
    const compared = compareTakes(walked['phone-a'], walked['phone-b']);
    comparison = compared.comparison;
    walked['phone-b'].report.failures.push(...compared.failures);
    console.log(`[ar-record] placements differ by ${comparison.worldFrameDeltaM} m, ${comparison.worldFrameDeltaDeg} deg; camera path ${comparison.cameraPath.maxPositionCm} cm, ${comparison.cameraPath.maxRotationDeg} deg; set nodes ${comparison.setNodes.maxCm} cm`);
  }
  await writeFile(path.join(artifactDir, 'ar-record-report.json'), JSON.stringify({ reports, comparison, consoleErrors, seconds: round((Date.now() - startedAt) / 1000, 1) }, null, 2));
  const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.phase}: ${failure}`));
  if (consoleErrors.length > 0) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
  if (failures.length > 0) throw new Error(`AR recording check failed:\n- ${failures.join('\n- ')}`);
  console.log('AR recording check passed.');
} finally {
  await browser.close();
}
