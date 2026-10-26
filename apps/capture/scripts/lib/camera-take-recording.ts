import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Download, Page } from 'playwright';
import * as THREE from 'three';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';
import { emulatePhone, setHeadPose, type PhoneQuat as Quat, type PhoneVec3 as Vec3 } from '@holoim/tooling-testing/iwer-phone';

import type {} from '../../src/runtime/automationHooks';
import { assertCameraTake, inspectCameraTake, type CameraTakeReport } from './camera-take-glb.ts';

// One phone camera take, recorded in the running capture app (docs/features/
// ar-recording.md, slice 2a): phone AR in IWER (screen-space, mono, alpha
// blend) with the camera-author flag on, the pointing-targets set and the
// bracket placed on the desktop first. Enter AR, wait for the set to settle,
// Record, a scripted head walk (set frame, converted to the room with the live
// world frame), Stop, save the download. The same setup and walk as
// ci-ar-record-playwright.ts's phone-a phase, which keeps its own copy for now.
// Used by the viewer's camera-take pipeline spec, which uploads the take.
// `duringWalk` is where a later step adds touches (slice 4's hold): it runs
// after each step's head pose is set and one real XR frame has passed.
// The browser needs the fake microphone: launch it with FAKE_MIC_ARGS.

export const FAKE_MIC_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

const SCENE = '/fixtures/scenes/pointing-targets.gltf';
const OBJECT_URL = '/fixtures/objects/bracket.glb';
const VIEWPORT = { width: 640, height: 400 };
const STEP_MS = 100;
export const WALK_STEPS = 30;

export type CameraTakeRun = {
  browser: Browser;
  baseUrl: string;
  artifactDir: string;
  consoleErrors: string[];
  /** After each walk step's pose is set and one real XR frame has passed, before the simulation advances. */
  duringWalk?: (page: Page, step: number) => Promise<void>;
};
export type CameraTakeRecording = {
  glb: string;
  filename: string;
  bytes: number;
  take: CameraTakeReport;
  failures: string[];
  notes: Record<string, unknown>;
};

type Pose = { position: Vec3; quaternion: Quat };

const round = (value: number, places = 2) => Number(value.toFixed(places));

const quat = (yaw: number, pitch: number): Quat => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  return [q.x, q.y, q.z, q.w];
};

/** Translation along an arc with a slow bob, yaw and pitch sweeping; `i` in [0, WALK_STEPS). */
export function walkPose(i: number): Pose {
  const a = (i / (WALK_STEPS - 1)) * Math.PI * 0.8;
  return {
    position: [round(0.7 * Math.sin(a), 4), round(1.5 + 0.08 * Math.sin(2 * a), 4), round(0.9 - 0.5 * (1 - Math.cos(a)), 4)],
    quaternion: quat(0.6 * Math.sin(a), -0.2 * Math.sin(a))
  };
}

/** A set-frame pose in the room (what the IWER device is set to). */
function setToRoom(frame: THREE.Matrix4, pose: Pose): Pose {
  const world = new THREE.Vector3(...pose.position).applyMatrix4(frame);
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(frame)).multiply(new THREE.Quaternion(...pose.quaternion));
  return { position: [world.x, world.y, world.z], quaternion: [rotation.x, rotation.y, rotation.z, rotation.w] };
}

const arOf = (page: Page) => page.evaluate(() => JSON.parse(window.render_game_to_text()).ar as { placementSettled: boolean; cameraAuthor: boolean; performerHidden: boolean; recordingState: string; takeKind: string });
const advance = (page: Page, ms: number) => page.evaluate((value) => window.advanceTime(value), ms);

/** One real XR frame (emulated frames take about 150 ms); the simulation moves only on advanceTime. */
const nextXrFrame = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => window.IWER_DEVICE!.activeSession!.requestAnimationFrame(() => resolve())));

async function openPage(run: CameraTakeRun): Promise<Page> {
  const context = await createXrContext(run.browser, { viewport: VIEWPORT, acceptDownloads: true });
  await context.grantPermissions(['microphone']).catch(() => undefined);
  const page = await context.newPage();
  // tsx compiles with keepNames, which wraps named inner functions of the page.evaluate callbacks in a helper the page lacks.
  await page.addInitScript('globalThis.__name = globalThis.__name || ((target) => target);');
  wireXrConsoleErrors(page, run.consoleErrors);
  await emulatePhone(page);
  await attachXrEnvironment(page, { mode: 'iwer' });
  const url = new URL(run.baseUrl);
  url.searchParams.set('manualClock', '1');
  url.searchParams.set('arCamera', '1');
  url.searchParams.set('scene', SCENE);
  url.searchParams.set('sceneScale', '1');
  url.searchParams.set('object', OBJECT_URL);
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text', '__toggleRecording', '__arWorldFrame', '__setManualClock']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => window.__setManualClock(true));
  await waitForIwerRuntime(page);
  return page;
}

/** Steps the desktop simulation until the prepared object is placed in front of the avatar (a camera author cannot place one). */
async function placeObjectOnDesktop(page: Page): Promise<boolean> {
  for (let steps = 0; steps < 120; steps += 1) {
    const placed = await page.evaluate(() => (JSON.parse(window.render_game_to_text()).objects.items[0] as { placed: boolean } | undefined)?.placed ?? false);
    if (placed) return true;
    await advance(page, STEP_MS);
  }
  return false;
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

/** Records one camera take and saves it as `<artifactDir>/camera-take.glb`. Failures are listed, not thrown. */
export async function recordCameraTake(run: CameraTakeRun): Promise<CameraTakeRecording> {
  const failures: string[] = [];
  const notes: Record<string, unknown> = {};
  const page = await openPage(run);
  try {
    if (!(await placeObjectOnDesktop(page))) failures.push('the prepared object was not placed on the desktop before AR');
    await page.evaluate(() => {
      window.IWER_DEVICE!.controlMode = 'programmatic';
    });
    await setHeadPose(page, [0, 1.6, 0], quat(0, 0));
    await enterIwerSessionFromButton(page, '#ARButton', { readyCheck: "JSON.parse(window.render_game_to_text()).ar.sessionMode === 'ar'" });

    // The set is placed over the next frames; Record waits for it.
    for (let i = 0; i < 60; i += 1) {
      await nextXrFrame(page);
      await advance(page, STEP_MS);
      if ((await arOf(page)).placementSettled) break;
    }
    const entered = await arOf(page);
    if (!entered.placementSettled) throw new Error('placement never settled');
    if (!entered.cameraAuthor) failures.push('camera author mode is off in a phone AR session with the flag on');
    if (!entered.performerHidden) failures.push('performer visible in camera mode');

    const frame = new THREE.Matrix4().fromArray(await page.evaluate(() => window.__arWorldFrame()));
    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    await page.evaluate(() => window.__toggleRecording());
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).ar.recordingState === 'recording', null, { timeout: 20000 });
    await advance(page, STEP_MS);
    const recording = await arOf(page);
    if (recording.takeKind !== 'camera') failures.push(`take kind ${recording.takeKind}, expected camera`);

    for (let i = 0; i < WALK_STEPS; i += 1) {
      const room = setToRoom(frame, walkPose(i));
      await setHeadPose(page, room.position, room.quaternion);
      await nextXrFrame(page);
      await run.duringWalk?.(page, i);
      await advance(page, STEP_MS);
    }
    // Hold the last pose one more step so the final step has samples.
    await advance(page, STEP_MS);

    const download = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
    await page.evaluate(() => window.__toggleRecording());
    const saved = await advanceUntilDownload(page, download);
    if (!saved) throw new Error('no GLB downloaded after Stop');
    if (!saved.suggestedFilename().startsWith('camera-recording-')) failures.push(`filename ${saved.suggestedFilename()} is not a camera-recording-*`);
    await mkdir(run.artifactDir, { recursive: true });
    const glb = path.join(run.artifactDir, 'camera-take.glb');
    await copyFile(await saved.path(), glb);
    const bytes = await readFile(glb);
    const take = inspectCameraTake(bytes);
    failures.push(...assertCameraTake(take));
    if (!take.khrAudio || take.audio.sources < 1 || take.audio.payloadBytes <= 0) failures.push('KHR_audio does not carry audio although the microphone was granted');
    notes.cameraKeys = take.camera?.translationKeys;
    return { glb, filename: saved.suggestedFilename(), bytes: bytes.length, take, failures, notes };
  } finally {
    await page.context().close();
  }
}
