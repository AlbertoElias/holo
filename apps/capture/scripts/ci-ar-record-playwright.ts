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
  type CameraTakeReport,
  type NodeComparison,
  type PathComparison
} from './lib/camera-take-glb.ts';
import { emulatePhone, setHeadPose, type Quat, type Vec3 } from './lib/iwer-phone.ts';

// Camera author mode (docs/features/ar-recording.md, slice 2a): phone AR in
// IWER with the phone helper records a scripted camera walk and exports a
// camera take. Phases (each a fresh page; every phase also counts its
// downloads and fails on a stray or missing one):
//   phone-a           flag on, pointing-targets set and a bracket object placed on the desktop first.
//                     Record pressed while the set is still settling is refused. Then Record, a scripted
//                     walk, Recenter pressed mid-take (refused, the frame unchanged), Stop. Every scripted
//                     step must be covered by an exported sample within 1 cm and 1 degree.
//   phone-b           the same walk under a second placement: the take must not change (camera path over
//                     its whole duration, set nodes, the object's translation and rotation).
//   mic-denied        getUserMedia rejects: a silent take with the exact notice, no KHR_audio.
//   session-end       the XR session ends mid-take (with non-finite head poses in the middle of it): the
//                     take is exported, and the held microphone's tracks end without any frame advancing.
//   page-hidden       visibilitychange to hidden mid-take: the take is exported.
//   hidden-at-start   Record waits on the microphone, the page hides, the microphone arrives, the page
//                     shows again: no take starts, nothing downloads, Recenter is refused while it waits.
//   restored-at-start the same, but the page is shown again before the microphone arrives. Ends with a
//                     positive control: Recenter works again once nothing is busy.
//   ended-at-start    the XR session ends while Record waits on the microphone: no take, no live tracks.
//   empty-set         the default (empty) scene: Record is refused, nothing downloads.
//   quest-passthrough flag on, Quest 3 (world-space) AR: spectator; Record refused (twice), no take.
//   interaction-undefined  flag on, a phone whose interactionMode is undefined: treated like a headset.
//   phone-flag-off    phone AR without the flag: spectator, no camera take. Record only: Stop in a
//                     spectator session is main's behaviour and out of scope here.
// How the path is compared: each walk step sets the head pose (in the set frame, converted to the room
// with the live world frame), waits for one real XR frame, then advances the simulation by STEP_MS. The
// recorder samples the camera each simulated frame, so one pose is held for several samples. The script
// is a staircase (pose i holds from START + i * STEP to START + (i + 1) * STEP); START, the take time of
// the first step, is the offset with the most covered steps and then the smallest error (`alignmentSec`).
// A step is covered when a translation key inside its window matches within 1 cm AND a rotation key
// (rotation has its own times) inside its window matches within 1 degree.
// AR_RECORD_ONLY=<substring[,substring]> keeps matching phases; AR_RECORD_VIDEO_DIR=<dir> records phone-a
// on video at a watchable pace. Writes output/ci-ar-record/<phase>.glb and ar-record-report.json.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-ar-record';
const only = process.env.AR_RECORD_ONLY?.split(',');
const videoDir = process.env.AR_RECORD_VIDEO_DIR;

const SCENE = '/fixtures/scenes/pointing-targets.gltf';
const OBJECT_URL = '/fixtures/objects/bracket.glb';
const VIEWPORT = { width: 640, height: 400 };
const STEP_MS = 100;
const STEP_SEC = STEP_MS / 1000;
const WALK_STEPS = 30;
const PATH_TOLERANCE_CM = 1;
const PATH_TOLERANCE_DEG = 1;
const FAKE_MIC_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const SILENT_NOTICE = 'No microphone: this take is silent.';
const SETTLE_NOTICE = 'Wait for the set to settle before recording.';
const RECENTER_NOTICE = 'Stop recording to recenter.';
const HEADSET_NOTICE = 'Only a phone records in AR; a headset in passthrough watches.';
const EMPTY_NOTICE = 'Nothing to record: no part of the set is near.';

const PHASES = [
  'phone-a',
  'phone-b',
  'mic-denied',
  'session-end',
  'page-hidden',
  'hidden-at-start',
  'restored-at-start',
  'ended-at-start',
  'empty-set',
  'quest-passthrough',
  'interaction-undefined',
  'phone-flag-off'
] as const;
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

type StepCoverage = {
  alignmentSec: number;
  maxPositionCm: number;
  maxRotationDeg: number;
  stepsCovered: number;
  stepsMissing: number[];
  durationSec: number;
  scriptDurationSec: number;
};

type PhaseReport = {
  phase: Phase;
  failures: string[];
  notes: Record<string, unknown>;
  ar: Record<string, ArState>;
  takes: Array<{ filename: string; bytes: number; glb: string }>;
  take?: CameraTakeReport;
  scriptVsExport?: StepCoverage;
  worldFrame?: number[];
};

type Run = { browser: Browser; consoleErrors: string[] };
type Pose = { position: Vec3; quaternion: Quat };

const round = (value: number, places = 2) => Number(value.toFixed(places));
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, k) => value === b[k]);

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
  phone?: boolean | 'interaction-unset';
  flag?: boolean;
  scene?: boolean;
  object?: boolean;
  micDenied?: boolean;
  /**
   * 'gate': getUserMedia waits on `window.__micGate` until `__openMicGate()`; 'track': it does not wait.
   * Both record the streams they hand out in `window.__mics`.
   */
  mic?: 'gate' | 'track';
  video?: boolean;
};

/** Every download a page made, in order. */
const downloadLog = new WeakMap<Page, string[]>();

async function openPage(run: Run, options: OpenOptions): Promise<Page> {
  const context = await createXrContext(run.browser, {
    viewport: VIEWPORT,
    acceptDownloads: true,
    ...(options.video && videoDir ? { recordVideo: { dir: videoDir, size: VIEWPORT } } : {})
  });
  await context.grantPermissions(['microphone']).catch(() => undefined);
  const page = await context.newPage();
  const downloads: string[] = [];
  downloadLog.set(page, downloads);
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  // tsx compiles with keepNames, which wraps named inner functions of the page.evaluate callbacks in a helper the page lacks.
  await page.addInitScript('globalThis.__name = globalThis.__name || ((target) => target);');
  wireXrConsoleErrors(page, run.consoleErrors);
  if (options.phone) await emulatePhone(page, options.phone === 'interaction-unset' ? { interactionMode: 'unset' } : {});
  if (options.micDenied) {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
  }
  if (options.mic) {
    await page.addInitScript((gated) => {
      const w = window as unknown as { __micGate: Promise<void>; __openMicGate: () => void; __mics: { calls: number; streams: MediaStream[] } };
      w.__mics = { calls: 0, streams: [] };
      w.__micGate = new Promise<void>((resolve) => {
        w.__openMicGate = resolve;
      });
      if (!gated) w.__openMicGate();
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        // The face driver's voice meter asks for the microphone on the desktop; it is not the recording's.
        if (new Error().stack?.includes('VoiceLevel')) return real(constraints);
        w.__mics.calls += 1;
        await w.__micGate;
        const stream = await real(constraints);
        w.__mics.streams.push(stream);
        return stream;
      };
    }, options.mic === 'gate');
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
const toggle = (page: Page) => page.evaluate(() => window.__toggleRecording());

/** One real XR frame (emulated frames take about 150 ms); the simulation moves only on advanceTime. */
const nextXrFrame = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => window.IWER_DEVICE!.activeSession!.requestAnimationFrame(() => resolve())));

/** Starts the AR session from the page's button with the head at `start` (the set is placed over the next frames). */
async function enterSession(page: Page, start?: { position: Vec3; yaw: number }): Promise<void> {
  await page.evaluate(() => {
    window.IWER_DEVICE!.controlMode = 'programmatic';
  });
  await setHeadPose(page, start?.position ?? [0, 1.6, 0], quat(start?.yaw ?? 0, 0));
  await enterIwerSessionFromButton(page, '#ARButton', { readyCheck: "JSON.parse(window.render_game_to_text()).ar.sessionMode === 'ar'" });
}

/** Advances until the set's placement settles. */
async function settle(page: Page, expectSettled = true): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    if ((await arOf(page)).placementSettled) break;
  }
  if (expectSettled && !(await arOf(page)).placementSettled) throw new Error('placement never settled');
}

async function enterAr(page: Page, start?: { position: Vec3; yaw: number }, expectSettled = true): Promise<void> {
  await enterSession(page, start);
  await settle(page, expectSettled);
}

/**
 * Keeps the Recenter control's click handler, so it can be pressed while the dock hides it (a take
 * hides everything but Stop). Returns false when the control is not drawn.
 */
const captureRecenter = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const button = document.querySelector('[aria-label="Recenter AR"]') as (HTMLElement & Record<string, unknown>) | null;
    if (!button) return false;
    const key = Object.keys(button).find((name) => name.startsWith('__reactProps'));
    const onClick = key ? (button[key] as { onClick?: (event: object) => void }).onClick : undefined;
    if (!onClick) return false;
    (window as unknown as { __pressRecenter: () => void }).__pressRecenter = () =>
      onClick({ type: 'click', detail: 1, button: 0, currentTarget: button, target: button, preventDefault() {}, stopPropagation() {}, nativeEvent: {} });
    return true;
  });
const pressRecenter = (page: Page) => page.evaluate(() => (window as unknown as { __pressRecenter: () => void }).__pressRecenter());

async function startRecording(page: Page): Promise<void> {
  await toggle(page);
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

/** Lets any stray second download arrive, then checks the phase made exactly `expected`. */
async function expectDownloadCount(page: Page, report: PhaseReport, expected: number): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await advance(page, STEP_MS).catch(() => undefined);
    await page.waitForTimeout(150);
  }
  const names = downloadLog.get(page) ?? [];
  report.notes.downloads = names;
  if (names.length !== expected) report.failures.push(`${names.length} download(s) [${names.join(', ')}], expected ${expected}`);
}

async function walk(page: Page, frame: THREE.Matrix4, pace: number, between?: (step: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < WALK_STEPS; i += 1) {
    const room = setToRoom(frame, walkPose(i));
    await setHeadPose(page, room.position, room.quaternion);
    await nextXrFrame(page);
    await between?.(i);
    await advance(page, STEP_MS);
    if (pace > 0) await page.waitForTimeout(pace);
  }
}

// --- Comparing the export with the script ---

/** The script as a staircase against the export: every step must be covered, over a take of the script's length. */
function alignScript(report: CameraTakeReport): StepCoverage {
  const translation = report.camera?.path.translation;
  const rotation = report.camera?.path.rotation;
  const scriptDurationSec = (WALK_STEPS + 2) * STEP_SEC;
  const empty: StepCoverage = { alignmentSec: NaN, maxPositionCm: Infinity, maxRotationDeg: Infinity, stepsCovered: 0, stepsMissing: [], durationSec: report.camera?.durationSec ?? 0, scriptDurationSec };
  if (!translation || !rotation) return empty;
  const stepOf = (time: number, start: number) => Math.floor((time - start) / STEP_SEC + 1e-6);
  const positionErrorCm = (step: number, row: number[]) => Math.hypot(...walkPose(step).position.map((v, j) => v - row[j]!)) * 100;
  const rotationErrorDeg = (step: number, row: number[]) => {
    const dot = Math.abs(walkPose(step).quaternion.reduce((sum, v, j) => sum + v * row[j]!, 0)) / (Math.hypot(...row) || 1);
    return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
  };
  const evaluate = (start: number): StepCoverage => {
    const positionOk = new Set<number>();
    const rotationOk = new Set<number>();
    let maxPositionCm = 0;
    let maxRotationDeg = 0;
    translation.times.forEach((time, k) => {
      const step = stepOf(time, start);
      if (step < 0 || step >= WALK_STEPS) return;
      const error = positionErrorCm(step, translation.values[k]!);
      maxPositionCm = Math.max(maxPositionCm, error);
      if (error <= PATH_TOLERANCE_CM) positionOk.add(step);
    });
    // Rotation is read at its own key times and indices, not translation's.
    rotation.times.forEach((time, k) => {
      const step = stepOf(time, start);
      if (step < 0 || step >= WALK_STEPS) return;
      const error = rotationErrorDeg(step, rotation.values[k]!);
      maxRotationDeg = Math.max(maxRotationDeg, error);
      if (error <= PATH_TOLERANCE_DEG) rotationOk.add(step);
    });
    const stepsMissing = Array.from({ length: WALK_STEPS }, (_, step) => step).filter((step) => !(positionOk.has(step) && rotationOk.has(step)));
    return { alignmentSec: round(start, 4), maxPositionCm: round(maxPositionCm), maxRotationDeg: round(maxRotationDeg), stepsCovered: WALK_STEPS - stepsMissing.length, stepsMissing, durationSec: empty.durationSec, scriptDurationSec };
  };
  let best = empty;
  const last = Math.max(translation.times.at(-1) ?? 0, rotation.times.at(-1) ?? 0);
  for (let start = 0; start <= last; start += 0.005) {
    const candidate = evaluate(start);
    const better = candidate.stepsCovered > best.stepsCovered || (candidate.stepsCovered === best.stepsCovered && candidate.maxPositionCm + candidate.maxRotationDeg < best.maxPositionCm + best.maxRotationDeg);
    if (better) best = candidate;
  }
  return best;
}

function checkTake(report: PhaseReport, glb: Buffer, options: { audio: boolean | 'any' }): CameraTakeReport {
  const take = inspectCameraTake(glb);
  report.take = take;
  for (const failure of assertCameraTake(take)) report.failures.push(failure);
  if (options.audio === true && (!take.khrAudio || take.audio.sources < 1 || take.audio.payloadBytes <= 0)) {
    report.failures.push(`KHR_audio does not carry audio although the microphone was granted (${take.audio.sources} source(s), ${take.audio.payloadBytes} bytes)`);
  }
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
    await enterSession(page, start);

    // Record while the set is still settling is refused. A placement counts as settled until its first frame, so one step runs first.
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    const early = await arOf(page);
    report.ar.entering = early;
    if (early.placementSettled) {
      report.failures.push('the set was already settled on entry; the settling refusal could not be checked');
    } else {
      await toggle(page);
      await page.waitForTimeout(150);
      const refused = await arOf(page);
      report.ar.settlingRefused = refused;
      if (refused.notice !== SETTLE_NOTICE) report.failures.push(`Record while settling: notice ${JSON.stringify(refused.notice)}, expected ${JSON.stringify(SETTLE_NOTICE)}`);
      if (refused.recordingState !== 'idle') report.failures.push(`Record while settling left recordingState ${refused.recordingState}`);
    }
    await settle(page);

    const frameValues = await worldFrame(page);
    report.worldFrame = frameValues.map((value) => round(value, 4));
    const frame = toMatrix(frameValues);
    report.ar.entered = await arOf(page);
    const ar = report.ar.entered;
    if (!ar.cameraAuthor) report.failures.push('camera author mode is off in a phone AR session with the flag on');
    if (!ar.performerHidden) report.failures.push('performer visible in camera mode');
    if (ar.interactionMode !== 'screen-space') report.failures.push(`interactionMode ${ar.interactionMode}, expected screen-space`);
    if (!(await captureRecenter(page))) report.failures.push('the Recenter control is not drawn in phone AR');
    if (pace) await page.waitForTimeout(1500);

    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    await startRecording(page);
    report.ar.recording = await arOf(page);
    if (report.ar.recording.takeKind !== 'camera') report.failures.push(`take kind ${report.ar.recording.takeKind}, expected camera`);
    // Recenter in the middle of the take is refused: no notice-less success, and the set does not move.
    await walk(page, frame, pace, async (step) => {
      if (step !== 10) return;
      await pressRecenter(page);
      const after = await arOf(page);
      report.ar.recenterMidTake = after;
      if (after.notice !== RECENTER_NOTICE) report.failures.push(`Recenter mid-take: notice ${JSON.stringify(after.notice)}, expected ${JSON.stringify(RECENTER_NOTICE)}`);
      if (after.recordingState !== 'recording') report.failures.push(`Recenter mid-take left recordingState ${after.recordingState}`);
      if (!same(await worldFrame(page), frameValues)) report.failures.push('the set moved when Recenter was pressed mid-take');
    });
    // Hold the last pose one more step so the final step has samples.
    await advance(page, STEP_MS);
    report.ar.walked = await arOf(page);

    const download = expectDownload(page, 30000);
    await toggle(page);
    const saved = await advanceUntilDownload(page, download);
    report.ar.stopped = await arOf(page);
    if (!saved) {
      report.failures.push('no GLB downloaded after Stop');
      return { report, take: null, frame: frameValues };
    }
    const glb = await saveDownload(saved, phase, report);
    if (!saved.suggestedFilename().startsWith('camera-recording-')) report.failures.push(`filename ${saved.suggestedFilename()} is not a camera-recording-*`);
    const take = checkTake(report, await readFile(glb), { audio: true });
    const coverage = alignScript(take);
    report.scriptVsExport = coverage;
    if (coverage.stepsCovered < WALK_STEPS) report.failures.push(`only ${coverage.stepsCovered} of ${WALK_STEPS} scripted steps are covered by exported samples (missing ${coverage.stepsMissing.join(', ')})`);
    if (!(coverage.maxPositionCm <= PATH_TOLERANCE_CM)) report.failures.push(`camera path off the script by ${coverage.maxPositionCm} cm (limit ${PATH_TOLERANCE_CM})`);
    if (!(coverage.maxRotationDeg <= PATH_TOLERANCE_DEG)) report.failures.push(`camera path off the script by ${coverage.maxRotationDeg} deg (limit ${PATH_TOLERANCE_DEG})`);
    if (Math.abs(coverage.durationSec - coverage.scriptDurationSec) > STEP_SEC) report.failures.push(`take lasts ${coverage.durationSec} s, the script ${coverage.scriptDurationSec} s (limit one step)`);
    const xs = take.camera!.path.translation?.values.map((row) => row[0]!) ?? [0];
    report.notes.cameraSpanXMeters = round(Math.max(...xs) - Math.min(...xs));
    if ((report.notes.cameraSpanXMeters as number) < 0.3) report.failures.push('the exported camera barely moved; the walk was not recorded');
    if (take.objects.length !== 1) report.failures.push(`${take.objects.length} event objects in the take, expected the one placed before AR`);
    for (const object of take.objects) {
      const t = object.channels.translation;
      const r = object.channels.rotation;
      if (!t || !r) {
        report.failures.push(`object ${object.name} has no translation/rotation channels`);
      } else {
        // Nothing moves it, so it must stand still in the set frame.
        const span = (track: { values: number[][] }, k: number) => Math.max(...track.values.map((row) => row[k]!)) - Math.min(...track.values.map((row) => row[k]!));
        const driftCm = Math.max(span(t, 0), span(t, 1), span(t, 2)) * 100;
        report.notes.objectDriftCm = round(driftCm);
        report.notes.objectPositionInSet = t.values[0]!.map((v) => round(v, 3));
        if (driftCm > PATH_TOLERANCE_CM) report.failures.push(`object ${object.name} moved ${round(driftCm)} cm in the set frame`);
      }
    }
    await expectDownloadCount(page, report, 1);
    if (pace) await page.waitForTimeout(1500);
    return { report, take, frame: frameValues };
  } finally {
    await page.context().close();
  }
}

/** Steps the desktop simulation until the prepared object is placed in front of the avatar (a camera author cannot place one). */
async function placeObjectOnDesktop(page: Page): Promise<{ id: string; placed: boolean; steps: number }> {
  for (let steps = 0; steps < 120; steps += 1) {
    const item = await page.evaluate(() => JSON.parse(window.render_game_to_text()).objects.items[0] as { id?: string; placed: boolean } | undefined);
    if (item?.placed) return { id: item.id ?? '', placed: true, steps };
    await advance(page, STEP_MS);
  }
  return { id: '', placed: false, steps: 120 };
}

type ObjectComparison = { name: string; positionCm: number; rotationDeg: number };
type Comparison = { cameraPath: PathComparison; setNodes: NodeComparison; objects: ObjectComparison[]; worldFrameDeltaM: number; worldFrameDeltaDeg: number; durationDeltaSec: number };

function compareTakes(a: Walked, b: Walked): { comparison: Comparison; failures: string[] } {
  const failures: string[] = [];
  const ta = a.take!;
  const tb = b.take!;
  const frameA = toMatrix(a.frame);
  const frameB = toMatrix(b.frame);
  const deltaM = new THREE.Vector3().setFromMatrixPosition(frameA).distanceTo(new THREE.Vector3().setFromMatrixPosition(frameB));
  const deltaDeg = THREE.MathUtils.radToDeg(new THREE.Quaternion().setFromRotationMatrix(frameA).angleTo(new THREE.Quaternion().setFromRotationMatrix(frameB)));
  const cameraPath = comparePaths(ta.camera!.path, tb.camera!.path);
  const setNodes = compareNodePositions(ta.setNodes, tb.setNodes);
  const durationDeltaSec = round(Math.abs(ta.camera!.durationSec - tb.camera!.durationSec), 6);
  const objects: ObjectComparison[] = ta.objects.map((object, index) => {
    const other = tb.objects[index];
    const [ta1, ra1, tb1, rb1] = [object.channels.translation, object.channels.rotation, other?.channels.translation, other?.channels.rotation];
    if (!ta1 || !ra1 || !tb1 || !rb1) return { name: object.name, positionCm: Infinity, rotationDeg: Infinity };
    const compared = comparePaths({ translation: ta1, rotation: ra1 }, { translation: tb1, rotation: rb1 });
    return { name: object.name, positionCm: compared.maxPositionCm, rotationDeg: compared.maxRotationDeg };
  });
  if (!(deltaM > 0.5 || deltaDeg > 20)) failures.push(`the two placements are too alike (${round(deltaM)} m, ${round(deltaDeg)} deg); the cross-placement check proves nothing`);
  if (!(cameraPath.maxPositionCm <= PATH_TOLERANCE_CM)) failures.push(`camera path differs across placements by ${cameraPath.maxPositionCm} cm`);
  if (!(cameraPath.maxRotationDeg <= PATH_TOLERANCE_DEG)) failures.push(`camera path differs across placements by ${cameraPath.maxRotationDeg} deg`);
  // The comparison runs over the paths' common time range, so a truncated path must also fail on its extent.
  if (!(durationDeltaSec <= STEP_SEC)) failures.push(`the takes' durations differ by ${durationDeltaSec} s (limit one step)`);
  if (!(cameraPath.endDeltaSec <= STEP_SEC) || !(cameraPath.startDeltaSec <= STEP_SEC)) failures.push(`the camera paths cover different time ranges (start ${cameraPath.startDeltaSec} s, end ${cameraPath.endDeltaSec} s apart)`);
  if (ta.camera!.translationKeys !== tb.camera!.translationKeys || ta.camera!.rotationKeys !== tb.camera!.rotationKeys) {
    failures.push(`camera key counts differ across placements (${ta.camera!.translationKeys}/${ta.camera!.rotationKeys} vs ${tb.camera!.translationKeys}/${tb.camera!.rotationKeys})`);
  }
  if (!(setNodes.maxCm <= PATH_TOLERANCE_CM)) failures.push(`set nodes differ across placements by ${setNodes.maxCm} cm`);
  if (setNodes.onlyInA.length > 0 || setNodes.onlyInB.length > 0) failures.push(`set nodes only in one take: ${[...setNodes.onlyInA, ...setNodes.onlyInB].join(', ')}`);
  if (ta.objects.length !== tb.objects.length) failures.push(`object counts differ across placements (${ta.objects.length} vs ${tb.objects.length})`);
  for (const object of objects) {
    if (!(object.positionCm <= PATH_TOLERANCE_CM)) failures.push(`object ${object.name} differs across placements by ${object.positionCm} cm`);
    if (!(object.rotationDeg <= PATH_TOLERANCE_DEG)) failures.push(`object ${object.name} differs across placements by ${object.rotationDeg} deg`);
  }
  return { comparison: { cameraPath, setNodes, objects, worldFrameDeltaM: round(deltaM), worldFrameDeltaDeg: round(deltaDeg), durationDeltaSec }, failures };
}

const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
const show = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });

type MicCount = { calls: number; streams: number; tracks: number; liveTracks: number };
const micCount = (page: Page): Promise<MicCount> =>
  page.evaluate(() => {
    const mics = (window as unknown as { __mics: { calls: number; streams: MediaStream[] } }).__mics;
    const tracks = mics.streams.flatMap((stream) => stream.getAudioTracks());
    return { calls: mics.calls, streams: mics.streams.length, tracks: tracks.length, liveTracks: tracks.filter((track) => track.readyState === 'live').length };
  });

/** Takes that end mid-take: mic-denied (Stop), session-end and page-hidden. */
async function interruptPhase(run: Run, phase: 'mic-denied' | 'session-end' | 'page-hidden'): Promise<PhaseReport> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, flag: true, scene: true, micDenied: phase === 'mic-denied', ...(phase === 'session-end' ? { mic: 'track' as const } : {}) });
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
    for (let i = 0; i < 12; i += 1) {
      const room = setToRoom(frame, walkPose(i));
      // Non-finite poses (tracking lost) in the middle of the take must be skipped, never written.
      const lost = phase === 'session-end' && i >= 4 && i <= 6;
      await setHeadPose(page, lost ? [NaN, NaN, NaN] : room.position, room.quaternion);
      await nextXrFrame(page);
      await advance(page, STEP_MS);
    }
    await noteMessages();
    const download = expectDownload(page, 30000);
    if (phase === 'session-end') {
      await page.evaluate(() => window.IWER_DEVICE!.activeSession!.end());
      // No frame arrives after the session ends: the held microphone must be released by the event itself.
      let ended = false;
      for (let i = 0; i < 40 && !ended; i += 1) {
        await page.waitForTimeout(100);
        const mics = await micCount(page);
        ended = mics.tracks > 0 && mics.liveTracks === 0 && !(await arOf(page)).micHeld;
        report.notes.micAfterEnd = mics;
      }
      if (!ended) report.failures.push('the held microphone was still live after the session ended, with no frame advancing');
    } else if (phase === 'page-hidden') {
      await hide(page);
    } else {
      await toggle(page);
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
    if (!saved.suggestedFilename().startsWith('camera-recording-')) report.failures.push(`filename ${saved.suggestedFilename()} is not a camera-recording-*`);
    const take = checkTake(report, await readFile(glb), { audio: phase === 'mic-denied' ? false : phase === 'session-end' || phase === 'page-hidden' ? true : 'any' });
    if (phase === 'mic-denied') {
      if (report.ar.recording.micPermission !== 'denied' && report.ar.after.micPermission !== 'denied') report.failures.push(`micPermission ${report.ar.after.micPermission}, expected denied`);
      if (!notices.has(SILENT_NOTICE)) report.failures.push(`notice ${JSON.stringify(SILENT_NOTICE)} never shown (saw ${JSON.stringify([...notices])})`);
    }
    if (phase === 'session-end') {
      const keys = [take.camera!.path.translation, take.camera!.path.rotation];
      report.notes.cameraKeys = keys.map((track) => track?.times.length ?? 0);
    }
    report.notes.khrAudio = take.khrAudio;
    await expectDownloadCount(page, report, 1);
    return report;
  } finally {
    await page.context().close();
  }
}

/**
 * Record waits on the microphone, then the start is cancelled (the page hides, hides and returns,
 * or the session ends) before it resolves: no take begins and nothing downloads.
 */
async function abortAtStartPhase(run: Run, phase: 'hidden-at-start' | 'restored-at-start' | 'ended-at-start'): Promise<PhaseReport> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, flag: true, scene: true, mic: 'gate' });
  try {
    // The AR entry holds the microphone; its request stays pending behind the gate, so Record's start waits on it.
    await enterAr(page);
    report.ar.entered = await arOf(page);
    if (!(await captureRecenter(page))) report.failures.push('the Recenter control is not drawn in phone AR');
    const frameValues = await worldFrame(page);
    const frame = toMatrix(frameValues);
    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    const states = new Set<string>();
    const watch = async () => states.add((await arOf(page)).recordingState);
    await toggle(page);
    await page.waitForTimeout(300);
    report.ar.pending = await arOf(page);
    states.add(report.ar.pending.recordingState);
    if (report.ar.pending.recordingState !== 'idle') report.failures.push(`recordingState ${report.ar.pending.recordingState} while the microphone was still pending, expected idle`);
    // Recenter while the start is pending is refused too.
    await pressRecenter(page);
    const recentered = await arOf(page);
    report.ar.recenterWhilePending = recentered;
    if (recentered.notice !== RECENTER_NOTICE) report.failures.push(`Recenter while a start was pending: notice ${JSON.stringify(recentered.notice)}, expected ${JSON.stringify(RECENTER_NOTICE)}`);
    for (let i = 0; i < 4; i += 1) {
      await advance(page, STEP_MS);
      await page.waitForTimeout(100);
    }
    if (!same(await worldFrame(page), frameValues)) report.failures.push('the set moved when Recenter was pressed while a start was pending');

    if (phase === 'hidden-at-start') {
      // The page hides, the microphone arrives while hidden, then the page shows again.
      await hide(page);
      await page.waitForTimeout(1500);
      await page.evaluate(() => (window as unknown as { __openMicGate: () => void }).__openMicGate());
      for (let i = 0; i < 10; i += 1) {
        await advance(page, STEP_MS);
        await page.waitForTimeout(150);
        await watch();
      }
      report.ar.hiddenAfterGrant = await arOf(page);
      await show(page);
    } else if (phase === 'restored-at-start') {
      // The page hides and shows again before the microphone arrives: the start is still cancelled.
      await hide(page);
      await page.waitForTimeout(500);
      await show(page);
      await page.waitForTimeout(500);
      await page.evaluate(() => (window as unknown as { __openMicGate: () => void }).__openMicGate());
    } else {
      await page.evaluate(() => window.IWER_DEVICE!.activeSession!.end());
      await page.waitForTimeout(500);
      await page.evaluate(() => (window as unknown as { __openMicGate: () => void }).__openMicGate());
    }
    for (let i = 0; i < 20; i += 1) {
      await advance(page, STEP_MS);
      await page.waitForTimeout(150);
      await watch();
    }
    report.ar.after = await arOf(page);
    report.notes.statesSeen = [...states];
    if (states.has('recording') || states.has('exporting')) report.failures.push(`recordingState passed through ${[...states].join(', ')}; no take should have begun`);
    if (report.ar.after.recordingState !== 'idle') report.failures.push(`recordingState ${report.ar.after.recordingState} at the end, expected idle`);
    if (report.ar.after.cameraSamples !== 0) report.failures.push(`${report.ar.after.cameraSamples} camera samples recorded for a take that never began`);
    const mics = await micCount(page);
    report.notes.mic = mics;
    // Two calls are expected: the page's startup permission check (its stream is released at once) and the entry hold, which Record's start shares.
    if (mics.calls > 2) report.failures.push(`${mics.calls} getUserMedia calls; the entry hold and Record should share one request`);
    if (phase === 'ended-at-start') {
      if (mics.liveTracks > 0) report.failures.push(`${mics.liveTracks} live microphone track(s) left after the session ended`);
      if (report.ar.after.micHeld) report.failures.push('micHeld is still true after the session ended');
    } else if (mics.liveTracks > 1) {
      report.failures.push(`${mics.liveTracks} live microphone tracks left; only the session's held one may remain`);
    }
    if (phase === 'restored-at-start') {
      // Positive control: with nothing busy, Recenter works (the refusals above are not a dead button).
      const room = setToRoom(frame, { position: [0.8, 1.5, 0.2], quaternion: quat(0, 0) });
      await setHeadPose(page, room.position, room.quaternion);
      await nextXrFrame(page);
      await pressRecenter(page);
      await settle(page, false);
      const moved = toMatrix(await worldFrame(page));
      const delta = new THREE.Vector3().setFromMatrixPosition(moved).distanceTo(new THREE.Vector3().setFromMatrixPosition(frame));
      report.notes.recenterWhenIdleMovedM = round(delta);
      if (delta < 0.3) report.failures.push(`Recenter did not move the set when nothing was busy (${round(delta)} m)`);
    }
    await expectDownloadCount(page, report, 0);
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
    await toggle(page);
    for (let i = 0; i < 12; i += 1) {
      await advance(page, STEP_MS);
      await page.waitForTimeout(250);
    }
    report.ar.after = await arOf(page);
    if (report.ar.after.recordingState !== 'idle') report.failures.push(`recordingState ${report.ar.after.recordingState} after a refused Record`);
    if (report.ar.after.notice !== EMPTY_NOTICE) report.failures.push(`notice ${JSON.stringify(report.ar.after.notice)}, expected ${JSON.stringify(EMPTY_NOTICE)}`);
    await expectDownloadCount(page, report, 0);
    return report;
  } finally {
    await page.context().close();
  }
}

/** A non-phone AR session with the flag on (Quest passthrough, or a device with no interactionMode): Record is refused. */
async function headsetPhase(run: Run, phase: 'quest-passthrough' | 'interaction-undefined'): Promise<PhaseReport> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: phase === 'interaction-undefined' ? 'interaction-unset' : false, flag: true, scene: true });
  try {
    await enterAr(page);
    const ar = await arOf(page);
    report.ar.entered = ar;
    if (ar.cameraAuthor) report.failures.push('camera author mode on');
    if (!ar.spectator) report.failures.push('not a spectator in AR');
    if (ar.performerHidden) report.failures.push('performer hidden in a spectator session');
    if (ar.micHeld) report.failures.push('microphone held open in a spectator session');
    const expectedMode = phase === 'quest-passthrough' ? 'world-space' : null;
    if (ar.interactionMode !== expectedMode) report.failures.push(`interactionMode ${ar.interactionMode}, expected ${expectedMode}`);
    for (const press of ['first', 'second'] as const) {
      await toggle(page);
      for (let i = 0; i < 8; i += 1) {
        await advance(page, STEP_MS);
        await page.waitForTimeout(150);
      }
      const after = await arOf(page);
      report.ar[`${press}Record`] = after;
      if (after.recordingState !== 'idle') report.failures.push(`${press} Record: recordingState ${after.recordingState}, expected idle`);
      if (press === 'first' && after.notice !== HEADSET_NOTICE) report.failures.push(`${press} Record: notice ${JSON.stringify(after.notice)}, expected ${JSON.stringify(HEADSET_NOTICE)}`);
      if (after.takeKind === 'camera' || after.cameraSamples > 0) report.failures.push(`${press} Record: a camera take began (kind ${after.takeKind}, ${after.cameraSamples} samples)`);
    }
    await expectDownloadCount(page, report, 0);
    return report;
  } finally {
    await page.context().close();
  }
}

/**
 * A phone with the flag off: AR is main's spectator. Record only (no Stop): stopping a spectator take
 * (no samples) is main's behaviour and logs a KeyframeTrack error unrelated to camera mode.
 */
async function flagOffPhase(run: Run): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'phone-flag-off', failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, flag: false, scene: true });
  try {
    await enterAr(page);
    const ar = await arOf(page);
    report.ar.entered = ar;
    if (ar.cameraAuthor) report.failures.push('camera author mode on');
    if (!ar.spectator) report.failures.push('not a spectator in AR');
    if (ar.performerHidden) report.failures.push('performer hidden in a spectator session');
    if (ar.micHeld) report.failures.push('microphone held open in a spectator session');
    if (ar.interactionMode !== 'screen-space') report.failures.push(`interactionMode ${ar.interactionMode}, expected screen-space`);
    await toggle(page);
    for (let i = 0; i < 20; i += 1) {
      await advance(page, STEP_MS);
      await page.waitForTimeout(150);
    }
    report.ar.afterRecord = await arOf(page);
    report.notes.afterToggleRecording = { recordingState: report.ar.afterRecord.recordingState, notice: report.ar.afterRecord.notice };
    if (report.ar.afterRecord.takeKind === 'camera') report.failures.push('take kind camera in a spectator session');
    await expectDownloadCount(page, report, 0);
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
const selected = (phase: Phase) => !only || only.some((part) => phase.includes(part));
let comparison: Comparison | undefined;
try {
  const walked: Partial<Record<'phone-a' | 'phone-b', Walked>> = {};
  const finish = (report: PhaseReport) => {
    reports.push(report);
    const s = report.scriptVsExport;
    console.log(`[ar-record] ${report.phase}: ${report.failures.length === 0 ? 'passed' : 'FAILED'}${s ? `; script error ${s.maxPositionCm} cm, ${s.maxRotationDeg} deg, ${s.stepsCovered}/${WALK_STEPS} steps` : ''}${report.take?.camera ? `; camera keys ${report.take.camera.translationKeys}` : ''}`);
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
    } else if (phase === 'hidden-at-start' || phase === 'restored-at-start' || phase === 'ended-at-start') {
      finish(await abortAtStartPhase(run, phase));
    } else if (phase === 'empty-set') {
      finish(await emptySetPhase(run));
    } else if (phase === 'quest-passthrough' || phase === 'interaction-undefined') {
      finish(await headsetPhase(run, phase));
    } else {
      finish(await flagOffPhase(run));
    }
  }
  if (walked['phone-a']?.take && walked['phone-b']?.take) {
    const compared = compareTakes(walked['phone-a'], walked['phone-b']);
    comparison = compared.comparison;
    walked['phone-b'].report.failures.push(...compared.failures);
    console.log(
      `[ar-record] placements differ by ${comparison.worldFrameDeltaM} m, ${comparison.worldFrameDeltaDeg} deg; camera path ${comparison.cameraPath.maxPositionCm} cm, ${comparison.cameraPath.maxRotationDeg} deg over ${comparison.cameraPath.samples} samples; set nodes ${comparison.setNodes.maxCm} cm; object ${comparison.objects.map((o) => `${o.positionCm} cm ${o.rotationDeg} deg`).join(', ')}`
    );
  }
  await writeFile(path.join(artifactDir, 'ar-record-report.json'), JSON.stringify({ reports, comparison, consoleErrors, seconds: round((Date.now() - startedAt) / 1000, 1) }, null, 2));
  const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.phase}: ${failure}`));
  if (consoleErrors.length > 0) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
  if (failures.length > 0) throw new Error(`AR recording check failed:\n- ${failures.join('\n- ')}`);
  console.log('AR recording check passed.');
} finally {
  await browser.close();
}
